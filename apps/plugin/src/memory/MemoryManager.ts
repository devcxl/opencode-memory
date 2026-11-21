import * as path from "node:path";
import * as fs from "node:fs";
import type {
  ContextFile,
  MemoryOrigin,
  MonthGroup,
  SearchScope,
  SemanticSearchResult,
} from "../types.js";
import type { MemoryConfig, MemoryLimits } from "../config/runtime.js";
import { DEFAULT_MEMORY_LIMITS } from "../config/runtime.js";
import { ensureDir, readFileSafe } from "../utils/fs.js";
import { atomicWrite } from "../utils/atomicWrite.js";
import { KeyedAsyncMutex } from "../utils/asyncMutex.js";
import { BackgroundSyncQueue } from "../utils/backgroundQueue.js";
import { MemoryPaths } from "./MemoryPaths.js";
import {
  checkCharBudget,
  checkLineLimit,
  formatBudgetNote,
  normalizeDailyDate,
  validateProjectId,
  validateTimestamp,
} from "../utils/validation.js";
import { gitCommit } from "../utils/git.js";
import {
  embedText,
  getCurrentDtype,
  getCurrentModelId,
} from "../search/embedding.js";
import { chunkMarkdown } from "../search/chunker.js";
import { VectorStore } from "../search/vector-store.js";
import {
  formatTimestampComment,
  parseContentByTimestamp,
  stripExternalOriginEntries,
} from "../utils/timestampParser.js";
import { FileSearcher } from "./FileSearcher.js";

/** 内存系统的核心管理器，统一管理文件读写、向量索引、语义搜索与 git 提交 */
export class MemoryManager {
  private config: MemoryConfig;
  private limits: MemoryLimits;
  private paths: MemoryPaths;
  private vectorStore: VectorStore;
  private fileSearcher: FileSearcher;
  private freshIndexPromise: Promise<void> | null = null;
  private readonly fileLocks = new KeyedAsyncMutex();
  private readonly syncQueue: BackgroundSyncQueue;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.limits = config.limits ?? DEFAULT_MEMORY_LIMITS;
    this.paths = new MemoryPaths(config.memoryDir);
    this.vectorStore = new VectorStore(config.memoryDir);
    this.fileSearcher = new FileSearcher(
      config.memoryDir,
      this.paths.dailyDir,
      this.vectorStore,
    );
    this.syncQueue = new BackgroundSyncQueue((filePath, operation) =>
      this.runBackgroundSync(filePath, operation),
    );
  }

  /** 确保 memory 和 daily 目录存在，并在首次调用时重建因模型切换而失效的索引 */
  async ensureDirectories(): Promise<void> {
    ensureDir(this.config.memoryDir);
    ensureDir(this.paths.dailyDir);
    if (!this.freshIndexPromise) {
      this.freshIndexPromise = this.ensureFreshIndex();
    }
    await this.freshIndexPromise;
  }

  private async ensureFreshIndex(): Promise<void> {
    const stalePaths = await this.vectorStore.refreshStaleIndices();
    if (stalePaths.length === 0) return;

    for (const filePath of stalePaths) {
      const content = readFileSafe(filePath);
      if (!content) continue;
      try {
        await this.fileLocks.withLock(filePath, () =>
          this.embedAndIndex(filePath, content),
        );
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

  /** 写入文件并触发向量索引与 git 提交，返回可选的字符预算提示 */
  async writeFile(filePath: string, content: string): Promise<string | null> {
    return this.fileLocks.withLock(filePath, async () => {
      const existing = readFileSafe(filePath) ?? undefined;
      checkLineLimit(filePath, content);
      checkCharBudget(
        filePath,
        content,
        this.config.memoryDir,
        this.limits,
        existing,
      );
      await this.persistAndIndex(
        filePath,
        content,
        `Update ${path.basename(filePath)}`,
      );
      return formatBudgetNote(
        filePath,
        content,
        this.config.memoryDir,
        this.limits,
      );
    });
  }

  /**
   * 精确替换文件中的字符串段，用于细粒度编辑而非全量覆盖
   * 要求 oldString 在文件中恰好出现一次，避免歧义覆盖
   */
  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
  ): Promise<string | null> {
    return this.fileLocks.withLock(filePath, async () => {
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
      checkLineLimit(filePath, updatedContent);
      checkCharBudget(
        filePath,
        updatedContent,
        this.config.memoryDir,
        this.limits,
        content,
      );
      await this.persistAndIndex(
        filePath,
        updatedContent,
        `Edit ${path.basename(filePath)}`,
      );
      return formatBudgetNote(
        filePath,
        updatedContent,
        this.config.memoryDir,
        this.limits,
      );
    });
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

    return this.fileLocks.withLock(filePath, async () => {
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
        .map(
          (e) =>
            `${formatTimestampComment(e.timestamp, e.origin)}\n${e.content}`,
        )
        .join("\n\n");

      await this.persistAndIndex(
        filePath,
        newContent,
        `Delete entries from ${path.basename(filePath)}`,
      );

      const summary = `Deleted ${entries.length - filteredEntries.length} entries from ${displayName}`;
      const budgetNote = formatBudgetNote(
        filePath,
        newContent,
        this.config.memoryDir,
        this.limits,
      );
      return budgetNote ? `${summary}\n${budgetNote}` : summary;
    });
  }

  /**
   * 以追加方式写入文件，自动添加时间戳标记。
   * 可选传入 replaceTimestamps 在同一次锁与原子落盘内先删旧条目再追加新内容，
   * 仅在终态校验字符预算。
   */
  async appendFile(
    filePath: string,
    content: string,
    options?: { replaceTimestamps?: string[]; origin?: MemoryOrigin },
  ): Promise<string | null> {
    if (options?.replaceTimestamps) {
      for (const ts of options.replaceTimestamps) {
        validateTimestamp(ts);
      }
    }

    return this.fileLocks.withLock(filePath, async () => {
      const existing = readFileSafe(filePath) ?? "";
      let baseContent = existing;

      if (options?.replaceTimestamps && options.replaceTimestamps.length > 0) {
        const toRemove = new Set(options.replaceTimestamps);
        const entries = parseContentByTimestamp(existing);
        const remaining = entries.filter(
          (entry) => !toRemove.has(entry.timestamp),
        );
        if (remaining.length === entries.length) {
          throw new Error(
            `No entries found matching replace_timestamps: ${options.replaceTimestamps.join(", ")}`,
          );
        }
        baseContent = remaining
          .map(
            (e) =>
              `${formatTimestampComment(e.timestamp, e.origin)}\n${e.content}`,
          )
          .join("\n\n");
      }

      const timestamp = this.getLocalTimestamp();
      const stamped = `${formatTimestampComment(timestamp, options?.origin)}\n${content}`;
      const separator = baseContent.trim() ? "\n\n" : "";
      const newContent = baseContent + separator + stamped;

      checkLineLimit(filePath, newContent);
      checkCharBudget(
        filePath,
        newContent,
        this.config.memoryDir,
        this.limits,
        baseContent || undefined,
      );
      await this.persistAndIndex(
        filePath,
        newContent,
        `Append to ${path.basename(filePath)}`,
      );
      return formatBudgetNote(
        filePath,
        newContent,
        this.config.memoryDir,
        this.limits,
      );
    });
  }

  /** 获取本地时间戳字符串 YYYY-MM-DD HH:MM:SS */
  getLocalTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /** 将文件内容分块、先比对 Hash 再增量向量化并写入向量存储 */
  private async embedAndIndex(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const chunks = chunkMarkdown(content, filePath);
      const embeddingModel = getCurrentModelId();
      const embeddingDtype = getCurrentDtype();

      const existingHashes =
        await this.vectorStore.getExistingChunkHashes(filePath);
      const chunkHashSet = new Set(chunks.map((c) => c.hash));
      const preservedHashes = new Set<string>();
      for (const hash of existingHashes) {
        if (chunkHashSet.has(hash)) {
          preservedHashes.add(hash);
        }
      }

      const chunksToEmbed = chunks.filter((c) => !preservedHashes.has(c.hash));
      const vectors = await Promise.all(
        chunksToEmbed.map((c) => embedText(c.embeddingText ?? c.text)),
      );
      const embedded = chunksToEmbed.map((chunk, idx) => ({
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

      if (embedded.length > 0 || preservedHashes.size !== existingHashes.size) {
        await this.vectorStore.upsertFile(
          filePath,
          embedded,
          preservedHashes.size > 0 ? preservedHashes : undefined,
        );
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      // embedding 引擎未初始化时静默跳过，不阻塞写入操作
      if (!errMsg.includes("not initialized")) {
        throw err;
      }
    }
  }

  /**
   * 写入文件后立即返回，并将向量索引更新与 Git 提交放入带栅栏的后台异步队列。
   * 同步落盘的 Markdown 文件作为 SSOT 立即可读；调用 `flush()` 或 `semanticSearch()` 会等待队列完成。
   */
  private async persistAndIndex(
    filePath: string,
    content: string,
    operation: string,
  ): Promise<void> {
    atomicWrite(filePath, content);
    this.syncQueue.enqueue(filePath, operation);
  }

  /** 在后台串行更新指定文件的派生向量索引与 Git 审计记录（彼此错误隔离） */
  private async runBackgroundSync(
    filePath: string,
    operation: string,
  ): Promise<void> {
    const latestContent = readFileSafe(filePath);
    if (latestContent !== null) {
      try {
        await this.embedAndIndex(filePath, latestContent);
      } catch (err) {
        console.error(
          `[opencode-memory] Background vector indexing failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      // 向量索引为可重建的派生数据，仅追踪 Markdown 源文件
      await gitCommit(operation, filePath, this.config.memoryDir);
    } catch (err) {
      console.error(
        `[opencode-memory] Background git commit failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 显式等待所有后台向量索引与 Git 提交任务完成 */
  async flush(): Promise<void> {
    await this.syncQueue.flush();
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
        const sanitized = stripExternalOriginEntries(content);
        if (sanitized) {
          files.push({ name, content: sanitized });
        }
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

  /** 委托给 FileSearcher：语义搜索（检索前先等待待建后台索引队列收敛） */
  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
    scope: "all" | "global" | "project" = "all",
  ): Promise<SemanticSearchResult[]> {
    await this.flush();
    return this.fileSearcher.semanticSearch(
      query,
      maxResults,
      period,
      projectId,
      scope,
    );
  }

  /** 委托给 FileSearcher：按月份分组列出文件（支持项目作用域） */
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
    return this.fileSearcher.listFilesGroupedByMonth(projectId, scope);
  }

  /** 委托给 FileSearcher：按时间段筛选文件（支持项目作用域） */
  async listFilesByPeriod(
    period: string,
    projectId?: string | null,
    scope: SearchScope = "all",
  ): Promise<Array<{ name: string; timestamps: string[] }>> {
    return this.fileSearcher.listFilesByPeriod(period, projectId, scope);
  }
}
