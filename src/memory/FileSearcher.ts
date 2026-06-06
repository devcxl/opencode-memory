import * as path from "node:path";
import * as fs from "node:fs";
import type {
  SearchResult,
  ListResult,
  SemanticSearchResult,
  MonthGroup,
} from "../types.js";
import { embedText } from "../search/embedding.js";
import { extractTimestamps } from "../utils/timestampParser.js";
import type { ProjectStore } from "../search/vector-store.js";

/** 封装对 memory 文件的搜索和列举逻辑，支持关键词搜索、语义搜索、列表分组 */
export class FileSearcher {
  constructor(
    private memoryDir: string,
    private dailyDir: string,
    private readFile: (filePath: string) => string | null,
    private getProjectStore: (projectId: string) => ProjectStore,
  ) {}

  /**
   * 关键词搜索：逐行扫描文件，返回匹配行及其位置
   * 在内存中全量扫描而非依赖索引，适合文件量较少的场景
   */
  searchFiles(query: string, maxResults: number): SearchResult[] {
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
          const content = this.readFile(filePath);
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
   * 语义搜索：基于向量相似度匹配，支持按时段和项目筛选
   * 对结果附加时间戳用于后续的 period 过滤
   */
  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
  ): Promise<SemanticSearchResult[]> {
    const queryVector = await embedText(query);
    const module = await import("../search/vector-store.js");
    const results = await module.semanticSearch(queryVector, maxResults);

    if (projectId) {
      const store = this.getProjectStore(projectId);
      try {
        const projectResults = await store.search(queryVector, maxResults);
        results.push(...projectResults);
        results.sort((a, b) => b.score - a.score);
      } catch {}
    }

    const resultsWithTimestamp: SemanticSearchResult[] = [];
    for (const result of results.slice(0, maxResults)) {
      const fileContent = this.readFile(result.filePath);
      let timestamp: string | undefined;

      if (fileContent) {
        const timestamps = extractTimestamps(fileContent);
        if (timestamps.length > 0) {
          timestamp = timestamps[0];
        }
      }

      if (period) {
        if (timestamp && !timestamp.startsWith(period.replace("-", "-"))) {
          continue;
        }
      }

      resultsWithTimestamp.push({
        ...result,
        timestamp,
      });
    }

    return resultsWithTimestamp;
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
  listFilesWithTimestamps(
    limit: number = 7,
  ): Array<{ name: string; timestamps: string[] }> {
    const result: Array<{ name: string; timestamps: string[] }> = [];
    const { root, daily } = this.listFiles();

    for (const file of root) {
      const filePath = path.join(this.memoryDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      result.push({ name: file, timestamps });
    }

    const recentDaily = daily.slice(0, limit);
    const moreCount = daily.length - limit;

    for (const file of recentDaily) {
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
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
  listFilesGroupedByMonth(): {
    root: Array<{ name: string; timestamps: string[] }>;
    monthly: MonthGroup[];
  } {
    const { root, daily } = this.listFiles();

    const rootFiles: Array<{ name: string; timestamps: string[] }> = [];
    for (const file of root) {
      const filePath = path.join(this.memoryDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      rootFiles.push({ name: file, timestamps });
    }

    const monthlyMap = new Map<
      string,
      Array<{ name: string; timestamps: string[] }>
    >();

    for (const file of daily) {
      const dateStr = file.replace(".md", "");
      const month = dateStr.slice(0, 7);
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];

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
  listFilesByPeriod(
    period: string,
  ): Array<{ name: string; timestamps: string[] }> {
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
      const filePath = path.join(this.dailyDir, file);
      const content = this.readFile(filePath);
      const timestamps = content ? extractTimestamps(content) : [];
      result.push({ name: `daily/${file}`, timestamps });
    }

    return result;
  }
}
