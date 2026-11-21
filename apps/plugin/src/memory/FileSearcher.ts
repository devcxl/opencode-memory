import * as path from "node:path";
import * as fs from "node:fs";
import type {
  SearchResult,
  ListResult,
  SemanticSearchResult,
  MonthGroup,
  SearchScope,
} from "../types.js";
import { readFileSafe } from "../utils/fs.js";
import { embedText } from "../search/embedding.js";
import { chunkMarkdown } from "../search/chunker.js";
import {
  applyMmrDeduplication,
  computeTemporalDecayMultiplier,
  scoreBm25Documents,
} from "../search/bm25.js";
import {
  extractTimestamps,
  parseContentByTimestamp,
} from "../utils/timestampParser.js";
import type { SearchResult as VectorSearchResult } from "../search/vector-store.js";

const HYBRID_VECTOR_WEIGHT = 0.7;
const HYBRID_LEXICAL_WEIGHT = 0.3;
const HYBRID_MIN_SCORE = 0.15;
const HYBRID_MMR_LAMBDA = 0.7;

/** FileSearcher 所需的向量检索接口 */
export interface VectorSearchBackend {
  searchGlobal(
    queryVector: number[],
    topK: number,
  ): Promise<VectorSearchResult[]>;
  searchProject(
    projectId: string,
    queryVector: number[],
    topK: number,
  ): Promise<VectorSearchResult[]>;
}

interface CorpusChunkDoc {
  filePath: string;
  heading: string;
  text: string;
  timestamp?: string;
}

/** 封装对 memory 文件的搜索和列举逻辑，支持关键词搜索、混合语义搜索与作用域列表分组 */
export class FileSearcher {
  private readonly projectsDir: string;

  constructor(
    private memoryDir: string,
    private dailyDir: string,
    private vectorStore: VectorSearchBackend,
  ) {
    this.projectsDir = path.join(this.memoryDir, "projects");
  }

  /**
   * 关键词搜索：逐行扫描文件，返回匹配行及其位置
   */
  async searchFiles(
    query: string,
    maxResults: number,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const needle = query.toLowerCase();
    const searchPaths = [
      { dir: this.memoryDir, prefix: "" },
      { dir: this.dailyDir, prefix: "daily" },
    ];

    for (const { dir, prefix } of searchPaths) {
      if (results.length >= maxResults) break;
      try {
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md") && f !== "BOOTSTRAP.md");
        for (const file of files) {
          if (results.length >= maxResults) break;
          const filePath = path.join(dir, file);
          const content = readFileSafe(filePath);
          if (!content) continue;
          const lines = content.split("\n");
          for (
            let i = 0;
            i < lines.length && results.length < maxResults;
            i++
          ) {
            if (lines[i].toLowerCase().includes(needle)) {
              results.push({
                file: prefix ? `${prefix}/${file}` : file,
                line: i + 1,
                text: lines[i].trimEnd(),
              });
            }
          }
        }
      } catch {
        continue;
      }
    }
    return results;
  }

  /**
   * 混合语义搜索：
   * 1. 向量检索（0.70）+ BM25 词法检索（0.30）融合
   * 2. period 过滤（daily 文件先按文件名日期预过滤，避免无关文件磁盘读取）
   * 3. minScore（0.15）在时间衰减前判定
   * 4. 分层时间衰减（evergreen 常驻文件不衰减，daily 30 天半衰期）
   * 5. 轻量 MMR（lambda=0.7）多样性去重
   */
  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<SemanticSearchResult[]> {
    const queryVector = await embedText(query);
    const searchLimit = period
      ? Number.POSITIVE_INFINITY
      : Math.max(maxResults * 4, 20);
    const includeGlobal = scope !== "project" || !projectId;
    const includeProject = Boolean(projectId && scope !== "global");

    const vectorCandidates: VectorSearchResult[] = includeGlobal
      ? [...(await this.vectorStore.searchGlobal(queryVector, searchLimit))]
      : [];

    if (includeProject && projectId) {
      try {
        const projectResults = await this.vectorStore.searchProject(
          projectId,
          queryVector,
          searchLimit,
        );
        vectorCandidates.push(...projectResults);
      } catch {}
    }

    // 收集 scope 内词法语料并执行 BM25 打分
    const corpusDocs = this.collectCorpusDocs(
      includeGlobal,
      includeProject ? (projectId ?? null) : null,
      period,
    );
    const bm25Results = scoreBm25Documents(query, corpusDocs);

    // 按规范化 filePath + 文本合并双路候选
    const mergedMap = new Map<
      string,
      {
        filePath: string;
        heading: string;
        text: string;
        timestamp?: string;
        vectorScore: number;
        lexicalScore: number;
      }
    >();

    const makeKey = (filePath: string, text: string) =>
      `${path.resolve(filePath)}::${text.trim()}`;

    for (const vec of vectorCandidates) {
      let timestamp = vec.timestamp;
      if (!timestamp) {
        const fileContent = readFileSafe(vec.filePath);
        if (fileContent) {
          timestamp = this.findTimestampForResult(fileContent, vec.text);
        }
      }

      if (period && (!timestamp || !timestamp.startsWith(period))) {
        continue;
      }

      const key = makeKey(vec.filePath, vec.text);
      const existing = mergedMap.get(key);
      if (!existing || vec.score > existing.vectorScore) {
        mergedMap.set(key, {
          filePath: vec.filePath,
          heading: vec.heading,
          text: vec.text,
          timestamp,
          vectorScore: Math.max(0, vec.score),
          lexicalScore: existing?.lexicalScore ?? 0,
        });
      }
    }

    for (const lex of bm25Results) {
      const { doc } = lex;
      if (period && (!doc.timestamp || !doc.timestamp.startsWith(period))) {
        continue;
      }

      const key = makeKey(doc.filePath, doc.text);
      const existing = mergedMap.get(key);
      if (existing) {
        if (lex.score > existing.lexicalScore) {
          existing.lexicalScore = lex.score;
        }
      } else {
        mergedMap.set(key, {
          filePath: doc.filePath,
          heading: doc.heading,
          text: doc.text,
          timestamp: doc.timestamp,
          vectorScore: 0,
          lexicalScore: lex.score,
        });
      }
    }

    // 在时间衰减前执行 minScore 阈值过滤，再叠加分层时间衰减
    const nowMs = Date.now();
    const scoredCandidates: SemanticSearchResult[] = [];
    for (const item of mergedMap.values()) {
      const baseScore =
        HYBRID_VECTOR_WEIGHT * item.vectorScore +
        HYBRID_LEXICAL_WEIGHT * item.lexicalScore;
      if (baseScore < HYBRID_MIN_SCORE) {
        continue;
      }

      const decay = computeTemporalDecayMultiplier(
        item.filePath,
        item.timestamp,
        nowMs,
      );
      scoredCandidates.push({
        score: baseScore * decay,
        filePath: item.filePath,
        heading: item.heading,
        text: item.text,
        timestamp: item.timestamp,
      });
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    return applyMmrDeduplication(
      scoredCandidates,
      maxResults,
      HYBRID_MMR_LAMBDA,
    );
  }

  private collectCorpusDocs(
    includeGlobal: boolean,
    projectId: string | null,
    period?: string,
  ): CorpusChunkDoc[] {
    const files: string[] = [];

    const collectDir = (rootDir: string, dailySubDir: string) => {
      try {
        for (const f of fs.readdirSync(rootDir)) {
          if (f.endsWith(".md") && f !== "BOOTSTRAP.md") {
            files.push(path.join(rootDir, f));
          }
        }
      } catch {}

      try {
        for (const f of fs.readdirSync(dailySubDir)) {
          if (!f.endsWith(".md")) continue;
          // period 过滤时先按 daily 文件名 YYYY-MM-DD 预剪枝，避免全量读盘
          if (period) {
            const datePart = f.replace(/\.md$/, "");
            if (!datePart.startsWith(period)) continue;
          }
          files.push(path.join(dailySubDir, f));
        }
      } catch {}
    };

    if (includeGlobal) {
      collectDir(this.memoryDir, this.dailyDir);
    }

    if (projectId) {
      const projectDir = path.join(this.projectsDir, ...projectId.split("/"));
      collectDir(projectDir, path.join(projectDir, "daily"));
    }

    const docs: CorpusChunkDoc[] = [];
    for (const filePath of files) {
      const content = readFileSafe(filePath);
      if (!content?.trim()) continue;
      for (const chunk of chunkMarkdown(content, filePath)) {
        docs.push({
          filePath: chunk.filePath,
          heading: chunk.heading,
          text: chunk.text,
          timestamp: chunk.timestamp,
        });
      }
    }

    return docs;
  }

  private findTimestampForResult(
    fileContent: string,
    resultText: string,
  ): string | undefined {
    const entries = parseContentByTimestamp(fileContent);
    const matchedEntry = entries.find((entry) =>
      entry.content.includes(resultText),
    );
    if (matchedEntry) return matchedEntry.timestamp;

    const timestamps = extractTimestamps(fileContent);
    return timestamps.length === 1 ? timestamps[0] : undefined;
  }

  /** 读取文件并提取时间戳列表 */
  private getTimestamps(dir: string, file: string): string[] {
    const content = readFileSafe(path.join(dir, file));
    return content ? extractTimestamps(content) : [];
  }

  /** 列出指定根目录和 daily 目录下的所有 md 文件，daily 按倒序排列 */
  listFiles(
    rootDir: string = this.memoryDir,
    dailySubDir: string = this.dailyDir,
  ): ListResult {
    const root: string[] = [];
    const daily: string[] = [];

    try {
      const rootFiles = fs
        .readdirSync(rootDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const f of rootFiles) {
        if (f !== "BOOTSTRAP.md") root.push(f);
      }
    } catch {}

    try {
      const dailyFiles = fs
        .readdirSync(dailySubDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      daily.push(...dailyFiles);
    } catch {}

    return { root, daily };
  }

  /** 获取指定目录所有文件及时间戳 */
  private getAllFiles(
    rootDir: string = this.memoryDir,
    dailySubDir: string = this.dailyDir,
    prefix: string = "",
  ): {
    root: Array<{ name: string; timestamps: string[] }>;
    daily: Array<{ name: string; timestamps: string[] }>;
  } {
    const { root, daily } = this.listFiles(rootDir, dailySubDir);
    const rootFiles = root.map((file) => ({
      name: prefix ? `${prefix}/${file}` : file,
      timestamps: this.getTimestamps(rootDir, file),
    }));
    const dailyFiles = daily.map((file) => ({
      name: prefix ? `${prefix}/daily/${file}` : `daily/${file}`,
      timestamps: this.getTimestamps(dailySubDir, file),
    }));
    return { root: rootFiles, daily: dailyFiles };
  }

  /** 按月份聚合 daily 文件，按月份倒序 */
  private groupDailyByMonth(
    daily: Array<{ name: string; timestamps: string[] }>,
  ): MonthGroup[] {
    const monthlyMap = new Map<
      string,
      Array<{ name: string; timestamps: string[] }>
    >();
    for (const file of daily) {
      const base = path.basename(file.name);
      const dateStr = base.replace(/\.md$/, "");
      const month = dateStr.slice(0, 7);
      if (!monthlyMap.has(month)) monthlyMap.set(month, []);
      monthlyMap.get(month)!.push(file);
    }

    const monthly: MonthGroup[] = [];
    for (const [month, files] of monthlyMap.entries()) {
      const entryCount = files.reduce((sum, f) => sum + f.timestamps.length, 0);
      monthly.push({
        month,
        fileCount: files.length,
        entryCount,
        files,
      });
    }
    monthly.sort((a, b) => b.month.localeCompare(a.month));
    return monthly;
  }

  /**
   * 按月份分组列出文件，支持项目作用域（all / global / project）。
   */
  async listFilesGroupedByMonth(
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<{
    root: Array<{ name: string; timestamps: string[] }>;
    monthly: MonthGroup[];
    project?: {
      projectId: string;
      root: Array<{ name: string; timestamps: string[] }>;
      monthly: MonthGroup[];
    };
  }> {
    const includeGlobal = scope !== "project" || !projectId;
    const includeProject = Boolean(projectId && scope !== "global");

    const globalData = includeGlobal
      ? this.getAllFiles(this.memoryDir, this.dailyDir)
      : { root: [], daily: [] };

    let projectData:
      | {
          projectId: string;
          root: Array<{ name: string; timestamps: string[] }>;
          monthly: MonthGroup[];
        }
      | undefined;

    if (includeProject && projectId) {
      const projDir = path.join(this.projectsDir, ...projectId.split("/"));
      const projAll = this.getAllFiles(
        projDir,
        path.join(projDir, "daily"),
        `projects/${projectId}`,
      );
      projectData = {
        projectId,
        root: projAll.root,
        monthly: this.groupDailyByMonth(projAll.daily),
      };
    }

    return {
      root: globalData.root,
      monthly: this.groupDailyByMonth(globalData.daily),
      ...(projectData ? { project: projectData } : {}),
    };
  }

  /**
   * 按时间段筛选 daily 文件，支持项目作用域。
   * period 为 "YYYY-MM" 或 "YYYY" 格式，匹配文件名前缀。
   */
  async listFilesByPeriod(
    period: string,
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<Array<{ name: string; timestamps: string[] }>> {
    if (period.length !== 4 && period.length !== 7) return [];

    const includeGlobal = scope !== "project" || !projectId;
    const includeProject = Boolean(projectId && scope !== "global");
    const results: Array<{ name: string; timestamps: string[] }> = [];

    if (includeProject && projectId) {
      const projDir = path.join(this.projectsDir, ...projectId.split("/"));
      const { daily } = this.getAllFiles(
        projDir,
        path.join(projDir, "daily"),
        `projects/${projectId}`,
      );
      results.push(
        ...daily.filter((f) =>
          path.basename(f.name).replace(/\.md$/, "").startsWith(period),
        ),
      );
    }

    if (includeGlobal) {
      const { daily } = this.getAllFiles(this.memoryDir, this.dailyDir);
      results.push(
        ...daily.filter((f) =>
          path.basename(f.name).replace(/\.md$/, "").startsWith(period),
        ),
      );
    }

    return results;
  }
}
