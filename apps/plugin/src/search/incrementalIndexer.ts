import { chunkMarkdown } from "./chunker.js";
import {
  embedText,
  getCurrentDtype,
  getCurrentModelId,
  isEmbedderReady,
} from "./embedding.js";
import type { VectorStore } from "./vector-store.js";

/**
 * 将 Markdown 文件切片、先比对已有索引 Hash 再按需向量化并增量更新至 VectorStore。
 *
 * 若 embedding 引擎尚未初始化则直接跳过：索引是可重建的派生数据，写入路径不应
 * 为它承担首次模型下载/加载的开销。跳过后的文件会在后续检索（`embedText` 触发
 * 初始化）或下次写入时补齐。
 */
export async function indexFileIncrementally(
  filePath: string,
  content: string,
  vectorStore: VectorStore,
): Promise<void> {
  if (!isEmbedderReady()) {
    return;
  }

  const chunks = chunkMarkdown(content, filePath);
  const embeddingModel = getCurrentModelId();
  const embeddingDtype = getCurrentDtype();

  const existingHashes = await vectorStore.getExistingChunkHashes(filePath);
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
    await vectorStore.upsertFile(
      filePath,
      embedded,
      preservedHashes.size > 0 ? preservedHashes : undefined,
    );
  }
}
