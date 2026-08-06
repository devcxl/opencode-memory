// ─── 基础类型 ───────────────────────────────────────────

/** 嵌入后的文本切片 */
export interface EmbeddedChunk {
  vector: number[];
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  filePath: string;
  heading: string;
  text: string;
  hash: string;
  embeddingModel: string;
  embeddingDtype: string;
  timestamp?: string;
}

export interface EmbeddingMetadata {
  model: string;
  dtype: string;
}

/** 向量搜索结果 */
export interface VectorSearchResult {
  score: number;
  filePath: string;
  heading: string;
  text: string;
  timestamp?: string;
}

// ─── Provider 接口 ──────────────────────────────────────

/** 向量索引操作 */
export interface IVectorIndexProvider {
  upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void>;
  search(
    vector: number[],
    topK: number,
    namespace: string,
  ): Promise<VectorSearchResult[]>;
  delete(ids: string[], namespace: string): Promise<void>;
  isStale?(metadata: EmbeddingMetadata): Promise<boolean>;
  clearNamespace?(namespace: string): Promise<void>;
}

/** 文本嵌入推理 */
export interface IEmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

/** 文件级读写 */
export interface IFileStorageProvider {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(pattern: string): Promise<string[]>;
}
