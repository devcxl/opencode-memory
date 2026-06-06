import {
  getPluginConfigOption,
  isZhLocale,
  isDebugEnabled,
} from "./runtime.js";

function debugLog(message: string): void {
  if (isDebugEnabled()) {
    console.error(message);
  }
}

// ─── 模型配置类型 ──────────────────────────────────────────────

export interface EmbeddingModelConfig {
  modelId: string;
  dimensions: number;
  org: string;
  repo: string;
}

export type QuantizationDtype =
  | "fp32"
  | "fp16"
  | "q8"
  | "q4"
  | "int8"
  | "uint8";

export const VALID_DTYPES: Set<string> = new Set([
  "fp32",
  "fp16",
  "q8",
  "q4",
  "int8",
  "uint8",
]);

export const MODEL_PRESETS: Record<string, EmbeddingModelConfig> = {
  "nomic-embed-text-v1.5": {
    modelId: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: 768,
    org: "nomic-ai",
    repo: "nomic-embed-text-v1.5",
  },
  "jina-embeddings-v2-base-zh": {
    modelId: "Xenova/jina-embeddings-v2-base-zh",
    dimensions: 768,
    org: "Xenova",
    repo: "jina-embeddings-v2-base-zh",
  },
};

// ─── 模型选择策略 ────────────────────────────────────────────

export function resolveModel(
  getPluginConfig: (key: string) => string | undefined,
  zhLocale: boolean,
): EmbeddingModelConfig {
  // L1: opencode.json 插件配置（最高优先级）
  const configModel = getPluginConfig("embeddingModel");
  if (configModel) {
    const preset = MODEL_PRESETS[configModel];
    if (preset) {
      debugLog(
        `[opencode-memory] Using embedding model: ${preset.modelId} (via opencode.json)`,
      );
      return preset;
    }
    debugLog(
      `[opencode-memory] Unknown embedding model in opencode.json: "${configModel}", falling back`,
    );
  }

  // L2: 系统 locale 自动检测
  if (zhLocale) {
    const preset = MODEL_PRESETS["jina-embeddings-v2-base-zh"];
    debugLog(
      `[opencode-memory] Using embedding model: ${preset.modelId} (auto-detected zh locale)`,
    );
    return preset;
  }

  // L3: OPM_EMBEDDING_MODEL 环境变量
  const envModel = process.env.OPM_EMBEDDING_MODEL;
  if (envModel) {
    const preset = MODEL_PRESETS[envModel];
    if (preset) {
      debugLog(
        `[opencode-memory] Using embedding model: ${preset.modelId} (via OPM_EMBEDDING_MODEL)`,
      );
      return preset;
    }
    debugLog(
      `[opencode-memory] Unknown OPM_EMBEDDING_MODEL: "${envModel}", falling back`,
    );
  }

  // 默认
  const preset = MODEL_PRESETS["nomic-embed-text-v1.5"];
  debugLog(
    `[opencode-memory] Using embedding model: ${preset.modelId} (default)`,
  );
  return preset;
}

export function resolveDtype(
  getPluginConfig: (key: string) => string | undefined,
): QuantizationDtype {
  // L1: opencode.json 插件配置
  const configDtype = getPluginConfig("dtype");
  if (configDtype && VALID_DTYPES.has(configDtype)) {
    debugLog(
      `[opencode-memory] Using dtype: ${configDtype} (via opencode.json)`,
    );
    return configDtype as QuantizationDtype;
  }
  if (configDtype) {
    debugLog(
      `[opencode-memory] Unknown dtype in opencode.json: "${configDtype}", falling back`,
    );
  }

  // L2: OPM_EMBEDDING_DTYPE 环境变量
  const envDtype = process.env.OPM_EMBEDDING_DTYPE;
  if (envDtype && VALID_DTYPES.has(envDtype)) {
    debugLog(
      `[opencode-memory] Using dtype: ${envDtype} (via OPM_EMBEDDING_DTYPE)`,
    );
    return envDtype as QuantizationDtype;
  }
  if (envDtype) {
    debugLog(
      `[opencode-memory] Unknown OPM_EMBEDDING_DTYPE: "${envDtype}", falling back`,
    );
  }

  return "fp32";
}

// ─── 模块级常量（import-time 解析） ────────────────────────────

export const EMBEDDING_MODEL = resolveModel(
  getPluginConfigOption,
  isZhLocale(),
);
export const EMBEDDING_DTYPE = resolveDtype(getPluginConfigOption);
