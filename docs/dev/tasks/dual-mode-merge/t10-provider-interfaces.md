---
name: "Provider 接口定义"
phase: 3
depends_on: ["T4", "T6"]
labels: ["backend"]
worktree_root: ".worktree/t10-provider-interfaces/"
test_commands:
  - "pnpm exec tsc --noEmit"
verify_commands:
  - "pnpm exec tsc --noEmit"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "IVectorIndexProvider 接口包含 upsert, search, delete, isStale 方法签名"
    verification_type: test
    test_command: "pnpm exec tsc --noEmit"
  - criteria: "IEmbeddingProvider 接口包含 embedTexts, dimensions, modelId 签名"
    verification_type: test
    test_command: "pnpm exec tsc --noEmit"
  - criteria: "IFileStorageProvider 接口包含 readFile, writeFile, appendFile, deleteFile, exists, listFiles 签名"
    verification_type: test
    test_command: "pnpm exec tsc --noEmit"
  - criteria: "factory.ts 导出 createProviders(mode, config) 函数签名"
    verification_type: test
    test_command: "pnpm exec tsc --noEmit"
  - criteria: "所有接口和类型从 src/providers/types.ts 集中导出"
    verification_type: manual
---

# T10: Provider 接口定义

**阶段**：Phase 3 — 插件双模式
**依赖**：T4（shared 迁入）, T6（tsconfig 统一）
**标签**：`backend`
**预估**：1h

## 目标

定义 Provider 抽象层的三个核心接口和工厂函数签名，为 LocalProvider（T11）和 RemoteProvider（T12）提供统一的类型契约。

## 背景

ADM-003 确认使用 3 个接口（`IVectorIndexProvider`、`IEmbeddingProvider`、`IFileStorageProvider`）而非 2 个或 4 个。接口定义放在 `src/providers/types.ts`，工厂函数放在 `src/providers/factory.ts`。

## 实现步骤

### 1. 创建 `src/providers/types.ts`

```typescript
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
  search(vector: number[], topK: number, namespace: string): Promise<VectorSearchResult[]>;
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
```

### 2. 创建 `src/providers/factory.ts`

```typescript
import type { MemoryConfig } from "../config/runtime.js";
import type { IVectorIndexProvider, IEmbeddingProvider, IFileStorageProvider } from "./types.js";

export interface Providers {
  vectorIndex: IVectorIndexProvider;
  embedding: IEmbeddingProvider;
  fileStorage: IFileStorageProvider;
}

export type MemoryMode = "local" | "remote";

/**
 * 按运行模式和配置创建对应的 Provider 实例。
 * 使用动态 import() 实现按需加载：
 * - local 模式：加载 vectra + huggingface
 * - remote 模式：加载 HTTP client（不加载重型依赖）
 */
export async function createProviders(
  mode: MemoryMode,
  config: MemoryConfig,
): Promise<Providers> {
  // T11 完成后取消注释 local 分支，T12 完成后取消注释 remote 分支
  if (mode === "local") {
    const { LocalVectorIndexProvider } = await import("./local/VectorIndexProvider.js");
    const { LocalEmbeddingProvider } = await import("./local/EmbeddingProvider.js");
    const { LocalFileStorageProvider } = await import("./local/FileStorageProvider.js");
    return {
      vectorIndex: new LocalVectorIndexProvider(config),
      embedding: new LocalEmbeddingProvider(),
      fileStorage: new LocalFileStorageProvider(config),
    };
  }

  // remote 模式
  const { RemoteVectorIndexProvider } = await import("./remote/VectorIndexProvider.js");
  const { RemoteEmbeddingProvider } = await import("./remote/EmbeddingProvider.js");
  const { RemoteFileStorageProvider } = await import("./remote/FileStorageProvider.js");
  return {
    vectorIndex: new RemoteVectorIndexProvider(config),
    embedding: new RemoteEmbeddingProvider(config),
    fileStorage: new RemoteFileStorageProvider(config),
  };
}
```

### 3. 验证

```bash
pnpm exec tsc --noEmit
```

确保接口定义文件编译通过，无类型错误。

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `src/providers/types.ts` |
| 🆕 新增 | `src/providers/factory.ts` |

## 注意事项

- 接口定义需要对齐现有的 vectra 函数签名（`upsertFile`、`semanticSearch`、`deleteFileVectors`）和 huggingface `embedText`
- `IVectorIndexProvider.search` 返回 `VectorSearchResult`，需要与现有 `SemanticSearchResult` 兼容
- `IFileStorageProvider` 的 path 参数：local 模式为文件系统路径，remote 模式为 `"file_type:date:project_id"` 映射字符串
- `IEmbeddingProvider.embedTexts` 设计为批量接口（数组输入），支持一次嵌入多个文本切片
- 工厂函数中的 `import()` 路径使用 `.js` 扩展名（ESM 要求）
