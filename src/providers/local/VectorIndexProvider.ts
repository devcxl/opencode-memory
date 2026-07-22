import type { IVectorIndexProvider, EmbeddedChunk, VectorSearchResult, EmbeddingMetadata } from "../types.js";
import type { MemoryConfig } from "../../config/runtime.js";
import * as path from "node:path";
import { MemoryPaths } from "../../memory/MemoryPaths.js";
import { upsertFile, semanticSearch, deleteFileVectors, ProjectStore, isCurrentEmbeddingMetadata } from "../../search/vector-store.js";

/**
 * 本地 vectra 向量索引 Provider。
 *
 * 将现有的 root/daily/项目三级索引逻辑包装为统一接口。
 * namespace 映射规则：
 * - "root" → 全局 root 索引
 * - "daily" → 全局 daily 索引
 * - "project/{id}" → 项目独立索引（ProjectStore）
 */
export class LocalVectorIndexProvider implements IVectorIndexProvider {
  private paths: MemoryPaths;
  private projectStores = new Map<string, ProjectStore>();

  constructor(config: MemoryConfig) {
    this.paths = new MemoryPaths(config.memoryDir);
  }

  async upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void> {
    if (chunks.length === 0) return;
    const filePath = chunks[0].metadata.filePath;

    if (namespace.startsWith("project/")) {
      const projectId = namespace.slice("project/".length);
      const store = this.getProjectStore(projectId);
      // provider 的 ChunkMetadata 与 vector-store 的 Record<string,string> 结构兼容
      await store.upsertFile(filePath, chunks as any);
      return;
    }

    await upsertFile(filePath, chunks as any);
  }

  async search(
    vector: number[],
    topK: number,
    namespace: string,
  ): Promise<VectorSearchResult[]> {
    if (namespace.startsWith("project/")) {
      const projectId = namespace.slice("project/".length);
      const store = this.getProjectStore(projectId);
      return store.search(vector, topK);
    }

    // 全局搜索覆盖 root + daily，按 namespace 在结果层过滤
    const results = await semanticSearch(
      vector,
      namespace === "daily" ? topK * 2 : topK,
    );

    if (namespace === "root") {
      return results
        .filter((r) => !r.filePath.includes(`${path.sep}daily${path.sep}`))
        .slice(0, topK);
    }
    if (namespace === "daily") {
      return results
        .filter((r) => r.filePath.includes(`${path.sep}daily${path.sep}`))
        .slice(0, topK);
    }
    return results.slice(0, topK);
  }

  async delete(ids: string[], namespace: string): Promise<void> {
    if (namespace.startsWith("project/")) {
      const projectId = namespace.slice("project/".length);
      const store = this.getProjectStore(projectId);
      const index = await store.getIndex();
      const items = await index.listItems();
      const idSet = new Set(ids);
      for (const item of items) {
        if (idSet.has(String(item.metadata?.filePath ?? ""))) {
          await index.deleteItem(String(item.id));
        }
      }
      return;
    }

    for (const filePath of ids) {
      await deleteFileVectors(filePath);
    }
  }

  async isStale(metadata: EmbeddingMetadata): Promise<boolean> {
    return !isCurrentEmbeddingMetadata({
      embeddingModel: metadata.model,
      embeddingDtype: metadata.dtype,
    });
  }

  private getProjectStore(projectId: string): ProjectStore {
    if (!this.projectStores.has(projectId)) {
      this.projectStores.set(
        projectId,
        new ProjectStore(this.paths.projectDir(projectId)),
      );
    }
    return this.projectStores.get(projectId)!;
  }
}
