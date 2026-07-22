import type {
  IVectorIndexProvider,
  EmbeddedChunk,
  VectorSearchResult,
} from "../types.js";
import { MemoryClient, type RemoteConfig } from "./http-client.js";

/**
 * Remote 模式 VectorIndexProvider。
 * Worker 端自己做 embedding + 向量索引，客户端只负责 HTTP 通信。
 *
 * - upsert: 远程模式下不批量操作（由 FileStorage.appendFile 逐个触发 Worker 端索引）
 * - search: 直接调 Worker api/memories/search，传 query 文本（非向量）
 * - delete: 调 Worker api/memories/:id 逐条删除
 */
export class RemoteVectorIndexProvider implements IVectorIndexProvider {
  private client: MemoryClient;

  constructor(config: RemoteConfig) {
    this.client = new MemoryClient(config);
  }

  /** 批量 upsert — remote 下暂不实现（由 writeFile 触发 Worker 端索引） */
  async upsert(_chunks: EmbeddedChunk[], _namespace: string): Promise<void> {
    // no-op: 每个 writeFile 调用会触发 Worker 端的 D1 写入 + Vectorize 索引
  }

  /**
   * remote 模式下搜索不走 embed → search 两段式。
   * 直接将原始 query 文本传给 Worker /api/memories/search，
   * Worker 端负责 embedding + 向量检索 + 关键词检索 + RRF 融合。
   *
   * @param _vector - 忽略，remote 下不使用本地向量
   * @param topK - 返回结果数
   * @param _namespace - 命名空间，格式 "project:owner/repo" 或 "global"
   */
  async search(
    _vector: number[],
    topK: number,
    _namespace: string,
  ): Promise<VectorSearchResult[]> {
    // 从 namespace 解析 project_id
    const projectId = _namespace.startsWith("project:")
      ? _namespace.slice("project:".length)
      : undefined;

    const records = await this.client.search({
      query: "", // TODO: 此方法需要调用方传入 query text，暂时通过 FileSearcher 改造后直接使用 FileStorageProvider.search
      topK,
      kind: "long",
      project_id: projectId,
    });

    return records.map((r) => ({
      score: r.score ?? 0,
      filePath: r.id,
      heading: "",
      text: r.text,
      timestamp: new Date(r.created_at).toISOString(),
    }));
  }

  async delete(ids: string[], _namespace: string): Promise<void> {
    for (const id of ids) {
      await this.client.delete(id);
    }
  }
}
