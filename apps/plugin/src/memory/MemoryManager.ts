import * as path from "node:path";
import * as fs from "node:fs";
import type {
  ContextFile,
  SemanticSearchResult,
  MonthGroup,
} from "../types.js";
import type { MemoryConfig } from "../config/runtime.js";
import { ensureDir, readFileSafe } from "../utils/fs.js";
import { atomicWrite } from "../utils/atomicWrite.js";
import { MemoryPaths } from "./MemoryPaths.js";
import {
  checkLineLimit,
  normalizeDailyDate,
  validateProjectId,
} from "../utils/validation.js";
import { gitCommit } from "../utils/git.js";
import {
  embedText,
  getCurrentDtype,
  getCurrentModelId,
} from "../search/embedding.js";
import { chunkMarkdown } from "../search/chunker.js";
import { VectorStore } from "../search/vector-store.js";
import { parseContentByTimestamp } from "../utils/timestampParser.js";
import { FileSearcher } from "./FileSearcher.js";

/** 内存系统的核心管理器，统一管理文件读写、向量索引、语义搜索与 git 提交 */
export class MemoryManager {
  private config: MemoryConfig;
  private paths: MemoryPaths;
  private vectorStore: VectorStore;
  private fileSearcher: FileSearcher;
  private freshIndexDone = false;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.paths = new MemoryPaths(config.memoryDir);
    this.vectorStore = new VectorStore(config.memoryDir);
    this.fileSearcher = new FileSearcher(
      config.memoryDir,
      this.paths.dailyDir,
      this.vectorStore,
    );
  }

  /** 确保 memory 和 daily 目录存在，并在首次调用时重建因模型切换而失效的索引 */
  async ensureDirectories(): Promise<void> {
    ensureDir(this.config.memoryDir);
    ensureDir(this.paths.dailyDir);
    if (!this.freshIndexDone) {
      this.freshIndexDone = true;
      await this.ensureFreshIndex();
    }
  }

  private async ensureFreshIndex(): Promise<void> {
    const stalePaths = await this.vectorStore.refreshStaleIndices();
    if (stalePaths.length === 0) return;

    for (const filePath of stalePaths) {
      const content = readFileSafe(filePath);
      if (!content) continue;
      try {
        await this.embedAndIndex(filePath, content);
      } catch {
        // 单个文件重建失败不影响其他文件
      }
    }
  }

  /** 获取全局 MEMORY.md 路径 */
  getMemoryPath(): string {
    return this.paths.memoryPath;
  }

  /** 获取 IDENTITY.md 路径 */
  getIdentityPath(): string {
    return this.paths.identityPath;
  }

  /** 获取 USER.md 路径 */
  getUserPath(): string {
    return this.paths.userPath;
  }

  /** 获取 BOOTSTRAP.md 路径 */
  getBootstrapPath(): string {
    return this.paths.bootstrapPath;
  }

  /**
   * 获取指定日期的 daily 日志路径
   * @param date 日期字符串，格式 YYYY-MM-DD
   */
  getDailyPath(date: string): string {
    return this.paths.dailyPath(date);
  }

  /** 获取项目目录路径 */
  getProjectDir(projectId: string): string {
    validateProjectId(projectId);
    return this.paths.projectDir(projectId);
  }

  /** 获取项目级 MEMORY.md 路径 */
  getProjectMemoryPath(projectId: string): string {
    validateProjectId(projectId);
    return this.paths.projectMemoryPath(projectId);
  }

  /** 确保项目目录存在，不存在则递归创建 */
  ensureProjectDirs(projectId: string): void {
    const projectDir = this.getProjectDir(projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
  }

  /**
   * 根据 target 类型解析文件路径和展示名，统一路径查找入口
   */
  getPathForTarget(
    target: string,
    date?: string,
    project?: string | null,
  ): {
    filePath: string;
    displayName: string;
  } {
    switch (target) {
      case "memory": {
        if (project) {
          return {
            filePath: this.getProjectMemoryPath(project),
            displayName: `projects/${project}/MEMORY.md`,
          };
        }
        return {
          filePath: this.getMemoryPath(),
          displayName: "MEMORY.md",
        };
      }
      case "identity":
        return {
          filePath: this.getIdentityPath(),
          displayName: "IDENTITY.md",
        };
      case "user":
        return {
          filePath: this.getUserPath(),
          displayName: "USER.md",
        };
      case "daily": {
        const targetDate = normalizeDailyDate(date) ?? this.todayStr();
        if (project) {
          return {
            filePath: this.paths.projectDailyPath(project, targetDate),
            displayName: `projects/${project}/daily/${targetDate}.md`,
          };
        }
        return {
          filePath: this.getDailyPath(targetDate),
          displayName: `daily/${targetDate}.md`,
        };
      }
      default:
        throw new Error(`Unknown target: ${target}`);
    }
  }

  /** 返回今天的日期字符串 YYYY-MM-DD */
  todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** 读取文件内容，文件不存在或读取失败时返回 null */
  async readFile(filePath: string): Promise<string | null> {
    return readFileSafe(filePath);
  }

  /** 写入文件并触发向量索引与 git 提交 */
  async writeFile(filePath: string, content: string): Promise<void> {
    checkLineLimit(filePath, content);
    await this.persistAndIndex(
      filePath,
      content,
      `Update ${path.basename(filePath)}`,
    );
  }

  /**
   * 精确替换文件中的字符串段，用于细粒度编辑而非全量覆盖
   * 要求 oldString 在文件中恰好出现一次，避免歧义覆盖
   */
  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
  ): Promise<void> {
    const content = readFileSafe(filePath);
    if (!content) {
      throw new Error("File not found or empty");
    }

    if (!content.includes(oldString)) {
      throw new Error("oldString not found in file");
    }

    const matches = content.split(oldString).length - 1;
    if (matches > 1) {
      throw new Error(
        `Found ${matches} occurrences of oldString, expected exactly 1`,
      );
    }

    const updatedContent = content.replace(oldString, newString);
    await this.persistAndIndex(
      filePath,
      updatedContent,
      `Edit ${path.basename(filePath)}`,
    );
  }

  /**
   * 按时间戳删除文件中的条目
   * 解析文件中的 `<!-- timestamp -->` 标记，删除匹配的条目后重写文件
   */
  async deleteByTimestamp(
    target: string,
    timestamp: string,
    date?: string,
    project?: string | null,
  ): Promise<string> {
    const { filePath, displayName } = this.getPathForTarget(
      target,
      date,
      project,
    );

    const content = readFileSafe(filePath);
    if (!content) {
      throw new Error(`${displayName} not found or empty`);
    }

    const entries = parseContentByTimestamp(content);
    const filteredEntries = entries.filter(
      (entry) => entry.timestamp !== timestamp,
    );

    if (filteredEntries.length === entries.length) {
      throw new Error(`No entries found matching timestamp: ${timestamp}`);
    }

    const newContent = filteredEntries
      .map((e) => `<!-- ${e.timestamp} -->\n${e.content}`)
      .join("\n\n");

    await this.persistAndIndex(
      filePath,
      newContent,
      `Delete entries from ${path.basename(filePath)}`,
    );

    return `Deleted ${entries.length - filteredEntries.length} entries from ${displayName}`;
  }

  /** 以追加方式写入文件，自动添加时间戳标记 */
  async appendFile(filePath: string, content: string): Promise<void> {
    const timestamp = this.getLocalTimestamp();
    const stamped = `<!-- ${timestamp} -->\n${content}`;
    const existing = readFileSafe(filePath);
    const separator = existing?.trim() ? "\n\n" : "";
    const newContent = (existing ?? "") + separator + stamped;

    checkLineLimit(filePath, newContent);
    await this.persistAndIndex(
      filePath,
      newContent,
      `Append to ${path.basename(filePath)}`,
    );
  }

  /** 获取本地时间戳字符串 YYYY-MM-DD HH:MM:SS */
  getLocalTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /** 将文件内容分块、向量化并写入向量存储 */
  private async embedAndIndex(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const chunks = chunkMarkdown(content, filePath);
      const embeddingModel = getCurrentModelId();
      const embeddingDtype = getCurrentDtype();

      const vectors = await Promise.all(chunks.map((c) => embedText(c.text)));
      const embedded = chunks.map((chunk, idx) => ({
        vector: vectors[idx],
        metadata: {
          filePath,
          heading: chunk.heading,
          text: chunk.text,
          hash: chunk.hash,
          embeddingModel,
          embeddingDtype,
          ...(chunk.timestamp ? { timestamp: chunk.timestamp } : {}),
        },
      }));

      await this.vectorStore.upsertFile(filePath, embedded);
    } catch (err) {
      const errMsg = (err as Error).message;
      // embedding 引擎未初始化时静默跳过，不阻塞写入操作
      if (!errMsg.includes("not initialized")) {
        throw err;
      }
    }
  }

  /** 写入文件、更新向量索引、提交 git 三合一操作 */
  private async persistAndIndex(
    filePath: string,
    content: string,
    operation: string,
  ): Promise<void> {
    atomicWrite(filePath, content);

    await this.embedAndIndex(filePath, content);

    // 向量索引为可重建的派生数据，仅追踪 Markdown 源文件
    await gitCommit(operation, filePath, this.config.memoryDir);
  }

  /** 删除文件，忽略文件不存在的错误 */
  deleteFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /** 收集所有有内容的 context 文件，供 AI 构建提示词上下文 */
  async getContextFiles(projectId?: string | null): Promise<ContextFile[]> {
    const files: ContextFile[] = [];

    const readTarget = async (
      target: string,
      name: string,
      project?: string | null,
    ) => {
      const { filePath } = this.getPathForTarget(target, undefined, project);
      const content = readFileSafe(filePath);
      if (content?.trim()) {
        files.push({ name, content: content.trim() });
      }
    };

    await readTarget("memory", "MEMORY.md");
    await readTarget("identity", "IDENTITY.md");
    await readTarget("user", "USER.md");
    if (projectId) {
      await readTarget("memory", `Project: ${projectId}`, projectId);
    }

    return files;
  }

  /** 委托给 FileSearcher：语义搜索 */
  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
    scope: "all" | "global" | "project" = "all",
  ): Promise<SemanticSearchResult[]> {
    return this.fileSearcher.semanticSearch(
      query,
      maxResults,
      period,
      projectId,
      scope,
    );
  }

  /** 委托给 FileSearcher：按月份分组列出文件 */
  async listFilesGroupedByMonth(): Promise<{
    root: Array<{ name: string; timestamps: string[] }>;
    monthly: MonthGroup[];
  }> {
    return this.fileSearcher.listFilesGroupedByMonth();
  }

  /** 委托给 FileSearcher：按时间段筛选文件 */
  async listFilesByPeriod(
    period: string,
  ): Promise<Array<{ name: string; timestamps: string[] }>> {
    return this.fileSearcher.listFilesByPeriod(period);
  }
}
