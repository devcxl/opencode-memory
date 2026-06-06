process.env.TRANSFORMERS_VERBOSITY = "error";
process.env.ORT_LOGGING_LEVEL = "error";

import { pipeline } from "@huggingface/transformers";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EMBEDDING_MODEL as MODEL,
  EMBEDDING_DTYPE as DTYPE,
} from "../config/embedding.js";

// ─── 缓存管理 ────────────────────────────────────────────────

function getModelCachePath(): string {
  const pluginDir = path.dirname(path.dirname(__dirname));
  return path.join(
    pluginDir,
    "node_modules",
    "@huggingface",
    "transformers",
    ".cache",
  );
}

function isModelCacheValid(): boolean {
  const cachePath = getModelCachePath();
  const modelPath = path.join(
    cachePath,
    MODEL.org,
    MODEL.repo,
    "onnx",
    "model.onnx",
  );

  if (!fs.existsSync(modelPath)) {
    return false;
  }

  const stat = fs.statSync(modelPath);
  if (stat.size < 1000000) {
    return false;
  }

  return true;
}

function clearModelCache(): void {
  try {
    const cachePath = getModelCachePath();
    const modelPath = path.join(cachePath, MODEL.org, MODEL.repo);

    if (fs.existsSync(modelPath)) {
      fs.rmSync(modelPath, { recursive: true, force: true });
    }
  } catch {}
}

// ─── 单例 pipeline ───────────────────────────────────────────

let embedder: any = null;
let initPromise: Promise<void> | null = null;

/**
 * 初始化嵌入模型 pipeline。
 * 使用单例模式确保模型只加载一次，首次调用前检查缓存有效性，
 * 若模型文件损坏则自动清缓存重试。
 */
export async function initEmbedder(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      let retries = 0;
      const maxRetries = 2;

      while (retries <= maxRetries) {
        try {
          if (!isModelCacheValid()) {
            clearModelCache();
          }

          embedder = await pipeline("feature-extraction", MODEL.modelId, {
            dtype: DTYPE,
          });
          return;
        } catch (err) {
          const errMsg = (err as Error).message;
          if (
            errMsg.includes("Protobuf parsing failed") ||
            errMsg.includes("corrupt")
          ) {
            clearModelCache();
            retries++;
            if (retries > maxRetries) {
              throw new Error(
                `Failed to load embedding model after ${maxRetries} retries. ` +
                  `Model cache may be corrupted. Try: rm -rf node_modules/@huggingface/transformers/.cache`,
              );
            }
            continue;
          }
          throw err;
        }
      }
    })();
  }
  await initPromise;
}

/**
 * 获取已初始化的 embedder 实例。
 * 未初始化时自动触发 initEmbedder 初始化。
 */
export async function getEmbedder(): Promise<any> {
  if (!embedder) {
    await initEmbedder();
  }
  return embedder;
}

/**
 * 对单段文本执行向量化，返回归一化后的嵌入向量。
 * 使用 mean pooling + L2 normalize 确保余弦相似度一致性。
 *
 * @param text - 待编码文本
 * @returns 浮点数向量数组
 */
export async function embedText(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data) as number[];
}

/** 检查 embedder 是否已完成初始化 */
export async function isInitialized(): Promise<boolean> {
  return embedder !== null;
}

/** 获取当前模型的向量维度 */
export function getEmbeddingDimensions(): number {
  return MODEL.dimensions;
}

/** 获取当前模型 ID（用于日志/调试） */
export function getCurrentModelId(): string {
  return MODEL.modelId;
}

/** 获取当前模型 dtype（用于索引失效判断） */
export function getCurrentDtype(): string {
  return DTYPE;
}
