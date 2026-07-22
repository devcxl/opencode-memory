---
name: "LocalProvider 实现"
phase: 3
depends_on: ["T10"]
labels: ["backend"]
worktree_root: ".worktree/t11-local-provider/"
test_commands:
  - "bun test tests/high-risk.test.ts"
  - "pnpm exec tsc --noEmit"
verify_commands:
  - "bun test"
  - "pnpm exec tsc --noEmit"
tdd:
  mode: strict
  min_cycles: 2
acceptance:
  - criteria: "LocalVectorIndexProvider 包装 vectra LocalIndex，upsert/search/delete 行为与原一致"
    verification_type: test
    test_command: "bun test"
  - criteria: "LocalEmbeddingProvider 包装 huggingface pipeline，embedTexts 返回与原 embedText 一致的向量"
    verification_type: test
    test_command: "bun test"
  - criteria: "LocalFileStorageProvider 包装 fs，readFile/writeFile/appendFile/deleteFile/exists/listFiles 行为与原一致"
    verification_type: test
    test_command: "bun test"
  - criteria: "createProviders('local', config) 返回完整的本地 Provider 实例"
    verification_type: test
    test_command: "bun test"
  - criteria: "现有测试（high-risk.test.ts）通过，无行为回归"
    verification_type: test
    test_command: "bun test tests/high-risk.test.ts"
---

# T11: LocalProvider 实现

**阶段**：Phase 3 — 插件双模式
**依赖**：T10（Provider 接口定义）
**标签**：`backend`
**预估**：2h

## 目标

将现有的 vectra + huggingface + fs 逻辑包装为三个 `Local*Provider` 类，实现 T10 定义的接口，确保现有功能零行为变化。

## 背景

这是 Provider 重构的核心任务。现有 `MemoryManager` 的向量索引、嵌入推理、文件读写逻辑分散在 `src/search/` 和自身方法中，需要提取为独立的 Provider 类。目标是在不改变行为的前提下完成架构解耦。

## 实现步骤

### 1. 创建 `src/providers/local/LocalVectorIndexProvider.ts`

包装 `src/search/vector-store.ts` 的函数：

```typescript
import type { IVectorIndexProvider, EmbeddedChunk, VectorSearchResult, EmbeddingMetadata } from "../types.js";
import { upsertFile, semanticSearch, deleteFileVectors, refreshStaleIndices, type ProjectStore } from "../../search/vector-store.js";

export class LocalVectorIndexProvider implements IVectorIndexProvider {
  constructor(private memoryDir: string) {}

  async upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void> {
    // namespace = "root" | "daily" | "project/{id}"
    // 委托给现有 upsertFile 逻辑
  }

  async search(vector: number[], topK: number, namespace: string): Promise<VectorSearchResult[]> {
    // 委托给现有 semanticSearch
  }

  async delete(ids: string[], namespace: string): Promise<void> {
    // 委托给现有 deleteFileVectors
  }

  async isStale(metadata: EmbeddingMetadata): Promise<boolean> {
    return !isCurrentEmbeddingMetadata(metadata);
  }
}
```

**关键设计**：
- namespace 映射：`"root"` → 全局 root 索引，`"daily"` → 全局 daily 索引，`"project/{id}"` → 项目索引
- head `upsertFile` 和 `semanticSearch` 内部已处理 namespace 路由，只需正确传参

### 2. 创建 `src/providers/local/LocalEmbeddingProvider.ts`

包装 `src/search/embedding.ts`：

```typescript
import type { IEmbeddingProvider } from "../types.js";
import { embedText, getCurrentModelId, getCurrentDtype } from "../../search/embedding.js";

export class LocalEmbeddingProvider implements IEmbeddingProvider {
  readonly dimensions = 768;  // 与当前模型一致（nomic-embed-text-v1.5）
  readonly modelId: string;

  constructor() {
    this.modelId = getCurrentModelId();
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    // 当前 embedText 是单文本接口，升级为批量
    return Promise.all(texts.map((t) => embedText(t)));
  }
}
```

### 3. 创建 `src/providers/local/LocalFileStorageProvider.ts`

提取 `MemoryManager` 的 fs 操作：

```typescript
import type { IFileStorageProvider } from "../types.js";
import * as fs from "node:fs";
import { readFileSafe, ensureDir } from "../../utils/fs.js";
import { atomicWrite } from "../../utils/atomicWrite.js";

export class LocalFileStorageProvider implements IFileStorageProvider {
  constructor(private memoryDir: string) {}

  async readFile(path: string): Promise<string | null> {
    return readFileSafe(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    atomicWrite(path, content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    const existing = await this.readFile(path);
    const separator = existing?.trim() ? "\n\n" : "";
    const newContent = (existing ?? "") + separator + content;
    atomicWrite(path, newContent);
  }

  async deleteFile(path: string): Promise<void> {
    try { fs.unlinkSync(path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    return fs.existsSync(path);
  }

  async listFiles(pattern: string): Promise<string[]> {
    // ... 基于 glob 或 readdir 实现
    return [];
  }
}
```

### 4. 创建 `src/providers/local/index.ts`

集中导出三个 Provider：

```typescript
export { LocalVectorIndexProvider } from "./VectorIndexProvider.js";
export { LocalEmbeddingProvider } from "./EmbeddingProvider.js";
export { LocalFileStorageProvider } from "./FileStorageProvider.js";
```

### 5. 更新 `factory.ts`

取消 T10 中 local 分支的注释，连接实际实现。

### 6. 验证

```bash
bun test                          # 全量回归
bun test tests/high-risk.test.ts  # 高风险回归
pnpm exec tsc --noEmit            # 类型检查
```

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `src/providers/local/VectorIndexProvider.ts` |
| 🆕 新增 | `src/providers/local/EmbeddingProvider.ts` |
| 🆕 新增 | `src/providers/local/FileStorageProvider.ts` |
| 🆕 新增 | `src/providers/local/index.ts` |
| ✏️ 修改 | `src/providers/factory.ts`（取消注释 local 分支） |

## 注意事项

- **零行为变更原则**：LocalProvider 的每个方法输出必须与原有实现完全一致。如果旧代码有 bug，保留不修（T11 不是修 bug 的任务）
- **LocalFileStorageProvider.appendFile**：不需要自动添加时间戳 — 时间戳逻辑属于 `MemoryManager`（业务层），不属于存储层
- **vectra 的 ProjectStore 管理**：`LocalVectorIndexProvider` 中 project namespace 的管理可以保留在 `MemoryManager` 层（通过 `getProjectStore`），也可以内化到 Provider。推荐保留在 `MemoryManager` 以减少改动范围
- 如果现有 `embedText` 函数内部有 pipeline 初始化延迟逻辑，`LocalEmbeddingProvider` 需要正确处理
