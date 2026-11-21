import { chunkMarkdown } from "./chunker.js";
import { embedText, getCurrentDtype, getCurrentModelId } from "./embedding.js";
import type { VectorStore } from "./vector-store.js";

/**
 * 将 Markdown 文件切片、先比对已有索引 Hash 再按需向量化并增量更新至 VectorStore。
 * 若本地 embedding 引擎尚未初始化则静默跳过，不阻塞调用方。
 */
export async function indexFileIncrementally(
  filePath: string,
  content: string,
  vectorStore: VectorStore,
): Promise<void> {
  try {
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
  } catch (err) {
    const errMsg = (err as Error).message;
    if (!errMsg.includes("not initialized")) {
      throw err;
    }
  }
}
