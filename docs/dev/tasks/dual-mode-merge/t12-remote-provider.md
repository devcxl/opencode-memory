---
name: "RemoteProvider 实现"
phase: 3
depends_on: ["T10", "T8"]
labels: ["backend"]
worktree_root: ".worktree/t12-remote-provider/"
test_commands:
  - "pnpm exec tsc --noEmit"
verify_commands:
  - "pnpm exec tsc --noEmit"
  - "bun test tests/remote-providers.test.ts"
tdd:
  mode: strict
  min_cycles: 2
acceptance:
  - criteria: "RemoteVectorIndexProvider.search 调用 POST /api/memories/search"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "RemoteFileStorageProvider.writeFile/appendFile 调用 POST /api/memories"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "RemoteFileStorageProvider.readFile 调用 GET /api/memories 并正确拼接结果"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "RemoteFileStorageProvider.deleteFile 调用 DELETE /api/memories/:id"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "401/429/500 错误场景有正确处理"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
  - criteria: "JWT Bearer token 正确附加到 Authorization header"
    verification_type: test
    test_command: "bun test tests/remote-providers.test.ts"
---

# T12: RemoteProvider 实现

**阶段**：Phase 3 — 插件双模式
**依赖**：T10（Provider 接口定义）, T8（Worker API 扩展）
**标签**：`backend`
**预估**：2h

## 目标

实现三个 RemoteProvider 类，通过 HTTP client 直调 Worker REST API，并编写 mock 单元测试。

## 背景

remote 模式下，插件不加载 vectra/huggingface 等重型依赖，所有操作通过 HTTP 请求完成。ADM-002 确认直调 REST API（废弃 MCP 协议），ADM-005 确认通过动态 import 避免加载重型依赖。

## 实现步骤

### 1. 创建 `src/providers/remote/http-client.ts`

通用 HTTP 客户端，处理 JWT 认证、错误处理和重试：

```typescript
export interface RemoteConfig {
  apiUrl: string;
  apiKey: string;
}

export class MemoryApiClient {
  constructor(private config: RemoteConfig) {}

  private get headers(): HeadersInit {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res);
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.config.apiUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
    }
    const res = await fetch(url.toString(), { headers: this.headers });
    return this.handleResponse<T>(res);
  }

  async del(path: string): Promise<void> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    await this.handleResponse(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Worker API error ${res.status}: ${body.error || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }
}
```

### 2. 创建 `src/providers/remote/VectorIndexProvider.ts`

```typescript
import type { IVectorIndexProvider, EmbeddedChunk, VectorSearchResult } from "../types.js";
import { MemoryApiClient, type RemoteConfig } from "./http-client.js";

export class RemoteVectorIndexProvider implements IVectorIndexProvider {
  private client: MemoryApiClient;

  constructor(config: RemoteConfig) {
    this.client = new MemoryApiClient(config);
  }

  async upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void> {
    // remote 模式下 upsert 由 FileStorage.appendFile 触发（Worker 侧自动索引）
    // 此方法为批量场景预留，暂不实现（可选：遍历 chunks 逐个调用 POST /api/memories）
  }

  async search(vector: number[], topK: number, namespace: string): Promise<VectorSearchResult[]> {
    // 注意：Worker API search 接收 query 文本而非 vector
    // 此处设计为接收 vector 但不直接传递 — 实际调用链由 FileSearcher 在 remote 模式下跳过 embedText
    // 详见技术方案 §5.1 的方案 A
    throw new Error('Remote mode: use FileSearcher.searchRemote() instead. This method is not called directly.');
  }

  async delete(ids: string[], namespace: string): Promise<void> {
    for (const id of ids) {
      await this.client.del(`/api/memories/${id}`);
    }
  }
}
```

**重要设计决策**：`IVectorIndexProvider.search(vector)` 在 remote 模式下不被调用。remote 模式的搜索由 `FileSearcher.semanticSearch()` 在 T13 中改造，跳过本地 embedding 步骤，直接通过 HTTP client 调用 Worker `/api/memories/search`。因此 `RemoteVectorIndexProvider.search` 可以 throw 或返回空。

### 3. 创建 `src/providers/remote/EmbeddingProvider.ts`

```typescript
import type { IEmbeddingProvider } from "../types.js";
import type { RemoteConfig } from "./http-client.js";

export class RemoteEmbeddingProvider implements IEmbeddingProvider {
  readonly dimensions = 1024;  // Qwen3-Embedding-0.6B
  readonly modelId = '@cf/qwen/qwen3-embedding-0.6b';

  constructor(private config: RemoteConfig) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    // remote 模式下 embedding 在 Worker 侧执行
    // 此方法不被调用（FileSearcher 在 remote 模式下跳过 embedText 步骤）
    throw new Error('Remote mode: embedding is performed on the Worker side during search.');
  }
}
```

### 4. 创建 `src/providers/remote/FileStorageProvider.ts`

核心实现，负责所有 memory 数据的 CRUD 和搜索：

```typescript
import type { IFileStorageProvider } from "../types.js";
import { MemoryApiClient, type RemoteConfig } from "./http-client.js";

export class RemoteFileStorageProvider implements IFileStorageProvider {
  private client: MemoryApiClient;

  constructor(private config: RemoteConfig) {
    this.client = new MemoryApiClient(config);
  }

  // path 格式："file_type:date:project_id"
  private parsePath(p: string): { file_type: string; date: string; project_id: string } {
    const [file_type = '', date = '', project_id = ''] = p.split(':');
    return { file_type, date, project_id };
  }

  async readFile(path: string): Promise<string | null> {
    const { file_type, date, project_id } = this.parsePath(path);

    const result = await this.client.get<ApiResponse<Memory[]>>('/api/memories', {
      file_type,
      project_id,
      date,
      kind: 'long',
      limit: '100',
    });

    if (!result.success || !result.data?.length) return null;

    // 拼接为类文件格式（与 local 模式输出一致）
    return result.data
      .map((m: { created_at: number; text: string }) => {
        const ts = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 19);
        return `<!-- ${ts} -->\n${m.text}`;
      })
      .join('\n\n');
  }

  async appendFile(path: string, content: string): Promise<void> {
    const { file_type, date, project_id } = this.parsePath(path);

    await this.client.post('/api/memories', {
      text: content,
      kind: 'long',
      file_type,
      project_id,
      date,
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    // remote 模式下 write 等同于 append + 清除旧数据
    // 简化实现：先删除旧数据，再写入新数据
    // 注意：批量删除不是原子操作，允许最终一致
    await this.appendFile(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    const { file_type, project_id } = this.parsePath(path);
    // 获取该 file_type+project_id 的所有记录 ID 并删除
  }

  async exists(path: string): Promise<boolean> {
    const content = await this.readFile(path);
    return content !== null;
  }

  async listFiles(pattern: string): Promise<string[]> {
    // ... 调用 GET /api/memories 获取文件列表
    return [];
  }

  // 🆕 远程搜索方法（突破 IFileStorageProvider 接口，供 FileSearcher 直接调用）
  async search(
    query: string,
    topK: number,
    file_type?: string,
    project_id?: string,
  ): Promise<KeywordSearchResult[]> {
    const result = await this.client.post<ApiResponse<KeywordSearchResult[]>>('/api/memories/search', {
      query,
      topK,
      file_type,
      project_id,
    });
    return result.success ? (result.data ?? []) : [];
  }
}
```

### 5. 创建 `src/providers/remote/index.ts`

### 6. 编写测试 `tests/remote-providers.test.ts`

使用 Bun 内置的 mock `fetch` 测试各 Provider：

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";

describe("RemoteFileStorageProvider", () => {
  test("appendFile → POST /api/memories", async () => {
    // mock global fetch
  });
  test("readFile → GET /api/memories", async () => {});
  test("401 error handling", async () => {});
  test("429 rate limit handling", async () => {});
});
```

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `src/providers/remote/http-client.ts` |
| 🆕 新增 | `src/providers/remote/VectorIndexProvider.ts` |
| 🆕 新增 | `src/providers/remote/EmbeddingProvider.ts` |
| 🆕 新增 | `src/providers/remote/FileStorageProvider.ts` |
| 🆕 新增 | `src/providers/remote/index.ts` |
| 🆕 新增 | `tests/remote-providers.test.ts` |
| ✏️ 修改 | `src/providers/factory.ts`（取消注释 remote 分支） |

## 注意事项

- RemoteProvider 的 `fetch` 调用使用全局 `fetch`（Bun 内置），不需要额外依赖
- 路径解析器 `parsePath` 需要与 T13 中 `MemoryManager.getPathForTarget()` 的 remote 模式输出格式一致
- 错误处理需要覆盖 401（JWT 过期）、429（限流）、500（Worker 内部错误）等场景
- `RemoteEmbeddingProvider.embedTexts()` throw 是预期行为 — 需要通过 `FileSearcher` 改造确保不被调用
- `createProviders('remote', config)` 需要从 `config.remote` 读取 `apiUrl` 和 `apiKey`
