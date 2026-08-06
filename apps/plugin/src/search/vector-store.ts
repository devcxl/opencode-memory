import { LocalIndex } from "vectra";
import * as path from "node:path";
import { getMemoryDir } from "../config/runtime.js";
import { MemoryPaths } from "../memory/MemoryPaths.js";
import { getCurrentDtype, getCurrentModelId } from "./embedding.js";

// ─── 全局索引实例（单例） ──────────────────────────────────────

const memoryPaths = new MemoryPaths(getMemoryDir());

let rootIndex: LocalIndex | null = null;
let dailyIndex: LocalIndex | null = null;

function getRootIndexPath(): string {
  return memoryPaths.rootIndexPath;
}

function getDailyIndexPath(): string {
  return memoryPaths.dailyIndexPath;
}

/** 获取 root 索引，首次访问时自动初始化本地索引文件 */
async function getRootIndex(): Promise<LocalIndex> {
  if (!rootIndex) {
    rootIndex = new LocalIndex(getRootIndexPath());
    if (!(await rootIndex.isIndexCreated())) {
      await rootIndex.createIndex();
    }
  }
  return rootIndex;
}

/** 获取 daily 索引，首次访问时自动初始化本地索引文件 */
async function getDailyIndex(): Promise<LocalIndex> {
  if (!dailyIndex) {
    dailyIndex = new LocalIndex(getDailyIndexPath());
    if (!(await dailyIndex.isIndexCreated())) {
      await dailyIndex.createIndex();
    }
  }
  return dailyIndex;
}

/**
 * 计算实际查询限制。
 * 当 topK 为有限数值时直接使用，否则回退到索引总量，避免查询时超限抛错。
 */
async function getQueryLimit(index: LocalIndex, topK: number): Promise<number> {
  if (Number.isFinite(topK)) {
    return topK;
  }

  const items = await index.listItems();
  return Math.max(items.length, 1);
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
 * 删除索引中所有与当前模型/dtype 不匹配的 stale 条目。
 * @returns 被删除条目对应的文件路径集合，用于触发重建
 */
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

/** 触发 root 与 daily 索引的懒初始化，清理 stale embedding，返回被清理影响的文件路径列表 */
export async function refreshStaleIndices(): Promise<string[]> {
  const [rootIdx, dailyIdx] = await Promise.all([
    getRootIndex(),
    getDailyIndex(),
  ]);
  const [rootStale, dailyStale] = await Promise.all([
    deleteStaleEmbeddings(rootIdx),
    deleteStaleEmbeddings(dailyIdx),
  ]);
  return [...rootStale, ...dailyStale];
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

/**
 * 基于 hash 对索引执行增量 upsert，被 upsertFile 和 ProjectStore.upsertFile 共用。
 *
 * 三步增量策略：
 * 1. 对已存在条目按 hash 建表，找出需要删除的条目（hash 不匹配或模型/dtype 已变更）
 * 2. 对 hash 表反向比对：存在于索引但不存在于新 chunks 中的条目标记删除
 * 3. 对新 chunks 中 hash 未命中已有索引的条目执行插入
 */
async function upsertChunks(
  index: LocalIndex,
  filePath: string,
  chunks: EmbeddedChunk[],
): Promise<void> {
  const existing = await index.listItems();
  // 已存在条目 hash → id 的映射，用于避免重复插入
  const existingByHash = new Map<string, string>();
  // 新 chunks 的 hash → chunk 映射
  const chunksByHash = new Map(
    chunks.map((chunk) => [chunk.metadata.hash, chunk]),
  );
  const toDelete: string[] = [];

  for (const item of existing) {
    if (item.metadata && String(item.metadata.filePath) === filePath) {
      const hash = item.metadata.hash ? String(item.metadata.hash) : null;
      if (hash) {
        const chunk = chunksByHash.get(hash);
        if (
          chunk &&
          // 同 hash 但 embedding 模型/dtype 已变更 → 需要重新嵌入
          (String(item.metadata.embeddingModel) !==
            chunk.metadata.embeddingModel ||
            String(item.metadata.embeddingDtype) !==
              chunk.metadata.embeddingDtype)
        ) {
          toDelete.push(String(item.id));
          continue;
        }
        // hash 匹配且 embedding 元数据一致 → 已存在，跳过插入
        existingByHash.set(hash, String(item.id));
      } else {
        // 旧数据没有 hash 字段 → 无法比对，删除重建
        toDelete.push(String(item.id));
      }
    }
  }

  // 第二步：新 chunks 的 hash 集合，用于反向删除已消失的条目
  const newHashes = new Set(chunks.map((c) => c.metadata.hash));

  for (const [hash, id] of existingByHash) {
    if (!newHashes.has(hash)) {
      toDelete.push(id);
    }
  }

  // 批量删除所有标记的条目
  for (const id of toDelete) {
    await index.deleteItem(id);
  }

  // 第三步：仅对 hash 表中不存在的 chunk 执行插入，实现增量
  for (const { vector, metadata } of chunks) {
    if (!existingByHash.has(metadata.hash)) {
      await index.insertItem({ vector, metadata });
    }
  }
}

/**
 * 对单个文件的切片集合执行增量 upsert。
 *
 * 策略：通过 hash 比对实现增量更新——仅插入新切片、删除已消失的切片、
 * 跳过内容未变的切片。避免全量重建索引，降低 token 消耗。
 *
 * @param filePath - 文件路径，用于判断归属 root 还是 daily 索引
 * @param chunks  - 该文件最新的切片集合
 */
export async function upsertFile(
  filePath: string,
  chunks: EmbeddedChunk[],
): Promise<void> {
  const index = filePath.includes("/daily/")
    ? await getDailyIndex()
    : await getRootIndex();
  await upsertChunks(index, filePath, chunks);
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

/** vectra queryItems 返回的原始条目结构，仅映射搜素需用字段 */
interface QuerySearchItem {
  score: number;
  item: { metadata: Record<string, unknown> };
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
 * 在 root 和 daily 两套索引中同时执行语义搜索，合并后按得分降序取 topK。
 *
 * 跨索引合并：先在每个索引获取 topK 条结果，过滤 stale 条目后合并排序，
 * 最后截断到 topK。这保证即使一个索引为空，另一个仍有结果。
 *
 * @param queryVector - 查询文本的嵌入向量
 * @param topK        - 返回结果上限（默认 20）
 * @returns 按相关度降序排列的搜索结果
 */
export async function semanticSearch(
  queryVector: number[],
  topK: number = 20,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  const rootIdx = await getRootIndex();
  const dailyIdx = await getDailyIndex();
  // 分别查询，避免一个索引为空时全部无结果
  const [rootTopK, dailyTopK] = await Promise.all([
    getQueryLimit(rootIdx, topK),
    getQueryLimit(dailyIdx, topK),
  ]);

  const [rootResults, dailyResults] = await Promise.all([
    rootIdx.queryItems(queryVector, "", rootTopK),
    dailyIdx.queryItems(queryVector, "", dailyTopK),
  ]);

  results.push(...filterCurrentSearchResults(rootResults as QuerySearchItem[]));
  results.push(
    ...filterCurrentSearchResults(dailyResults as QuerySearchItem[]),
  );

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * 从索引中删除指定文件的所有切片向量。
 * 用于文件被删除或移出 watch 范围时的清理。
 *
 * @param filePath - 目标文件路径
 */
export async function deleteFileVectors(filePath: string): Promise<void> {
  const index = filePath.includes("/daily/")
    ? await getDailyIndex()
    : await getRootIndex();
  const existing = await index.listItems();

  for (const item of existing) {
    if (item.metadata && String(item.metadata.filePath) === filePath) {
      await index.deleteItem(String(item.id));
    }
  }
}

/**
 * 项目级独立的向量存储。
 *
 * 与全局的 root/daily 分离，每个 ProjectStore 实例管理自己的 vectra 索引，
 * 用于项目特定的记忆持久化，生命周期与项目绑定。
 */
export class ProjectStore {
  private basePath: string;
  private rootIndex: LocalIndex | null = null;

  /**
   * @param basePath - 项目记忆目录路径，索引文件将创建在此目录下
   */
  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * 获取（或懒初始化）项目的 vectra 本地索引。
   * 索引文件存储在 basePath/root.index 中。
   */
  async getIndex(): Promise<LocalIndex> {
    if (!this.rootIndex) {
      const indexPath = path.join(this.basePath, "root.index");
      this.rootIndex = new LocalIndex(indexPath);
      if (!(await this.rootIndex.isIndexCreated())) {
        await this.rootIndex.createIndex();
      }
    }
    return this.rootIndex;
  }

  /**
   * 对项目中的单文件切片执行增量 upsert。
   * 委托给共享的 upsertChunks 逻辑。
   *
   * @param filePath - 文件路径
   * @param chunks   - 该文件最新的切片集合
   */
  async upsertFile(filePath: string, chunks: EmbeddedChunk[]): Promise<void> {
    const index = await this.getIndex();
    await upsertChunks(index, filePath, chunks);
  }

  /**
   * 在项目索引中执行语义搜索，按得分降序返回。
   *
   * @param queryVector - 查询嵌入向量
   * @param topK        - 返回结果上限
   * @returns 按相关度降序排列的搜索结果
   */
  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    const index = await this.getIndex();
    const limit = await getQueryLimit(index, topK);
    const items = await index.queryItems(queryVector, "", limit);
    return filterCurrentSearchResults(items as QuerySearchItem[]);
  }

  /** 检查项目索引中是否存在已索引的数据 */
  async checkExists(): Promise<boolean> {
    try {
      const index = await this.getIndex();
      const items = await index.listItems();
      return items.length > 0;
    } catch {
      return false;
    }
  }
}
