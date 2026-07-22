import type { IEmbeddingProvider } from "../types.js";
import type { RemoteConfig } from "./http-client.js";

/**
 * Remote 模式 EmbeddingProvider。
 * embedding 推理在 Worker 端执行（Workers AI），本地不做模型加载。
 * embedTexts() 在 remote 模式下不应被调用 —
 * FileSearcher 改造后会在 remote 模式下跳过本地 embedding，直接调 Worker API。
 */
export class RemoteEmbeddingProvider implements IEmbeddingProvider {
  readonly dimensions = 1024; // Qwen3-Embedding-0.6B (bge-m3 备选)
  readonly modelId = "@cf/qwen/qwen3-embedding-0.6b";

  constructor(_config: RemoteConfig) {}

  async embedTexts(_texts: string[]): Promise<number[][]> {
    throw new Error(
      "Remote mode: embedding is performed on the Worker side during search.",
    );
  }
}
