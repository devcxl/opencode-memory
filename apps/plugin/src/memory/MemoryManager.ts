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
import type { Providers, MemoryMode } from "../providers/factory.js";
import { ensureDir } from "../utils/fs.js";
import { MemoryPaths } from "./MemoryPaths.js";
import {
  checkLineLimit,
  normalizeDailyDate,
  validateProjectId,
} from "../utils/validation.js";
import { gitCommit } from "../utils/git.js";
import { getCurrentDtype } from "../search/embedding.js";
import { chunkMarkdown } from "../search/chunker.js";
import { ProjectStore, refreshStaleIndices } from "../search/vector-store.js";
import { parseContentByTimestamp } from "../utils/timestampParser.js";
import { StateChecker } from "./StateChecker.js";
import { FileSearcher } from "./FileSearcher.js";
import { LocalVectorIndexProvider } from "../providers/local/VectorIndexProvider.js";
import { LocalEmbeddingProvider } from "../providers/local/EmbeddingProvider.js";
import { LocalFileStorageProvider } from "../providers/local/FileStorageProvider.js";

/** 内存系统的核心管理器，统一管理文件读写、向量索引、语义搜索、状态检查等能力 */
export class MemoryManager {
  private config: MemoryConfig;
  private paths: MemoryPaths;
  private providers: Providers;
  private mode: MemoryMode;
  private projectStores: Map<string, ProjectStore> = new Map();
  private stateChecker: StateChecker;
  private fileSearcher: FileSearcher;

  constructor(config: MemoryConfig, providers?: Providers) {
    this.config = config;
    this.paths = new MemoryPaths(config.memoryDir);
    this.mode = config.mode ?? "local";

    if (providers) {
      this.providers = providers;
    } else {
      // 未注入 providers 时自动创建本地 Provider，保证向后兼容
      this.providers = {
        vectorIndex: new LocalVectorIndexProvider(config),
        embedding: new LocalEmbeddingProvider(),
        fileStorage: new LocalFileStorageProvider(config),
      };
    }

    this.stateChecker = new StateChecker(config.memoryDir, this.mode);
    this.fileSearcher = new FileSearcher(
      config.memoryDir,
      this.paths.dailyDir,
      this.providers.fileStorage,
      (id) => this.getProjectStore(id),
      this.mode,
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
      const content = await this.providers.fileStorage.readFile(filePath);
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

  /** 是否为 remote 模式（记录独立存储，时间戳由服务端 created_at 决定） */
  isRemote(): boolean {
    return this.mode === "remote";
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
   * @param category 新分类（instruction | learning | daily），优于 target 推导
   * @param subType 新子类型（identity | rule | workflow | preference | episodic | knowledge）
   * @param scope 作用域（global | project | user | local）
   */
  getPathForTarget(
    target: string,
    date?: string,
    project?: string | null,
    category?: string,
    subType?: string,
    scope?: string,
  ): {
    filePath: string;
    displayName: string;
    category: string;
    subType: string;
  } {
    // 🆕 target → category/subType 向后兼容映射表
    const TARGET_MAP: Record<string, { category: string; sub_type: string }> = {
      memory: { category: "learning", sub_type: "knowledge" },
      identity: { category: "instruction", sub_type: "identity" },
      user: { category: "learning", sub_type: "preference" },
      daily: { category: "daily", sub_type: "" },
    };

    const resolved =
      category && subType !== undefined
        ? { category, sub_type: subType }
        : (TARGET_MAP[target] ?? {
            category: "learning",
            sub_type: "knowledge",
          });

    const effectiveScope = scope ?? (project ? "project" : "global");
    const effectiveProject = project ?? "";

    if (this.mode === "remote") {
      const effectiveDate =
        target === "daily" ? (normalizeDailyDate(date) ?? this.todayStr()) : "";
      const filePath = [
        resolved.category,
        resolved.sub_type,
        effectiveScope,
        effectiveProject,
        effectiveDate,
      ].join(":");
      return {
        filePath,
        displayName: filePath,
        category: resolved.category,
        subType: resolved.sub_type,
      };
    }

    // local 模式
    const { category: cat, sub_type: st } = resolved;
    switch (target) {
      case "memory": {
        if (project) {
          const filePath = this.getProjectMemoryPath(project);
          return {
            filePath,
            displayName: `projects/${project}/MEMORY.md`,
            category: cat,
            subType: st,
          };
        }
        return {
          filePath: this.getMemoryPath(),
          displayName: "MEMORY.md",
          category: cat,
          subType: st,
        };
      }
      case "identity":
        return {
          filePath: this.getIdentityPath(),
          displayName: "IDENTITY.md",
          category: cat,
          subType: st,
        };
      case "user":
        return {
          filePath: this.getUserPath(),
          displayName: "USER.md",
          category: cat,
          subType: st,
        };
      case "daily": {
        const targetDate = normalizeDailyDate(date) ?? this.todayStr();
        if (project) {
          return {
            filePath: this.paths.projectDailyPath(project, targetDate),
            displayName: `projects/${project}/daily/${targetDate}.md`,
            category: cat,
            subType: st,
          };
        }
        return {
          filePath: this.getDailyPath(targetDate),
          displayName: `daily/${targetDate}.md`,
          category: cat,
          subType: st,
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
  async readFile(filePath: string): Promise<string | null> {
    return this.providers.fileStorage.readFile(filePath);
  }

  /**
   * 写入文件并触发向量索引与 git 提交
   * 写入前校验行数限制，避免大文件失控
   */
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
    const content = await this.providers.fileStorage.readFile(filePath);
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

    // remote 模式：记录独立存储，委托 provider 删除具体那条记录
    if (
      this.mode === "remote" &&
      typeof this.providers.fileStorage.deleteByTimestamp === "function"
    ) {
      return this.providers.fileStorage.deleteByTimestamp(filePath, timestamp);
    }

    const content = await this.providers.fileStorage.readFile(filePath);

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

  /**
   * 以追加方式写入文件，自动添加时间戳标记
   * 用于 daily log 等持续追加的场景，并保持向量索引与 git 提交一致
   */
  async appendFile(filePath: string, content: string): Promise<void> {
    // remote 模式：记录独立存储，一次追加即一条新记录，不读回拼接
    // 不嵌入时间戳：记录时间由服务端 created_at 决定，readFile 时再生成展示时间戳
    if (this.mode === "remote") {
      checkLineLimit(filePath, content);
      await this.persistAndIndex(
        filePath,
        content,
        `Append to ${path.basename(filePath)}`,
        true,
      );
      return;
    }

    // local 模式：读回现有内容后整体重写
    // 本地文件按时间戳标记区分条目（delete/list 均依赖），追加时必须嵌入
    const timestamp = this.getLocalTimestamp();
    const stamped = `<!-- ${timestamp} -->\n${content}`;
    const existing = await this.providers.fileStorage.readFile(filePath);
    const separator = existing?.trim() ? "\n\n" : "";
    const newContent = (existing ?? "") + separator + stamped;

    checkLineLimit(filePath, newContent);
    await this.persistAndIndex(
      filePath,
      newContent,
      `Append to ${path.basename(filePath)}`,
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
   * 从 projects/ 子目录下的文件路径中提取 projectId。
   *
   * 例：
   *   projects/owner/repo/MEMORY.md       → "owner/repo"
   *   projects/owner/repo/daily/file.md   → "owner/repo"
   *   projects/myproject/MEMORY.md        → "myproject"
   *   projects/myproject/daily/file.md    → "myproject"
   *
   * 通过定位 daily/ 子目录判断项目根边界，
   * 若路径不含 daily/ 则取文件的父目录为 projectId。
   */
  private extractProjectId(filePath: string): string | null {
    const projectsDir = this.paths.projectsDir;
    if (!filePath.startsWith(projectsDir + path.sep)) return null;

    const relative = path.relative(projectsDir, filePath);
    const segments = relative.split(path.sep);

    // 检查是否包含 daily/ 子目录
    const dailyIdx = segments.indexOf("daily");
    if (dailyIdx > 0 && dailyIdx < segments.length - 1) {
      // daily/ 之前的 segments 构成 projectId
      return segments.slice(0, dailyIdx).join("/");
    }

    // 不含 daily/，取文件父目录
    return segments.slice(0, -1).join("/");
  }

  /**
   * 将文件内容分块、向量化并写入向量存储，供语义搜索使用。
   *
   * 路由规则：
   * - 文件路径位于 projects/ 子目录下 → 写入对应 project namespace
   * - 文件名称包含 daily → 写入全局 daily namespace
   * - 其余文件 → 写入全局 root namespace
   *
   * 静默跳过 embedding 引擎未初始化的错误（如插件刚安装尚未下载模型），
   * 因为此时写入不影响数据持久性，后续模型加载后会重建索引。
   */
  private async embedAndIndex(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const chunks = chunkMarkdown(content, filePath);
      const embeddingModel = this.providers.embedding.modelId;

      // 批量嵌入所有切片
      const texts = chunks.map((c) => c.text);
      const vectors = await this.providers.embedding.embedTexts(texts);

      const embedded = chunks.map((chunk, idx) => ({
        vector: vectors[idx],
        metadata: {
          filePath,
          heading: chunk.heading,
          text: chunk.text,
          hash: chunk.hash,
          embeddingModel,
          embeddingDtype: getCurrentDtype(),
          ...(chunk.timestamp ? { timestamp: chunk.timestamp } : {}),
        },
      }));

      const projectId = this.extractProjectId(filePath);
      if (projectId) {
        await this.providers.vectorIndex.upsert(
          embedded,
          `project/${projectId}`,
        );
        return;
      }

      // 非项目文件写入全局索引（root/daily 由 namespace 区分）
      const namespace = filePath.includes(`${path.sep}daily${path.sep}`)
        ? "daily"
        : "root";
      await this.providers.vectorIndex.upsert(embedded, namespace);
    } catch (err) {
      const errMsg = (err as Error).message;
      // embedding 引擎未初始化时静默跳过，不阻塞写入操作
      if (!errMsg.includes("not initialized")) {
        throw err;
      }
    }
  }

  /**
   * 写入文件、更新向量索引、提交 git 三合一操作
   * 所有写入/编辑/删除/追加方法在修改文件后均执行此流程。
   *
   * local 模式：写入文件 + embed/index + git commit
   * remote 模式：写入文件（Worker 侧自动 embed/index），跳过 git commit
   */
  private async persistAndIndex(
    filePath: string,
    content: string,
    operation: string,
    append = false,
  ): Promise<void> {
    // remote append：只新增一条记录；overwrite/edit 走 writeFile（远程 provider 内部先删后建）
    if (append && this.mode === "remote") {
      await this.providers.fileStorage.appendFile(filePath, content);
      return;
    }

    await this.providers.fileStorage.writeFile(filePath, content);

    // local 模式：本地 embed + index + git commit
    if (this.mode === "local") {
      await this.embedAndIndex(filePath, content);

      // 推导对应的向量索引路径，确保索引文件也被 git 追踪
      const indexPaths: string[] = [];
      const projectId = this.extractProjectId(filePath);
      if (projectId) {
        indexPaths.push(
          path.join(this.paths.projectsDir, projectId, "root.index"),
        );
      } else if (filePath.includes(path.sep + "daily" + path.sep)) {
        indexPaths.push(this.paths.dailyIndexPath);
      } else {
        indexPaths.push(this.paths.rootIndexPath);
      }

      await gitCommit(operation, filePath, this.config.memoryDir, indexPaths);
    }
    // remote 模式：Worker 侧自动 embed + index，无需本地 git commit
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
   * 包含全局 MEMORY/IDENTITY/USER 以及可选的 project memory。
   *
   * 统一使用 getPathForTarget() 生成路径，确保 local/remote 双模式兼容。
   */
  async getContextFiles(projectId?: string | null): Promise<ContextFile[]> {
    const files: ContextFile[] = [];

    const readTarget = async (
      target: string,
      name: string,
      project?: string | null,
    ) => {
      const { filePath } = this.getPathForTarget(target, undefined, project);
      const content = await this.readFile(filePath);
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

  /** 委托给 FileSearcher：关键词搜索 */
  async searchFiles(
    query: string,
    maxResults: number,
  ): Promise<SearchResult[]> {
    return this.fileSearcher.searchFiles(query, maxResults);
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

  /** 委托给 FileSearcher：列出所有文件 */
  listFiles(): ListResult {
    return this.fileSearcher.listFiles();
  }

  /** 委托给 FileSearcher：列出文件及其时间戳 */
  async listFilesWithTimestamps(
    limit: number = 7,
  ): Promise<Array<{ name: string; timestamps: string[] }>> {
    return this.fileSearcher.listFilesWithTimestamps(limit);
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
