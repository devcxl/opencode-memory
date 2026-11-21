import * as fs from "node:fs";
import * as path from "node:path";
import type { ListResult, MonthGroup, SearchScope } from "../types.js";
import { readFileSafe } from "../utils/fs.js";
import { extractTimestamps } from "../utils/timestampParser.js";

export interface FileTimestampSummary {
  name: string;
  timestamps: string[];
}

export interface GroupedMemoryFiles {
  root: FileTimestampSummary[];
  monthly: MonthGroup[];
  project?: {
    projectId: string;
    root: FileTimestampSummary[];
    monthly: MonthGroup[];
  };
}

/** 负责按目录与时间维度列举和分组 Markdown 记忆文件 */
export class FileLister {
  private readonly projectsDir: string;

  constructor(
    private readonly memoryDir: string,
    private readonly dailyDir: string,
  ) {
    this.projectsDir = path.join(this.memoryDir, "projects");
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
    root: FileTimestampSummary[];
    daily: FileTimestampSummary[];
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
  private groupDailyByMonth(daily: FileTimestampSummary[]): MonthGroup[] {
    const monthlyMap = new Map<string, FileTimestampSummary[]>();
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

  /** 按月份分组列出文件，支持项目作用域（all / global / project） */
  async listFilesGroupedByMonth(
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<GroupedMemoryFiles> {
    const includeGlobal = scope !== "project" || !projectId;
    const includeProject = Boolean(projectId && scope !== "global");

    const globalData = includeGlobal
      ? this.getAllFiles(this.memoryDir, this.dailyDir)
      : { root: [], daily: [] };

    let projectData: GroupedMemoryFiles["project"];
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

  /** 按时间段筛选 daily 文件，支持项目作用域 */
  async listFilesByPeriod(
    period: string,
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<FileTimestampSummary[]> {
    if (period.length !== 4 && period.length !== 7) return [];

    const includeGlobal = scope !== "project" || !projectId;
    const includeProject = Boolean(projectId && scope !== "global");
    const results: FileTimestampSummary[] = [];

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
