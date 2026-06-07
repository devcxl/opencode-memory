import * as path from "node:path";
import * as fs from "node:fs";
import type {
  SearchResult,
  ListResult,
  ContextFile,
  TimestampEntry,
  SemanticSearchResult,
  MonthGroup,
} from "../types.js";
import type { MemoryConfig } from "../config/runtime.js";
import { ensureDir } from "../utils/fs.js";
import { MemoryPaths } from "./MemoryPaths.js";
import { atomicWrite } from "../utils/atomicWrite.js";
import { checkLineLimit, validateProjectId } from "../utils/validation.js";
import { gitCommit } from "../utils/git.js";
import {
  embedText,
  getCurrentDtype,
  getCurrentModelId,
} from "../search/embedding.js";
import { chunkMarkdown } from "../search/chunker.js";
import {
  upsertFile,
  deleteFileVectors,
  ProjectStore,
  refreshStaleIndices,
} from "../search/vector-store.js";
import { parseContentByTimestamp } from "../utils/timestampParser.js";
import { StateChecker } from "./StateChecker.js";
import { FileSearcher } from "./FileSearcher.js";

/** 内存系统的核心管理器，统一管理文件读写、向量索引、语义搜索、状态检查等能力 */
export class MemoryManager {
  private config: MemoryConfig;
  private paths: MemoryPaths;
  private projectStores: Map<string, ProjectStore> = new Map();
  private stateChecker: StateChecker;
  private fileSearcher: FileSearcher;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.paths = new MemoryPaths(config.memoryDir);
    this.stateChecker = new StateChecker(config.memoryDir);
    this.fileSearcher = new FileSearcher(
      config.memoryDir,
      this.paths.dailyDir,
      (p) => this.readFile(p),
      (id) => this.getProjectStore(id),
    );
  }

  private freshIndexDone = false;

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
    const stalePaths = await refreshStaleIndices();
    if (stalePaths.length === 0) return;

    for (const filePath of stalePaths) {
      const content = this.readFile(filePath);
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

  /**
   * 获取或创建指定项目的向量存储实例
   * 使用延迟初始化，只在首次访问时创建 ProjectStore
   */
  getProjectStore(projectId: string): ProjectStore {
    validateProjectId(projectId);
    if (!this.projectStores.has(projectId)) {
      this.projectStores.set(
        projectId,
        new ProjectStore(this.paths.projectDir(projectId)),
      );
    }
    return this.projectStores.get(projectId)!;
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
   * @param target 目标类型：memory | identity | user | daily
   * @param date daily 类型时的日期
   * @param project 项目级 memory 时的项目 ID
   */
  getPathForTarget(
    target: string,
    date?: string,
    project?: string | null,
  ): { filePath: string; displayName: string } {
    switch (target) {
      case "memory": {
        if (project) {
          const filePath = this.getProjectMemoryPath(project);
          return { filePath, displayName: `projects/${project}/MEMORY.md` };
        }
        return { filePath: this.getMemoryPath(), displayName: "MEMORY.md" };
      }
      case "identity":
        return { filePath: this.getIdentityPath(), displayName: "IDENTITY.md" };
      case "user":
        return { filePath: this.getUserPath(), displayName: "USER.md" };
      case "daily": {
        const targetDate = date ?? this.todayStr();
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

  /**
   * 读取文件内容，文件不存在或读取失败时返回 null 而非抛异常
   * 避免调用方需要逐层 try/catch
   */
  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 写入文件并触发向量索引与 git 提交
   * 写入前校验行数限制，避免大文件失控
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    checkLineLimit(filePath, content);
    atomicWrite(filePath, content);
    await this.embedAndIndex(filePath, content);
    await gitCommit(
      `Update ${path.basename(filePath)}`,
      filePath,
      this.config.memoryDir,
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
    const content = this.readFile(filePath);
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
    atomicWrite(filePath, updatedContent);
    await this.embedAndIndex(filePath, updatedContent);
    await gitCommit(
      `Edit ${path.basename(filePath)}`,
      filePath,
      this.config.memoryDir,
    );
  }

  /**
   * 按时间戳删除文件中的条目
   * 解析文件中的 `<!-- timestamp -->` 标记，删除匹配的条目后重写文件
   * @returns 删除结果描述
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
    const content = this.readFile(filePath);

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

    atomicWrite(filePath, newContent);
    await this.embedAndIndex(filePath, newContent);
    await gitCommit(
      `Delete entries from ${path.basename(filePath)}`,
      filePath,
      this.config.memoryDir,
    );

    return `Deleted ${entries.length - filteredEntries.length} entries from ${displayName}`;
  }

  /**
   * 以追加方式写入文件，自动添加时间戳标记
   * 用于 daily log 等持续追加的场景，并保持向量索引与 git 提交一致
   */
  async appendFile(filePath: string, content: string): Promise<void> {
    const existing = this.readFile(filePath);
    const separator = existing?.trim() ? "\n\n" : "";
    const timestamp = this.getLocalTimestamp();
    const stamped = `<!-- ${timestamp} -->\n${content}`;
    const newContent = (existing ?? "") + separator + stamped;

    checkLineLimit(filePath, newContent);
    atomicWrite(filePath, newContent);
    await this.embedAndIndex(filePath, newContent);
    await gitCommit(
      `Append to ${path.basename(filePath)}`,
      filePath,
      this.config.memoryDir,
    );
  }

  /**
   * 获取本地时间戳字符串，用于标记每次写入的准确时间
   * 使用本地时间而非 UTC，方便用户理解日志时间
   */
  getLocalTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /**
   * 将文件内容分块、向量化并写入向量存储，供语义搜索使用
   * 项目文件写入项目级 store，其余写入全局 store；静默跳过未初始化的引擎
   */
  private async embedAndIndex(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const chunks = chunkMarkdown(content, filePath);
      const embeddingModel = getCurrentModelId();
      const embeddingDtype = getCurrentDtype();
      const embedded = await Promise.all(
        chunks.map(async (chunk) => ({
          vector: await embedText(chunk.text),
          metadata: {
            filePath,
            heading: chunk.heading,
            text: chunk.text,
            hash: chunk.hash,
            embeddingModel,
            embeddingDtype,
            ...(chunk.timestamp ? { timestamp: chunk.timestamp } : {}),
          },
        })),
      );

      const projectsDir = this.paths.projectsDir;
      if (filePath.startsWith(projectsDir + path.sep)) {
        const relative = path.relative(projectsDir, filePath);
        const projectId = path.dirname(relative).split(path.sep).join("/");
        if (projectId && projectId !== ".") {
          const store = this.getProjectStore(projectId);
          await store.upsertFile(filePath, embedded);
          return;
        }
      }

      await upsertFile(filePath, embedded);
    } catch (err) {
      const errMsg = (err as Error).message;
      if (!errMsg.includes("not initialized")) {
        throw err;
      }
    }
  }

  /**
   * 删除文件，忽略文件不存在的错误
   * 用于清理临时或已废弃的 memory 文件
   */
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

  /** 检查文件是否存在 */
  fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  /** 委托给 StateChecker：判断是否已初始化 */
  isInitialized(): boolean {
    return this.stateChecker.isInitialized();
  }

  /** 委托给 StateChecker：判断是否需要首次引导 */
  needsBootstrap(): boolean {
    return this.stateChecker.needsBootstrap();
  }

  /** 委托给 StateChecker：获取初始化状态枚举 */
  getInitState(): "uninitialized" | "bootstrapping" | "ready" {
    return this.stateChecker.getInitState();
  }

  /**
   * 同步写入文件，不触发向量索引和 git 提交
   * 仅用于模板初始化等不需要追踪的场景
   */
  writeFileSync(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, "utf-8");
  }

  /**
   * 收集所有有内容的 context 文件，供 AI 构建提示词上下文
   * 包含全局 MEMORY/IDENTITY/USER 以及可选的 project memory
   */
  getContextFiles(projectId?: string | null): ContextFile[] {
    const files: ContextFile[] = [];
    const memoryContent = this.readFile(this.getMemoryPath());
    if (memoryContent?.trim()) {
      files.push({ name: "MEMORY.md", content: memoryContent.trim() });
    }
    const identityContent = this.readFile(this.getIdentityPath());
    if (identityContent?.trim()) {
      files.push({ name: "IDENTITY.md", content: identityContent.trim() });
    }
    const userContent = this.readFile(this.getUserPath());
    if (userContent?.trim()) {
      files.push({ name: "USER.md", content: userContent.trim() });
    }
    if (projectId) {
      const projectMemoryPath = this.getProjectMemoryPath(projectId);
      const projectContent = this.readFile(projectMemoryPath);
      if (projectContent?.trim()) {
        files.push({
          name: `Project: ${projectId}`,
          content: projectContent.trim(),
        });
      }
    }
    return files;
  }

  /** 委托给 FileSearcher：关键词搜索 */
  searchFiles(query: string, maxResults: number): SearchResult[] {
    return this.fileSearcher.searchFiles(query, maxResults);
  }

  /** 委托给 FileSearcher：语义搜索 */
  async semanticSearch(
    query: string,
    maxResults: number = 20,
    period?: string,
    projectId?: string | null,
  ): Promise<SemanticSearchResult[]> {
    return this.fileSearcher.semanticSearch(
      query,
      maxResults,
      period,
      projectId,
    );
  }

  /** 委托给 FileSearcher：列出所有文件 */
  listFiles(): ListResult {
    return this.fileSearcher.listFiles();
  }

  /** 委托给 FileSearcher：列出文件及其时间戳 */
  listFilesWithTimestamps(
    limit: number = 7,
  ): Array<{ name: string; timestamps: string[] }> {
    return this.fileSearcher.listFilesWithTimestamps(limit);
  }

  /** 委托给 FileSearcher：按月份分组列出文件 */
  listFilesGroupedByMonth(): {
    root: Array<{ name: string; timestamps: string[] }>;
    monthly: MonthGroup[];
  } {
    return this.fileSearcher.listFilesGroupedByMonth();
  }

  /** 委托给 FileSearcher：按时间段筛选文件 */
  listFilesByPeriod(
    period: string,
  ): Array<{ name: string; timestamps: string[] }> {
    return this.fileSearcher.listFilesByPeriod(period);
  }
}
