import type { IEmbeddingProvider } from "../types.js";
import {
  embedText,
  getCurrentModelId,
  getEmbeddingDimensions,
} from "../../search/embedding.js";

/**
 * 本地 HuggingFace Transformers 嵌入推理 Provider。
 *
 * 包装现有的 embedText() 单文本接口，对外提供批量 embedTexts。
 * pipeline 的懒加载和初始化由底层 embedText() 内部处理。
 */
export class LocalEmbeddingProvider implements IEmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  constructor() {
    this.modelId = getCurrentModelId();
    this.dimensions = getEmbeddingDimensions();
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => embedText(text)));
  }
}
