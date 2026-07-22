import * as path from "node:path";
import * as fs from "node:fs";
import type {
  SearchResult,
  ListResult,
  SemanticSearchResult,
  MonthGroup,
  SearchScope,
} from "../types.js";
import type { MemoryMode } from "../providers/factory.js";
import type { IFileStorageProvider } from "../providers/types.js";
import { embedText } from "../search/embedding.js";
import {
  extractTimestamps,
  parseContentByTimestamp,
} from "../utils/timestampParser.js";
import type { ProjectStore } from "../search/vector-store.js";

/** 封装对 memory 文件的搜索和列举逻辑，支持关键词搜索、语义搜索、列表分组 */
export class FileSearcher {
  constructor(
    private memoryDir: string,
    private dailyDir: string,
    private fileStorage: IFileStorageProvider,
    private getProjectStore: (projectId: string) => ProjectStore,
    private mode: MemoryMode = "local",
  ) {}

  /**
   * 关键词搜索：逐行扫描文件，返回匹配行及其位置
   * 在内存中全量扫描而非依赖索引，适合文件量较少的场景
   * remote 模式：通过 fileStorage.readFile 读取文件内容
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
          const content = await this.fileStorage.readFile(filePath);
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
   * 语义搜索：基于向量相似度匹配，支持按时段和项目筛选。
   *
   * 搜索策略：
   * 1. remote 模式：直接通过 fileStorage.search() 调用 Worker API
   * 2. local 模式：本地 embed + 向量搜索
   * 3. scope=project 但无 projectId 时降级为全局搜索
   * 4. 为每个结果附加时间戳（用于 period 过滤和展示）
   * 5. period 过滤为宽松前缀匹配（"YYYY-MM" 或 "YYYY"），在向量检索后执行
   */
  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<SemanticSearchResult[]> {
    // remote 模式：直接调 Worker API 搜索
    if (this.mode === "remote") {
      const { RemoteFileStorageProvider } =
        await import("../providers/remote/FileStorageProvider.js");
      if (this.fileStorage instanceof RemoteFileStorageProvider) {
        const includeGlobal = scope !== "project" || !projectId;
        const globalResults = includeGlobal
          ? await this.fileStorage.search(query, maxResults)
          : [];
        const projectResults =
          projectId && scope !== "global"
            ? await this.fileStorage.search(
                query,
                maxResults,
                undefined,
                projectId,
              )
            : [];

        const allResults = [...globalResults, ...projectResults];
        allResults.sort((a, b) => b.score - a.score);

        const filtered = period
          ? allResults.filter((r) => {
              const ts = new Date(r.created_at).toISOString().slice(0, 10);
              return ts.startsWith(period);
            })
          : allResults;

        return filtered.slice(0, maxResults).map((r) => ({
          score: r.score,
          filePath: r.id,
          heading: "",
          text: r.text,
          timestamp: new Date(r.created_at).toISOString().slice(0, 10),
        }));
      }
    }

    // local 模式：本地 embedding + 向量搜索
    const queryVector = await embedText(query);
    const module = await import("../search/vector-store.js");
    // period 过滤时先取全部结果（或超大上限），在内存中过滤
    const searchLimit = period ? Number.POSITIVE_INFINITY : maxResults;
    const includeGlobal = scope !== "project" || !projectId;
    const results = includeGlobal
      ? await module.semanticSearch(queryVector, searchLimit)
      : [];

    // 项目搜索：project scope 只查项目；all scope 与全局合并。
    if (projectId && scope !== "global") {
      const store = this.getProjectStore(projectId);
      try {
        const projectResults = await store.search(queryVector, searchLimit);
        results.push(...projectResults);
        results.sort((a, b) => b.score - a.score);
      } catch {}
    }

    const resultsWithTimestamp: SemanticSearchResult[] = [];
    for (const result of results) {
      const fileContent = await this.fileStorage.readFile(result.filePath);
      let timestamp = result.timestamp;

      // 若索引中无时间戳，尝试从文件内容中推断
      if (fileContent) {
        timestamp ??= this.findTimestampForResult(fileContent, result.text);
      }

      // period 过滤：仅保留 timestamp 前缀匹配的结果
      if (period) {
        if (!timestamp || !timestamp.startsWith(period)) {
          continue;
        }
      }

      resultsWithTimestamp.push({
        ...result,
        timestamp,
      });

      if (resultsWithTimestamp.length >= maxResults) {
        break;
      }
    }

    return resultsWithTimestamp;
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
  private async getTimestamps(dir: string, file: string): Promise<string[]> {
    const content = await this.fileStorage.readFile(path.join(dir, file));
    return content ? extractTimestamps(content) : [];
  }

  /** 列出根目录和 daily 目录下的所有 md 文件，daily 按倒序排列 */
  listFiles(): ListResult {
    const root: string[] = [];
    const daily: string[] = [];

    try {
      const rootFiles = fs
        .readdirSync(this.memoryDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const f of rootFiles) {
        if (f !== "BOOTSTRAP.md") root.push(f);
      }
    } catch {}

    try {
      const dailyFiles = fs
        .readdirSync(this.dailyDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      daily.push(...dailyFiles);
    } catch {}

    return { root, daily };
  }

  /**
   * 列出文件及其关联的时间戳列表
   * daily 文件数超过 limit 时汇总为 "+N more" 条目
   */
  async listFilesWithTimestamps(
    limit: number = 7,
  ): Promise<Array<{ name: string; timestamps: string[] }>> {
    const result: Array<{ name: string; timestamps: string[] }> = [];
    const { root, daily } = this.listFiles();

    for (const file of root) {
      const timestamps = await this.getTimestamps(this.memoryDir, file);
      result.push({ name: file, timestamps });
    }

    const recentDaily = daily.slice(0, limit);
    const moreCount = daily.length - limit;

    for (const file of recentDaily) {
      const timestamps = await this.getTimestamps(this.dailyDir, file);
      result.push({ name: `daily/${file}`, timestamps });
    }

    if (moreCount > 0) {
      result.push({
        name: `... and ${moreCount} more daily logs`,
        timestamps: [],
      });
    }

    return result;
  }

  /**
   * 按月份分组列出文件，返回根文件列表和按月聚合的 daily 分组
   * 每月包含文件数、条目数等统计，按月份倒序排列
   */
  async listFilesGroupedByMonth(): Promise<{
    root: Array<{ name: string; timestamps: string[] }>;
    monthly: MonthGroup[];
  }> {
    const { root, daily } = this.listFiles();

    const rootFiles: Array<{ name: string; timestamps: string[] }> = [];
    for (const file of root) {
      const timestamps = await this.getTimestamps(this.memoryDir, file);
      rootFiles.push({ name: file, timestamps });
    }

    const monthlyMap = new Map<
      string,
      Array<{ name: string; timestamps: string[] }>
    >();

    for (const file of daily) {
      const dateStr = file.replace(".md", "");
      const month = dateStr.slice(0, 7);
      const timestamps = await this.getTimestamps(this.dailyDir, file);

      if (!monthlyMap.has(month)) {
        monthlyMap.set(month, []);
      }
      monthlyMap.get(month)!.push({ name: `daily/${file}`, timestamps });
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

    return { root: rootFiles, monthly };
  }

  /**
   * 按时间段筛选 daily 文件
   * period 为 "YYYY-MM" 或 "YYYY" 格式，匹配文件名前缀
   */
  async listFilesByPeriod(
    period: string,
  ): Promise<Array<{ name: string; timestamps: string[] }>> {
    const { daily } = this.listFiles();
    const result: Array<{ name: string; timestamps: string[] }> = [];

    const filteredDaily = daily.filter((file) => {
      const dateStr = file.replace(".md", "");
      if (period.length === 7) {
        return dateStr.startsWith(period);
      }
      if (period.length === 4) {
        return dateStr.startsWith(period);
      }
      return false;
    });

    for (const file of filteredDaily) {
      const timestamps = await this.getTimestamps(this.dailyDir, file);
      result.push({ name: `daily/${file}`, timestamps });
    }

    return result;
  }
}
