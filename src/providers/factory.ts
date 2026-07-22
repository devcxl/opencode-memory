import type { MemoryConfig } from "../config/runtime.js";
import type {
  IVectorIndexProvider,
  IEmbeddingProvider,
  IFileStorageProvider,
} from "./types.js";

export interface Providers {
  vectorIndex: IVectorIndexProvider;
  embedding: IEmbeddingProvider;
  fileStorage: IFileStorageProvider;
}

export type MemoryMode = "local" | "remote";

/**
 * 按运行模式和配置创建对应的 Provider 实例。
 * 使用动态 import() 实现按需加载：
 * - local 模式：加载 vectra + huggingface（重型依赖）
 * - remote 模式：加载 HTTP client（不加载重型依赖）
 */
export async function createProviders(
  mode: MemoryMode,
  config: MemoryConfig,
): Promise<Providers> {
  if (mode === "local") {
    const [
      { LocalVectorIndexProvider },
      { LocalEmbeddingProvider },
      { LocalFileStorageProvider },
    ] = await Promise.all([
      import("./local/VectorIndexProvider.js"),
      import("./local/EmbeddingProvider.js"),
      import("./local/FileStorageProvider.js"),
    ]);
    return {
      vectorIndex: new LocalVectorIndexProvider(config),
      embedding: new LocalEmbeddingProvider(),
      fileStorage: new LocalFileStorageProvider(config),
    };
  }

  // remote 模式
  const remoteConfig = config.remote ?? { apiUrl: "", apiKey: "" };

  const [
    { RemoteVectorIndexProvider },
    { RemoteEmbeddingProvider },
    { RemoteFileStorageProvider },
  ] = await Promise.all([
    import("./remote/VectorIndexProvider.js"),
    import("./remote/EmbeddingProvider.js"),
    import("./remote/FileStorageProvider.js"),
  ]);
  return {
    vectorIndex: new RemoteVectorIndexProvider(remoteConfig),
    embedding: new RemoteEmbeddingProvider(remoteConfig),
    fileStorage: new RemoteFileStorageProvider(remoteConfig),
  };
}
