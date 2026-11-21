import type { LocalIndex } from "vectra";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryPaths } from "../memory/MemoryPaths.js";
import { KeyedAsyncMutex } from "../utils/asyncMutex.js";
import { validateProjectId } from "../utils/validation.js";
import { getCurrentDtype, getCurrentModelId } from "./embedding.js";

function isWithinDir(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 已向量化的文本切片，包含嵌入向量及其元数据。
 * metadata 中预期包含 filePath、heading、text、hash 等字段。
 */
export interface EmbeddedChunk {
  /** 嵌入向量 */
  vector: number[];
  /** 与向量关联的元数据键值对 */
  metadata: Record<string, string>;
}

/** 语义搜索返回的单条结果 */
export interface SearchResult {
  /** 余弦相似度得分（vectra 内置评分） */
  score: number;
  /** 来源文件路径 */
  filePath: string;
  /** 切片所属标题 */
  heading: string;
  /** 切片正文 */
  text: string;
  /** 切片所属时间戳 */
  timestamp?: string;
}

/** vectra queryItems 返回的原始条目结构，仅映射搜索需用字段 */
interface QuerySearchItem {
  score: number;
  item: { metadata: Record<string, unknown> };
}

/**
 * 判断向量条目的嵌入元数据是否与当前模型/dtype 匹配。
 * 不匹配的条目视为"stale"，需在索引刷新时清除重建。
 */
export function isCurrentEmbeddingMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return (
    String(metadata?.embeddingModel) === getCurrentModelId() &&
    String(metadata?.embeddingDtype) === getCurrentDtype()
  );
}

/**
 * 过滤搜索结果，仅保留与当前 embedding 模型/dtype 匹配的有效条目。
 * 同时将 vectra 内部格式转换为对外的 SearchResult 结构。
 */
export function filterCurrentSearchResults(
  items: QuerySearchItem[],
): SearchResult[] {
  return items
    .filter((item) => isCurrentEmbeddingMetadata(item.item.metadata))
    .map((item) => ({
      score: item.score,
      filePath: String(item.item.metadata.filePath),
      heading: String(item.item.metadata.heading),
      text: String(item.item.metadata.text),
      timestamp: item.item.metadata.timestamp
        ? String(item.item.metadata.timestamp)
        : undefined,
    }));
}

/**
 * 统一的本地 Vectra 向量索引管理器。
 *
 * 与特定 memoryDir 实例绑定（无模块级全局路径单例），统一管理：
 * - 全局 root.index（MEMORY.md / IDENTITY.md / USER.md）
 * - 全局 daily.index（daily/*.md）
 * - 项目级 projects/<projectId>/root.index（项目 MEMORY 与 daily）
 */
export class VectorStore {
  private readonly paths: MemoryPaths;
  private readonly indices = new Map<string, LocalIndex>();
  private readonly indexLocks = new KeyedAsyncMutex();

  constructor(memoryDir: string) {
    this.paths = new MemoryPaths(memoryDir);
  }

  /** 根据文件路径推导归属的向量索引目录 */
  resolveIndexPath(filePath: string): string {
    const projectId = this.extractProjectId(filePath);
    if (projectId) {
      validateProjectId(projectId);
      return path.join(this.paths.projectDir(projectId), "root.index");
    }

    if (isWithinDir(this.paths.dailyDir, filePath)) {
      return this.paths.dailyIndexPath;
    }

    return this.paths.rootIndexPath;
  }

  /**
   * 获取指定文件当前索引中且匹配当前模型/dtype 的已有切片 Hash 集合，
   * 供写入管线跳过无变更切片的重复 Embedding。
   */
  async getExistingChunkHashes(filePath: string): Promise<Set<string>> {
    const indexPath = this.resolveIndexPath(filePath);
    return this.indexLocks.withLock(indexPath, async () => {
      const index = await this.getIndex(indexPath);
      const items = await index.listItems();
      const resolvedTarget = path.resolve(filePath);
      const hashes = new Set<string>();

      for (const item of items) {
        if (
          item.metadata &&
          path.resolve(String(item.metadata.filePath)) === resolvedTarget &&
          isCurrentEmbeddingMetadata(item.metadata) &&
          item.metadata.hash
        ) {
          hashes.add(String(item.metadata.hash));
        }
      }

      return hashes;
    });
  }

  /** 对单个文件的切片集合执行增量 upsert（按索引目录串行加锁） */
  async upsertFile(
    filePath: string,
    chunks: EmbeddedChunk[],
    preservedHashes?: Set<string>,
  ): Promise<void> {
    const indexPath = this.resolveIndexPath(filePath);
    await this.indexLocks.withLock(indexPath, async () => {
      const index = await this.getIndex(indexPath);
      await upsertChunks(index, filePath, chunks, preservedHashes);
    });
  }

  /** 在全局 root 和 daily 两套索引中并行语义搜索，合并后按得分降序取 topK */
  async searchGlobal(
    queryVector: number[],
    topK: number = 20,
  ): Promise<SearchResult[]> {
    const [rootResults, dailyResults] = await Promise.all([
      this.queryIndex(this.paths.rootIndexPath, queryVector, topK),
      this.queryIndex(this.paths.dailyIndexPath, queryVector, topK),
    ]);

    const merged = [...rootResults, ...dailyResults];
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }

  /** 在指定项目的索引中执行语义搜索，按得分降序返回 */
  async searchProject(
    projectId: string,
    queryVector: number[],
    topK: number = 20,
  ): Promise<SearchResult[]> {
    validateProjectId(projectId);
    const indexPath = path.join(this.paths.projectDir(projectId), "root.index");
    return this.queryIndex(indexPath, queryVector, topK);
  }

  /**
   * 清理所有索引（全局 root / daily 以及已有项目索引）中与当前模型或 dtype
   * 不匹配的 stale 条目，返回受影响需要重建的文件路径列表。
   */
  async refreshStaleIndices(): Promise<string[]> {
    const indexPaths = [
      this.paths.rootIndexPath,
      this.paths.dailyIndexPath,
      ...this.findExistingProjectIndices(),
    ];

    const staleSets = await Promise.all(
      indexPaths.map((indexPath) =>
        this.indexLocks.withLock(indexPath, async () => {
          const index = await this.getIndex(indexPath);
          return deleteStaleEmbeddings(index);
        }),
      ),
    );

    const stalePaths = new Set<string>();
    for (const set of staleSets) {
      for (const filePath of set) {
        stalePaths.add(filePath);
      }
    }
    return [...stalePaths];
  }

  private async queryIndex(
    indexPath: string,
    queryVector: number[],
    topK: number,
  ): Promise<SearchResult[]> {
    return this.indexLocks.withLock(indexPath, async () => {
      const index = await this.getIndex(indexPath);
      const limit = await getQueryLimit(index, topK);
      const items = await index.queryItems(queryVector, "", limit);
      return filterCurrentSearchResults(items as QuerySearchItem[]);
    });
  }

  /**
   * 打开（必要时创建）一个 vectra 本地索引。
   * `vectra` 是 optionalDependency，动态加载以配合 setup 阶段的依赖预检。
   */
  private async getIndex(indexPath: string): Promise<LocalIndex> {
    const cached = this.indices.get(indexPath);
    if (cached) return cached;

    const { LocalIndex: LocalIndexCtor } = await import("vectra");
    const index = new LocalIndexCtor(indexPath);
    if (!(await index.isIndexCreated())) {
      await index.createIndex();
    }
    this.indices.set(indexPath, index);
    return index;
  }

  private extractProjectId(filePath: string): string | null {
    const projectsDir = this.paths.projectsDir;
    if (!isWithinDir(projectsDir, filePath)) return null;

    const relative = path.relative(
      path.resolve(projectsDir),
      path.resolve(filePath),
    );
    const segments = relative.split(path.sep);

    const dailyIdx = segments.indexOf("daily");
    if (dailyIdx > 0 && dailyIdx < segments.length - 1) {
      return segments.slice(0, dailyIdx).join("/");
    }

    return segments.slice(0, -1).join("/");
  }

  /** 扫描 projectsDir 下已创建的 root.index 目录（不额外创建空索引） */
  private findExistingProjectIndices(): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.name === "root.index") {
          results.push(fullPath);
        } else {
          walk(fullPath);
        }
      }
    };
    walk(this.paths.projectsDir);
    return results;
  }
}

async function getQueryLimit(index: LocalIndex, topK: number): Promise<number> {
  if (Number.isFinite(topK)) {
    return topK;
  }

  const items = await index.listItems();
  return Math.max(items.length, 1);
}

async function deleteStaleEmbeddings(index: LocalIndex): Promise<Set<string>> {
  const stalePaths = new Set<string>();
  const items = await index.listItems();
  for (const item of items) {
    if (!isCurrentEmbeddingMetadata(item.metadata)) {
      const filePath = String(item.metadata?.filePath ?? "");
      if (filePath) stalePaths.add(filePath);
      await index.deleteItem(String(item.id));
    }
  }
  return stalePaths;
}

/**
 * 基于 hash 对索引执行增量 upsert：
 * 1. 找出需要删除的条目（模型/dtype 已变更或缺少 hash）
 * 2. 反向比对找出已消失的旧条目
 * 3. 仅插入 hash 未命中已有索引的新切片
 */
async function upsertChunks(
  index: LocalIndex,
  filePath: string,
  chunks: EmbeddedChunk[],
  preservedHashes?: Set<string>,
): Promise<void> {
  const existing = await index.listItems();
  const existingByHash = new Map<string, string>();
  const chunksByHash = new Map(
    chunks.map((chunk) => [chunk.metadata.hash, chunk]),
  );
  const toDelete: string[] = [];

  const resolvedTarget = path.resolve(filePath);
  for (const item of existing) {
    if (
      item.metadata &&
      path.resolve(String(item.metadata.filePath)) === resolvedTarget
    ) {
      const hash = item.metadata.hash ? String(item.metadata.hash) : null;
      if (hash) {
        const chunk = chunksByHash.get(hash);
        if (
          chunk &&
          (String(item.metadata.embeddingModel) !==
            chunk.metadata.embeddingModel ||
            String(item.metadata.embeddingDtype) !==
              chunk.metadata.embeddingDtype)
        ) {
          toDelete.push(String(item.id));
          continue;
        }
        existingByHash.set(hash, String(item.id));
      } else {
        toDelete.push(String(item.id));
      }
    }
  }

  const newHashes = new Set(chunks.map((c) => c.metadata.hash));
  for (const [hash, id] of existingByHash) {
    if (!newHashes.has(hash) && !preservedHashes?.has(hash)) {
      toDelete.push(id);
    }
  }

  for (const id of toDelete) {
    await index.deleteItem(id);
  }

  for (const { vector, metadata } of chunks) {
    if (!existingByHash.has(metadata.hash)) {
      await index.insertItem({ vector, metadata });
    }
  }
}
