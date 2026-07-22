# opencode-memory 双模式架构合并 — 技术方案

> 版本: v1.0 | 日期: 2026-07-22
> 关联 PRD: `docs/prd/dual-mode-merge.md`
> 关联 ADR: `docs/adr/2026-07-22-dual-mode-merge.md`
> 关联调研: `docs/dev/research/dual-mode-architecture.md`

---

## 1. 技术选型

### 1.1 Monorepo 管理

| 选项 | 是否采用 | 理由 |
|------|----------|------|
| **pnpm workspace** | ✅ 采用 | cloudflare-memory 已有 pnpm workspace；wrangler 构建链依赖 Node.js 生态；`workspace:*` 协议支持子包源码引用 |
| Bun workspaces | ❌ | wrangler + `@cloudflare/workers-types` 与 Bun 的模块解析路径不兼容 |
| npm/yarn workspaces | ❌ | 缺少严格依赖隔离和 `workspace:*` 协议 |

### 1.2 后端运行时

| 组件 | 选择 | 理由 |
|------|------|------|
| **HTTP 框架** | Hono 4.x | cloudflare-memory 已使用，轻量（~15KB），TypeScript 原生支持 |
| **数据库** | Cloudflare D1 (SQLite) | 免费额度充足（5GB/DB），已有完整 schema，source of truth |
| **向量索引** | Cloudflare Vectorize | HNSW 索引，全球边缘部署，与 Workers 原生集成 |
| **嵌入模型** | Workers AI Qwen3-Embedding-0.6B | cloudflare-memory 已使用（1024d），多语言支持含中文 |
| **认证** | JWT HS256 (jose) | cloudflare-memory 已实现，Bearer token 认证 |

### 1.3 前端（插件侧）

| 组件 | local 模式 | remote 模式 |
|------|------------|-------------|
| **运行时** | Bun | Bun |
| **向量索引** | vectra LocalIndex | Worker REST API |
| **嵌入推理** | @huggingface/transformers (ONNX) | Workers AI (Worker 侧执行) |
| **文件存储** | Node.js fs | Worker REST API + D1 |
| **版本管理** | local git | D1 auto-persist (无显式 versioning) |

### 1.4 共享类型

| 组件 | 选择 | 理由 |
|------|------|------|
| **类型定义** | `@cfmem/shared` (packages/shared) | 从 cloudflare-memory 迁入，Worker + Plugin 共同引用 |
| **验证库** | Zod 3.x (Worker 侧) | 已有依赖，运行时请求体校验 |

### 1.5 插件构建

| 组件 | 选择 | 理由 |
|------|------|------|
| **TypeScript 编译** | tsc | 现有方案，产出 ESM + declaration |
| **测试** | bun test | 现有方案，remote 模式新增 HTTP mock 测试 |
| **格式化** | prettier | 现有方案 |

---

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Plugin 入口层                              │
│  src/index.ts  — 根据 mode=local|remote 注入 Provider              │
│  src/config/runtime.ts — MemoryConfig 扩展 mode, remote 段         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│                     Provider 抽象层 🆕                             │
│  src/providers/types.ts — IVectorIndex / IEmbedding / IFileStorage │
│  src/providers/factory.ts — createProviders(mode, config)          │
│  src/providers/local/  — LocalVectorIndex, LocalEmbedding,         │
│                          LocalFileStorage                          │
│  src/providers/remote/ — RemoteVectorIndex, RemoteEmbedding,       │
│                          RemoteFileStorage (HTTP Client → Worker)   │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│                     Business 层（不变）                            │
│  src/memory/MemoryManager.ts — 注入 Provider，协调操作              │
│  src/memory/FileSearcher.ts — 语义搜索编排                         │
│  src/memory/MemoryPaths.ts — 路径派生（仅 local 模式使用）          │
│  src/handlers/ — handleWrite, handleRead, handleSearch, …          │
└──────────────────────────┬───────────────────────────────────────┘
                           │ (remote mode)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Worker API 层（CF Workers）                      │
│  worker/src/index.ts — Hono 路由 + JWT 认证 + 限流                  │
│  worker/src/services/memory-service.ts — CRUD + 搜索               │
│  worker/src/search/ — hybrid search (向量 + FTS) + indexing         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│                       数据层                                      │
│  D1 (memories 表 + project_id/file_type/date) — source of truth    │
│  Vectorize (1024d, cosine) — 语义索引                              │
│  Workers AI (Qwen3-Embedding-0.6B) — 嵌入推理                      │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 关键模块说明

#### 2.1.1 Provider 抽象层 (`src/providers/`)

| 文件 | 职责 |
|------|------|
| `types.ts` | 定义 `IVectorIndexProvider`、`IEmbeddingProvider`、`IFileStorageProvider` 三个接口 |
| `factory.ts` | `createProviders(mode, config)` — 按 mode 条件加载对应实现 |
| `local/VectorIndexProvider.ts` | 包装现有 `src/search/vector-store.ts` 的 vectra LocalIndex |
| `local/EmbeddingProvider.ts` | 包装现有 `src/search/embedding.ts` 的 huggingface pipeline |
| `local/FileStorageProvider.ts` | 包装现有 MemoryManager 的 fs 操作 |
| `remote/VectorIndexProvider.ts` | HTTP client → `POST /api/memories/search` |
| `remote/EmbeddingProvider.ts` | HTTP client → `POST /api/embed`（可选，或远程模式下嵌入在 Worker 侧执行，客户端为 no-op） |
| `remote/FileStorageProvider.ts` | HTTP client → `POST /api/memories`, `GET /api/memories`, `DELETE /api/memories/:id`, `GET /api/context` |

#### 2.1.2 Worker API 层 (`worker/`)

从 cloudflare-memory 迁移，向下扩展：

- 新增 `project_id` / `file_type` / `date` 查询过滤
- 新增 `/api/embed` 端点（可选，供插件直接获取嵌入向量）
- 废弃 `/mcp` 路由
- 废弃 `apps/plugin/` MCP client

#### 2.1.3 Web UI (`web/`)

从 cloudflare-memory 迁移，保持不变。React SPA，通过 `wrangler.toml` 的 `[assets]` 配置作为 Worker 静态资源托管。

---

## 3. 数据流

### 3.1 Write 操作

```
                     ┌──── local ────┐         ┌──── remote ────┐
用户/AI 调用         │                │         │                 │
memory --action      │  handleWrite   │         │  handleWrite    │
write --target       │    ↓           │         │    ↓            │
memory --content     │  getPathFor    │         │  getPathFor     │
'...'                │  Target()      │         │  Target()       │
                           ↓           │         │    ↓            │
                     │  FileStorage   │         │  FileStorage    │
                     │  .appendFile() │         │  .appendFile()  │
                     │  (fs + atomic) │         │  (HTTP POST     │
                     │    ↓           │         │   /api/memories)│
                     │  embedText()   │         │    ↓            │
                     │  (huggingface) │         │  Worker:        │
                     │    ↓           │         │   embedText()   │
                     │  chunkMarkdown │         │   (Workers AI)  │
                     │    ↓           │         │    ↓            │
                     │  VectorIndex   │         │  VectorIndex    │
                     │  .upsert()     │         │  .upsert()      │
                     │  (vectra)      │         │  (Vectorize)    │
                     │    ↓           │         │    ↓            │
                     │  gitCommit()   │         │  D1.insert()    │
                     └────────────────┘         └─────────────────┘
```

**local 模式**：`persistAndIndex` 三合一（atomicWrite + embedAndIndex + gitCommit），与 v1.2.0 完全一致。

**remote 模式**：
1. `RemoteFileStorage.appendFile()` → `POST /api/memories`，body 包含 `text`、`file_type`、`project_id`、`date`
2. Worker 侧 `createMemory()` → D1 INSERT + Workers AI embedding + Vectorize upsert
3. 返回 `{ id, indexed }`

### 3.2 Read 操作

```
                     ┌──── local ────┐         ┌──── remote ────┐
memory --action      │  handleRead   │         │  handleRead    │
read --target        │    ↓           │         │    ↓            │
memory               │  getPathFor   │         │  getPathFor     │
                     │  Target()      │         │  Target()       │
                     │    ↓           │         │    ↓            │
                     │  FileStorage   │         │  FileStorage    │
                     │  .readFile()   │         │  .readFile()    │
                     │  (fs.readFile) │         │  (GET /api/     │
                     │                │         │   context       │
                     │                │         │   +             │
                     │                │         │   GET /api/     │
                     │                │         │   memories)     │
                     └────────────────┘         └─────────────────┘
```

**remote 模式 read**：
1. `target !== 'daily'` → `GET /api/memories?file_type=memory&project_id=`，合并所有记录作为文件内容返回
2. `target === 'daily'` → `GET /api/memories?file_type=daily&date=2026-07-22&project_id=`
3. `target 未指定` → fallback 到 list 行为

### 3.3 Search 操作

```
                     ┌──── local ──────────┐    ┌──── remote ───────────┐
memory --action      │  handleSearch        │    │  handleSearch         │
search --query       │    ↓                  │    │    ↓                   │
'架构决策'           │  FileSearcher        │    │  FileSearcher         │
                     │  .semanticSearch()   │    │  .semanticSearch()    │
                     │    ↓                  │    │    ↓                   │
                     │  embedText(query)     │    │  VectorIndexProvider  │
                     │  (huggingface)        │    │  .search(vector, topK)│
                     │    ↓                  │    │  (POST /api/memories/ │
                     │  VectorIndex          │    │   search)             │
                     │  .search(vector,topK) │    │    ↓                   │
                     │  (vectra LocalIndex)  │    │  Worker: embedText()  │
                     │    ↓                  │    │  → Vectorize.query()  │
                     │  合并 root+daily+     │    │  → RRF fusion w/ FTS  │
                     │  project 结果          │    │  → 返回 KeywordSearch │
                     └──────────────────────┘    └────────────────────────┘
```

**关键差异**：

| 维度 | local | remote |
|------|-------|--------|
| 嵌入执行位置 | 客户端 (huggingface) | Worker 侧 (Workers AI) |
| 搜索算法 | vectra HNSW | Vectorize HNSW + FTS5 RRF 融合 |
| 一致性 | 即时 | 最终一致 (<5min) |
| 过滤方式 | 应用层 | Vectorize metadata filter + D1 WHERE |

**remote 模式 scope 处理**：
- `scope=global`：`project_id=''`
- `scope=project`：`project_id='owner/repo'`
- `scope=all`：不加 project_id 过滤

---

## 4. Worker API 详细设计

### 4.1 端点清单

| 方法 | 路径 | 说明 | 请求体/查询参数 | 响应 |
|------|------|------|----------------|------|
| `POST` | `/api/memories` | 写入记忆 | `{ text, kind?, tags?, file_type?, project_id?, date? }` | `{ success, data: { id, indexed } }` |
| `POST` | `/api/memories/search` | 语义搜索 | `{ query, kind?, topK?, file_type?, project_id? }` | `{ success, data: KeywordSearchResult[] }` |
| `GET` | `/api/memories` | 列出记忆 | `?kind=&file_type=&project_id=&limit=&offset` | `{ success, data: Memory[] }` |
| `DELETE` | `/api/memories/:id` | 删除记忆 | — | `{ success: true }` |
| `GET` | `/api/context` | 获取记忆摘要 | `?project_id=` | `{ success, data: string }` |
| `GET` | `/api/stats` | 统计 | `?project_id=` | `{ success, data: { shortCount, longCount } }` |
| `GET` | `/health` | 健康检查 | — | `"OK"` |

### 4.2 请求/响应类型（扩展后）

```typescript
// POST /api/memories — 写入请求体
interface CreateMemoryRequest {
  text: string;                           // 记忆内容（必填）
  kind?: 'short' | 'long';               // 类型（默认 'short'，插件调用默认 'long'）
  tags?: string[];                        // 标签（可选）
  file_type?: 'memory' | 'identity' | 'user' | 'daily';  // 🆕 文件类型
  project_id?: string;                    // 🆕 项目 ID（空字符串 = 全局）
  date?: string;                          // 🆕 日期（daily 类型时使用，YYYY-MM-DD）
}

// POST /api/memories/search — 搜索请求体
interface SearchMemoriesRequest {
  query: string;                          // 搜索查询（必填）
  kind?: 'short' | 'long';               // 类型过滤
  topK?: number;                          // 返回数量（默认 5, 最大 20）
  file_type?: string;                     // 🆕 文件类型过滤
  project_id?: string;                    // 🆕 项目 ID 过滤
}

// GET /api/memories — 查询参数
interface ListMemoriesQuery {
  kind?: 'short' | 'long';               // 类型过滤
  file_type?: string;                     // 🆕 文件类型过滤
  project_id?: string;                    // 🆕 项目 ID 过滤
  limit?: number;                         // 分页大小（默认 50, 最大 100）
  offset?: number;                        // 分页偏移
}

// 通用响应
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

### 4.3 认证与限流

**认证流程**（复用现有实现）：

```
Plugin                          Worker
  │                               │
  │  POST /api/memories           │
  │  Authorization: Bearer <JWT>  │
  │ ────────────────────────────→ │
  │                               │ → jwtVerify(token, JWT_SECRET)
  │                               │ → 提取 userId = payload.sub
  │                               │ → checkRateLimit(env, userId)
  │                               │ → 执行业务逻辑
  │ ←──────────────────────────── │
  │  200 { success: true }       │
```

- **JWT 生成**：由用户通过独立脚本生成（或 Worker 管理页面），写入 `opencode.json` 的 `apiKey` 字段或环境变量 `OPM_API_KEY`
- **限流**：现有 D1 `rate_limits` 表，默认 100 req/60s 窗口

### 4.4 错误码

| HTTP 状态码 | 含义 | 触发条件 |
|------------|------|----------|
| 400 | 请求参数校验失败 | Zod schema 不匹配 |
| 401 | 未认证 | 缺少或无效 JWT |
| 413 | 请求体过大 | Content-Length > 10KB |
| 429 | 请求过于频繁 | 超过限流阈值 |
| 500 | 服务器内部错误 | D1/Vectorize/Workers AI 异常 |

### 4.5 D1 查询扩展

```sql
-- write 操作扩展
INSERT INTO memories (id, user_id, kind, text, text_fts, tags, created_at, expires_at,
                      project_id, file_type, date)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- search 操作扩展（Vectorize query 的 metadata filter）
filter: {
  user_id: userId,
  ...(project_id !== undefined ? { project_id } : {}),
  ...(file_type ? { file_type } : {}),
}

-- list 操作扩展
SELECT * FROM memories
WHERE user_id = ? AND kind = ? AND archived = 0
  AND (project_id = ? OR ? = '')        -- 🆕
  AND (file_type = ? OR ? = '')         -- 🆕
  AND (date = ? OR ? = '')              -- 🆕
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```

**注意**：Vectorize 的 metadata filter 需要在 index 创建时预定义 metadata index 字段。如果 cloudflare-memory 的 Vectorize index 未预定义 `project_id` / `file_type` / `date` 的 metadata index，需要重建索引。

---

## 5. Plugin RemoteProvider 接口设计

### 5.1 IVectorIndexProvider（remote 实现）

```typescript
// src/providers/remote/VectorIndexProvider.ts

export class RemoteVectorIndexProvider implements IVectorIndexProvider {
  constructor(private config: RemoteConfig) {}

  async upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void> {
    // 单个 chunk 的写入由 FileStorageProvider 处理（每次 write 自动触发 Worker 侧索引）
    // 此方法在 remote 模式下可能为空操作或用于批量重新索引
  }

  async search(vector: number[], topK: number, namespace: string): Promise<SearchResult[]> {
    // 将 vector 和 topK 封装为请求体，调用 POST /api/memories/search
    // Worker 侧执行 embedding + Vectorize query + FTS + RRF fusion
    const response = await fetch(`${this.config.apiUrl}/api/memories/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '',  // ← 这里有个设计问题：search 方法接收的是 vector，但 Worker API 接收的是 query 文本
        topK,
        file_type: this.resolveFileType(namespace),
        project_id: this.config.projectId ?? '',
      }),
    });
    // ... 解析响应，映射到 SearchResult
  }

  async delete(ids: string[], namespace: string): Promise<void> {
    for (const id of ids) {
      await fetch(`${this.config.apiUrl}/api/memories/${id}`, { method: 'DELETE', /* ... */ });
    }
  }
}
```

**设计决策：RemoteVectorIndexProvider.search 接收 vector 但调用 Worker `/api/memories/search` 需要 query 文本**

这是 `IVectorIndexProvider` 接口和 Worker API 之间的语义冲突。解决方案有两种：

| 方案 | 描述 | 推荐 |
|------|------|------|
| **A. 修改调用链** | `FileSearcher.semanticSearch()` 改为接收 query 文本，内部根据 mode 选择：local → embedText + VectorIndex.search；remote → RemoteFileStorage.search(query) | ✅ 推荐 |
| B. 传递原始 query | `IVectorIndexProvider.search` 同时接收 vector 和原始 query 文本 | 接口膨胀 |

**选择方案 A**：在 `FileSearcher` 中增加 mode 感知逻辑，remote 模式下不再调用 `embedText()`，直接通过 `RemoteFileStorage` 或专门的 remote search client 发起请求。这避免了在 Provider 接口中传递冗余参数。

### 5.2 IEmbeddingProvider（remote 实现）

```typescript
// src/providers/remote/EmbeddingProvider.ts

export class RemoteEmbeddingProvider implements IEmbeddingProvider {
  readonly dimensions = 1024;  // Qwen3-Embedding-0.6B
  readonly modelId = '@cf/qwen/qwen3-embedding-0.6b';

  constructor(private config: RemoteConfig) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    // remote 模式下，embedding 在 Worker 侧执行
    // 此方法是可选实现的：如果插件端需要独立获取嵌入向量，可调用 Worker /api/embed
    // 目前主要使用场景是 search，search 在 Worker 侧一站式完成
    // 因此此实现可以 throw 或返回空（取决于 FileSearcher 的调用路径）
    throw new Error('Remote mode: embedding is performed on the Worker side during search. Use search() instead.');
  }
}
```

**注意**：remote 模式下 `IEmbeddingProvider.embedTexts()` 不需要被调用。正确的调用链是：

```
handleSearch → FileSearcher.semanticSearch → (mode=remote) → RemoteVectorIndexProvider.search(query) → Worker /api/memories/search
                                                                                              ↑
                                                                                     Worker 侧执行 embedding
```

因此 `RemoteEmbeddingProvider` 本质上是一个占位实现，确保类型系统完整。`FileSearcher` 需要在 mode=remote 时跳过 `embedText()` 步骤。

### 5.3 IFileStorageProvider（remote 实现）

```typescript
// src/providers/remote/FileStorageProvider.ts

export class RemoteFileStorageProvider implements IFileStorageProvider {
  constructor(private config: RemoteConfig) {}

  async readFile(path: string): Promise<string | null> {
    // path 格式：target:date:project_id（如 "memory::" 或 "daily:2026-07-22:owner/repo"）
    const { file_type, date, project_id } = this.parsePath(path);

    const params = new URLSearchParams();
    if (file_type) params.set('file_type', file_type);
    if (date) params.set('date', date);
    if (project_id) params.set('project_id', project_id);
    params.set('kind', 'long');
    params.set('limit', '100');

    const response = await fetch(`${this.config.apiUrl}/api/memories?${params}`, {
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
    });
    const json = await response.json();

    if (!json.success || !json.data?.length) return null;

    // 将多条 memory 记录拼接为类似文件内容的格式
    return json.data
      .map((m: { created_at: number; text: string }) => {
        const ts = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 19);
        return `<!-- ${ts} -->\n${m.text}`;
      })
      .join('\n\n');
  }

  async appendFile(path: string, content: string): Promise<void> {
    const { file_type, date, project_id } = this.parsePath(path);

    const response = await fetch(`${this.config.apiUrl}/api/memories`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: content,
        kind: 'long',
        file_type,
        project_id,
        date,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to write memory: ${response.status}`);
    }
  }

  // ... writeFile, deleteFile, exists, listFiles 类似实现
}
```

### 5.4 路径映射设计

local 模式的文件路径如何映射到 remote 模式的查询参数：

```typescript
// MemoryManager.getPathForTarget() 在 remote 模式下返回的 path 格式：
// 格式："file_type:date:project_id"
// 例如：
//   "memory::"                  → 全局 MEMORY.md
//   "memory::owner/repo"        → 项目 MEMORY.md
//   "identity::"                → IDENTITY.md
//   "user::"                    → USER.md
//   "daily:2026-07-22:"        → 全局 daily
//   "daily:2026-07-22:owner/repo" → 项目 daily
```

这样 `MemoryManager.getPathForTarget()` 保持返回 path 字符串的签名不变，`RemoteFileStorageProvider` 内部解析为查询参数。

**替代方案**：直接不通过 path 字符串传递，而是让 handler 直接调用 provider 的带语义方法。但这需要 handler 感知 provider 类型，破坏现有抽象。

---

## 6. 配置系统设计

### 6.1 扩展后的 MemoryConfig

```typescript
// src/config/runtime.ts (扩展后)

export interface RemoteConfig {
  apiUrl: string;        // Worker 地址，如 "https://memory.example.workers.dev"
  apiKey: string;        // JWT token
}

export type MemoryMode = "local" | "remote";

export interface MemoryConfig {
  memoryDir: string;
  mode: MemoryMode;                  // 🆕 默认 "local"
  remote?: RemoteConfig;             // 🆕 mode=remote 时必填
}
```

### 6.2 配置加载优先级

```
1. opencode.json 插件配置段 → mode, remote.apiUrl, remote.apiKey
2. 环境变量 OPM_MODE → mode
3. 环境变量 OPM_API_KEY → apiKey（当 remote.apiKey = "env://OPM_API_KEY" 时）
4. 默认值：mode = "local"
```

### 6.3 配置示例

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    ["@devcxl/opencode-memory", {
      "mode": "remote",
      "remote": {
        "apiUrl": "https://memory.example.workers.dev",
        "apiKey": "env://OPM_API_KEY"
      }
    }]
  ]
}
```

---

## 7. Provider 实现策略

### 7.1 Local Providers（对现有代码的包装）

| Provider | 包装对象 | 改动程度 |
|----------|----------|----------|
| `LocalVectorIndexProvider` | `src/search/vector-store.ts` 导出的函数 | 最小：将导出函数封装为类方法 |
| `LocalEmbeddingProvider` | `src/search/embedding.ts` 导出的函数 | 最小：将导出函数封装为类方法 |
| `LocalFileStorageProvider` | `MemoryManager` 的 fs 操作 | 中：提取 `readFile/writeFile/appendFile/deleteFile/exists` 为独立类 |

**LocalFileStorageProvider** 的提取是重构的重头：

- 将 `MemoryManager.readFile()` / `writeFile()` / `appendFile()` / `deleteFile()` / `fileExists()` 提取到 `LocalFileStorageProvider`
- `MemoryManager.persistAndIndex()` 重构为调用 `LocalFileStorageProvider` + `LocalVectorIndexProvider` + `LocalEmbeddingProvider`
- `gitCommit()` 保留在 MemoryManager（因为 remote 模式不需要）

### 7.2 Remote Providers（全新实现）

| Provider | 实现方式 | 依赖 |
|----------|----------|------|
| `RemoteVectorIndexProvider` | HTTP client → Worker `/api/memories/search` | 仅 `fetch` (Bun 内置) |
| `RemoteEmbeddingProvider` | 占位实现（embedding 在 Worker 侧执行） | 无 |
| `RemoteFileStorageProvider` | HTTP client → Worker CRUD 端点 | 仅 `fetch` (Bun 内置) |

### 7.3 MemoryManager 构造函数改造

```typescript
// 改造前
constructor(config: MemoryConfig) {
  this.config = config;
  this.paths = new MemoryPaths(config.memoryDir);
  // ...
}

// 改造后
export interface Providers {
  vectorIndex: IVectorIndexProvider;
  embedding: IEmbeddingProvider;
  fileStorage: IFileStorageProvider;
}

constructor(config: MemoryConfig, providers?: Providers) {
  this.config = config;
  this.paths = new MemoryPaths(config.memoryDir);
  this.providers = providers;
  // 未注入 providers 时保持向后兼容（local 模式）
  // ...
}
```

**向后兼容**：`providers` 参数可选。未传入时，`MemoryManager` 内部自动创建本地 provider 包装实例。保证所有现有调用方无需改动。

---

## 8. 文件移动清单

### 8.1 从 cloudflare-memory 迁入

| 源路径 | 目标路径 | 说明 |
|--------|----------|------|
| `apps/api/src/**/*` | `worker/src/` | Worker API 核心代码，保留目录结构 |
| `apps/api/migrations/` | `worker/migrations/` | D1 迁移文件（含新增 0006） |
| `apps/api/wrangler.toml` | `worker/wrangler.toml` | Worker 配置 |
| `apps/api/package.json` | `worker/package.json` | 更新 workspace 依赖路径 |
| `apps/api/tsconfig.json` | `worker/tsconfig.json` | 调整 extends 路径 |
| `apps/web/src/**/*` | `web/src/` | React SPA |
| `apps/web/package.json` | `web/package.json` | 更新 workspace 依赖 |
| `packages/shared/src/**/*` | `packages/shared/src/` | 共享类型 |
| `packages/shared/package.json` | `packages/shared/package.json` | 保持不变 |
| `pnpm-workspace.yaml` | 根 `pnpm-workspace.yaml` | 扩展 plugins 所在路径 |
| 根 `package.json`（如有） | 不迁入 | cloudflare-memory 根 package.json 仅含 scripts，用 opencode-memory 替代 |

### 8.2 从 cloudflare-memory 排除（不迁入）

| 路径 | 原因 |
|------|------|
| `apps/plugin/` | MCP client 废弃，功能合并入 opencode-memory 插件 |
| `apps/api/src/mcp/` | MCP agent 废弃 |
| `.github/` | CI 延后到 Phase 4 |
| `README.md`（cloudflare-memory） | 合并后的 README 位于 opencode-memory 根目录 |

### 8.3 opencode-memory 仓库新增/修改

| 路径 | 操作 | 说明 |
|------|------|------|
| `pnpm-workspace.yaml` | 🆕 新增 | 定义 workspace 子包路径 |
| `pnpm-lock.yaml` | 🆕 新增 | pnpm 安装后生成 |
| `bun.lock` | ❌ 删除 | 改用 pnpm-lock |
| `src/providers/` | 🆕 新增 | Provider 抽象层 |
| `src/config/runtime.ts` | ✏️ 修改 | 扩展 MemoryConfig |
| `src/types.ts` | ✏️ 修改 | 新增 MemoryMode 等类型 |
| `src/index.ts` | ✏️ 修改 | 初始化时注入 provider |
| `src/memory/MemoryManager.ts` | ✏️ 修改 | 构造函数支持 Provider 注入 |
| `src/memory/FileSearcher.ts` | ✏️ 修改 | 支持 remote 模式查询 |
| `package.json` | ✏️ 修改 | vectra/huggingface 标记 optionalDependencies |
| `tsconfig.json` | ✏️ 修改 | 扩展 references 或 paths |

---

## 9. 与已有 ADR 的兼容性检查表

| 已有 ADR | 关键决策 | 本次改动影响 | 兼容性 |
|----------|----------|-------------|--------|
| ADR-001 (scope 前缀) | handler 返回值中包含 `[scope: ...]` | handler 代码不变，仅底层 provider 切换 | ✅ |
| ADR-002 (git rev-parse fallback) | 三级 projectId 检测策略 | `detectProject()` 不变，remote 模式同样使用 | ✅ |
| ADR-003 (项目 daily 路径) | `projects/{id}/daily/YYYY-MM-DD.md` | local 保留路径；remote 映射为 D1 file_type+project_id | ✅ |
| ADR-004 (handleList 不改造) | 列表功能不扩展项目级 daily | 本次不扩展 list 功能至远程模式 | ✅ |
| ADR-005 (scope 标签直接判断) | handler 不重复检测 project | handler 代码不变 | ✅ |

---

## 10. 实施阶段

### Phase 1: 仓库合并（1-2 天）

**目标**：两个仓库的文件搬到一个目录，pnpm workspace 可用，所有子包 `typecheck` 通过。

**步骤**：
1. 在 opencode-memory 根目录创建 `pnpm-workspace.yaml`
2. 将 cloudflare-memory 的 `apps/api/` → `worker/`、`apps/web/` → `web/`、`packages/shared/` → `packages/shared/`
3. 调整各子包的 `tsconfig.json` extends 路径
4. 调整 `@cfmem/*` 的 workspace 依赖引用
5. 根目录 `pnpm install`
6. 验证：`pnpm typecheck` 递归通过

**验证**：`pnpm typecheck` 全绿，worker `wrangler dev` 可启动

### Phase 2: Worker schema 扩展 (0.5-1 天)

**目标**：D1 新增 `project_id`、`file_type`、`date` 列，Vectorize metadata filter 扩展。

**步骤**：
1. 创建 `worker/migrations/0006_extend_for_opencode.sql`
2. `wrangler d1 migrations apply memory-db` 执行迁移
3. 更新 `memory-service.ts` 的 SQL 语句，增加新字段
4. 更新 `indexing.ts` 的 Vectorize metadata，增加 `project_id`、`file_type`、`date`
5. 更新 `GET /api/memories`、`POST /api/memories/search`、`GET /api/context` 端点的过滤逻辑
6. **注意**：如果 Vectorize index 需要重建以支持新 metadata filter 字段，记录重建步骤

**验证**：用 curl 测试写入一条带新字段的记忆，检查 D1 和 Vectorize

### Phase 3: 插件 Provider 抽象 + 远程 Provider 实现 (2-3 天)

**目标**：插件支持 `mode=remote`，所有 memory 操作可走远程 Worker。

**步骤**：
1. 定义 `src/providers/types.ts` 三个接口
2. 实现 `src/providers/local/*` 三个本地 Provider（包装现有逻辑）
3. 实现 `src/providers/factory.ts` 条件加载工厂函数
4. 实现 `src/providers/remote/*` 三个远程 Provider
5. 重构 `MemoryManager` 构造函数，支持 Provider 注入
6. 扩展 `MemoryConfig`、`loadConfig()`
7. 重构 `FileSearcher.semanticSearch()` 支持 remote 模式
8. 重构 `src/index.ts` 初始化逻辑
9. 适配所有 handler（确保 scope 标签等不变）
10. 本地模式回归测试（bun test 全绿）
11. 远程模式手动端到端测试

**验证**：`mode=local` 时 bun test 全绿；`mode=remote` 时手动测试 write/read/search

### Phase 4: 清理 + 文档 + CI (1 天)

**目标**：移除废弃代码，更新文档。

**步骤**：
1. 删除 Worker 端 `src/mcp/agent.ts`
2. 删除 Worker 的 MCP 路由（`POST /mcp`、`GET /mcp`）
3. 删除 `@modelcontextprotocol/sdk` 依赖
4. 更新根 README（双模式说明 + 部署指南）
5. 更新 `worker/wrangler.toml` 的 `[vars]` 和注释
6. 合并 cloudflare-memory README 的相关内容

**验证**：文档可读，部署指南可复现

---

## 11. 测试策略

### 11.1 本地模式回归测试

- 现有 `tests/high-risk.test.ts` 全量通过
- 新增 Provider 工厂测试：`createProviders("local", config)` 返回正确的 provider 类型
- 新增 MemoryManager 注入测试：使用 mock provider 验证方法委托

### 11.2 远程模式测试

- 新增 `tests/remote-providers.test.ts`：使用 `nock` 或 Bun 内置 mock fetch
- Mock Worker 端点：
  - `POST /api/memories` → 返回 `{ success: true, data: { id, indexed: true } }`
  - `POST /api/memories/search` → 返回 mock 搜索结果
  - `GET /api/context` → 返回 mock 记忆摘要
- 测试各种错误场景：401/429/500

### 11.3 集成测试

- 使用 `wrangler dev --remote` 启动 Worker
- 配置插件 `mode=remote` + `apiUrl='http://localhost:8787'`
- 手动测试完整 write → search → read → delete 流程

---

## 12. 假设和不确定项

| 序号 | 假设 | 风险 | 验证方式 |
|------|------|------|----------|
| 1 | Vectorize index 已预定义 `project_id`/`file_type` metadata index，或可重建 | 未预定义则需重建索引，影响已有数据 | 查看 cloudflare-memory 当前的 Vectorize index 配置 |
| 2 | Workers AI `@cf/qwen/qwen3-embedding-0.6b` 对中文的记忆内容（技术文档）嵌入质量足够 | bge-m3 更好但维度不同（需重建） | 搜索质量回归测试 |
| 3 | Bun 的 `fetch` 在插件进程中可以正常发起 HTTPS 请求（无代理/网络限制） | 某些用户网络环境可能限制 HTTPS 出口 | 实际环境验证 |
| 4 | 用户部署 Worker 的门槛在可接受范围（需要 Cloudflare 账号 + wrangler CLI） | 可能降低远程模式的采用率 | 提供详细部署指南 |
| 5 | `vectra` 和 `@huggingface/transformers` 作为 `optionalDependencies` 不会影响 pnpm 安装 | 某些包管理器对 optional 处理不一致 | pnpm install 验证 |
| 6 | `MemoryManager.getPathForTarget()` 的 `path:file_type:date:project_id` 映射格式足够表达所有 memory target 组合 | 未来扩展新 target 可能需要调整格式 | 当前 4 种 target 已验证 |

---

## 附录 A: 文件改动量预估

| 模块 | 新增文件 | 修改文件 | 删除文件 | 预估行数 |
|------|----------|----------|----------|----------|
| Provider 抽象层 | 8 (types + factory + 2x3 local+remote) | 0 | 0 | ~400 |
| MemoryManager 重构 | 0 | 1 (MemoryManager.ts) | 0 | ~100 改动 |
| Config 扩展 | 0 | 1 (runtime.ts) | 0 | ~30 |
| FileSearcher 适配 | 0 | 1 (FileSearcher.ts) | 0 | ~50 |
| 入口适配 | 0 | 1 (index.ts) | 0 | ~30 |
| Worker API 扩展 | 1 (migration 0006) | 3 (index.ts, memory-service.ts, indexing.ts) | 2 (mcp/agent.ts, MCP 路由) | ~200 |
| 类型定义 | 0 | 2 (types.ts, @cfmem/shared) | 0 | ~30 |
| 构建配置 | 2 (pnpm-workspace.yaml, root package.json) | 3 (tsconfig, worker/wrangler.toml) | 1 (bun.lock) | ~50 |
| 测试 | 2 (provider 测试) | 1 (现有测试适配) | 0 | ~200 |
| **合计** | **13** | **13** | **3** | **~1100** |
