# ADR: opencode-memory 双模式架构合并 — 架构决策记录

**日期：** 2026-07-22
**状态：** 提议中
**关联 PRD：** `docs/prd/dual-mode-merge.md`
**关联技术调研：** `docs/dev/research/dual-mode-architecture.md`

---

## 背景

将 `opencode-memory`（本地插件）与 `cloudflare-memory`（CF Worker 全栈后端）合并为单一仓库，插件支持 `mode=local|remote` 双模式。本 ADR 记录合并过程中的关键架构决策。

---

## ADR-001：pnpm workspace 管理 monorepo（替代 Bun workspaces）

### 决策

使用 `pnpm workspace` 管理合并后的 monorepo，根仓库为 opencode-memory。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. pnpm workspace（选中）** | 与 cloudflare-memory 现有方案一致，Workers 项目依赖 wrangler 需 Node.js 生态，pnpm 原生支持 `workspace:*` 协议 |
| B. Bun workspaces | opencode-memory 当前使用 `bun test`，但 cloudflare-memory 的 wrangler 构建链需 Node.js，Bun 不兼容 `@cloudflare/workers-types` 的类型推断路径 |
| C. npm workspaces | 缺少 `pnpm` 的严格依赖隔离和 `workspace:*` 协议，子包间类型引用需手动处理 |
| D. yarn workspaces | 无实质优势，团队不熟悉 |

### 理由

- **零迁移成本**：cloudflare-memory 已是 pnpm workspace，直接迁入
- **plugin 兼容**：pnpm 安装 Bun 运行脚本完全兼容，`bun test` 无需改动
- **workspace:* 协议**：`@cfmem/shared` 类型包被 worker/web 引用，workspace 协议保证本地开发直接引用源码而非 dist
- **构建链统一**：wrangler deploy 依赖 Node.js，pnpm 提供原生支持

### 影响

- 根目录新增 `pnpm-workspace.yaml` 和 `pnpm-lock.yaml`
- 移除现有 `bun.lock`
- plugin 的 `bun test` 保持不变（pnpm 调用 bun 二进制）
- CI 需安装 pnpm（`corepack enable`）

---

## ADR-002：直调 Worker REST API（废弃 MCP 协议）

### 决策

插件 remote 模式下直接调用 Worker REST API（`POST /api/memories`、`POST /api/memories/search`、`GET /api/context` 等），废弃 cloudflare-memory 现有的 MCP 协议（`POST /mcp`、`GET /mcp` SSE）。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. 直调 REST API（选中）** | 简单直接，无协议开销，Worker 端已有完整的 RESTful 接口，只需扩展字段 |
| B. 保留 MCP 协议 | 多一层 JSON-RPC 包装，open code → MCP client → HTTP → Worker MCP handler，不增加价值但增加延迟和复杂度 |
| C. 同时支持 REST + MCP | 维护两套接口，增加测试和文档负担。PRD 明确排除 MCP |

### 理由

- **协议简化**：memory 操作本质是 CRUD，REST 语义天然匹配，无需 JSON-RPC 包装
- **减少依赖**：移除插件端的 `@modelcontextprotocol/sdk` 依赖（~200KB）
- **直接可调试**：`curl -X POST /api/memories` 即可测试，无需 MCP Inspector
- **已有基础**：Worker 端已有 `POST /api/memories`、`POST /api/memories/search`、`GET /api/context` 等端点，扩展字段即可

### 影响

- 删除 `apps/plugin/` 整个子目录（MCP client 不再需要）
- 删除 Worker 端的 `src/mcp/agent.ts`、`POST /mcp`、`GET /mcp` 路由
- 删除 `@modelcontextprotocol/sdk` Worker 依赖
- 插件新增 `src/providers/remote/RemoteProvider.ts`（HTTP client 实现）

---

## ADR-003：Provider 抽象层使用 3 个接口（非更多/更少）

### 决策

定义 `IVectorIndexProvider`、`IEmbeddingProvider`、`IFileStorageProvider` 三个接口，不抽象 `IVersioningProvider`。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. 3 个接口（选中）** | 覆盖核心差异：向量查询、嵌入推理、文件读写。版本管理（git/D1 Time Travel）差异太大，抽象收益低 |
| B. 2 个接口（合并向量+嵌入） | 紧耦合：向量索引需要预先嵌入文本，合并为一个 `ISearchProvider` 则 remote 模式调用 Worker `/search` 端点时，嵌入步骤在 Worker 侧完成，客户端无需单独调用嵌入 |
| C. 4 个接口（加 VersioningProvider） | 本地 git commit vs 远程 D1 auto-save 差异太大，且远程 D1 本质无"提交"概念（每次写入都是持久化），强行统一接口会增加 `void` 实现 |
| D. 先分支后抽象（调研建议） | 调研建议等两个 Provider 稳定后再提取接口。但当前已确认 Cloudflare 为唯一远程后端，且合并范围不包括 Hybrid 模式，因此直接抽象成本更低 |

### 理由

- **2 个接口的风险**：合并向量索引和嵌入后，remote 模式无法复用 Worker 的 hybrid search（向量+FTS），需在客户端分别调两个端点，增加一次网络往返
- **3 个接口的收益**：
  - `IFileStorageProvider`：readFile/writeFile/appendFile/deleteFile/exists 五个方法，本地走 fs，远程走 Worker `/api/memories` + `/api/context`
  - `IEmbeddingProvider`：embedText(text[]) → number[][]，本地走 huggingface ONNX，远程可直接调用 Worker `/search` 端点（嵌入在 Worker 侧执行）或仅作类型占位
  - `IVectorIndexProvider`：upsert/search/delete 三个方法，本地走 vectra LocalIndex，远程走 Worker `/search` 端点
- **不抽象 Versioning**：本地 git 自动 commit 和远程 Worker 的 D1 即时持久化语义完全不兼容。本地模式保留 git 逻辑不变，远程模式跳过 versioning 步骤

### 接口定义（纲要）

```typescript
// IVectorIndexProvider — 向量索引操作
interface IVectorIndexProvider {
  upsert(chunks: EmbeddedChunk[], namespace: string): Promise<void>;
  search(vector: number[], topK: number, namespace: string): Promise<SearchResult[]>;
  delete(ids: string[], namespace: string): Promise<void>;
  isStale?(metadata: EmbeddingMetadata): Promise<boolean>;
}

// IEmbeddingProvider — 文本嵌入推理
interface IEmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

// IFileStorageProvider — 文件级读写
interface IFileStorageProvider {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(pattern: string): Promise<string[]>;
}
```

### 影响

- `MemoryManager` 构造函数接收 `IVectorIndexProvider` + `IEmbeddingProvider` + `IFileStorageProvider` 三个可选注入
- `handleWrite/handleRead/handleEdit/handleDelete/handleSearch` 不需改动（通过 MemoryManager 间接使用 provider）
- 本地模式下三个 provider 自动创建默认实例（保持向后兼容）

---

## ADR-004：D1 schema 扩展策略（ALTER TABLE ADD COLUMN）

### 决策

通过 Migration 0006 在现有 `memories` 表上 `ALTER TABLE ADD COLUMN` 新增 `project_id`、`file_type`、`date` 三列，不新建独立表。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. ALTER TABLE ADD COLUMN（选中）** | 最小改动，`DEFAULT` 值保证旧数据兼容，一条 migration 完成 |
| B. 新建 `memory_files` 关联表 | 多一张表 + JOIN 查询，增加复杂度。当前需求只是给每条 memory 打标签，不是多对多关系 |
| C. 用 tags JSON 字段存储 project_id/file_type | 失去索引能力，`.project_id` 过滤需要全表扫描，且 JSON 查询在 D1 中效率低 |
| D. 不扩展 D1，用单独的 key-value 表 | 过度设计。project_id/file_type 是每条记忆的固有属性，和 text/kind 同级，应在同一条记录中 |

### 理由

- **DEFAULT 值保证兼容**：`project_id TEXT NOT NULL DEFAULT ''`、`file_type TEXT NOT NULL DEFAULT 'memory'`，旧数据自动获得默认值
- **索引优化**：`CREATE INDEX idx_memories_project ON memories(user_id, project_id, file_type)` 覆盖最常用的查询组合（按用户+项目+文件类型过滤）
- **单一数据源**：避免 JOIN，搜索时一次查询即可过滤 by project_id + file_type
- **D1 限制考量**：D1 不支持 `ALTER TABLE ... RENAME COLUMN`，但 `ADD COLUMN` 完全支持

### Migration 0006 SQL

```sql
ALTER TABLE memories ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN file_type TEXT NOT NULL DEFAULT 'memory';
ALTER TABLE memories ADD COLUMN date TEXT DEFAULT '';

CREATE INDEX idx_memories_project ON memories(user_id, project_id, file_type);
CREATE INDEX idx_memories_date ON memories(user_id, date);
```

### 字段映射

| 插件概念 | D1 字段 | 值示例 |
|----------|---------|--------|
| MEMORY.md（全局） | file_type='memory', project_id='' | — |
| MEMORY.md（项目） | file_type='memory', project_id='devcxl/opencode-memory' | — |
| IDENTITY.md | file_type='identity', project_id='' | — |
| USER.md | file_type='user', project_id='' | — |
| daily/2026-07-22.md（全局） | file_type='daily', project_id='', date='2026-07-22' | — |
| daily/2026-07-22.md（项目） | file_type='daily', project_id='devcxl/opencode-memory', date='2026-07-22' | — |

---

## ADR-005：插件端条件加载策略（remote 模式避免加载重型依赖）

### 决策

通过动态 `import()` + 配置驱动的 Provider 工厂，在 `mode=remote` 时完全跳过 `vectra`、`@huggingface/transformers`、`onnxruntime-node` 的加载。

### 替代方案

| 方案 | 评估 |
|------|------|
| **A. 动态 import() Provider 工厂（选中）** | zero-cost 条件加载，未使用的模块不会被 Node.js require 缓存，内存和启动时间均受益 |
| B. 编译时条件（`tsconfig` exclude） | 无法动态切换模式，用户每次切换需重新构建，不符合"运行时配置"需求 |
| C. try/catch 可选依赖 | vectra 在 import 时就会加载原生 binding，try/catch 只能防止 crash，无法阻止内存加载 |
| D. 分离 npm 包 | 维护两个包（`opencode-memory-local` + `opencode-memory-remote`）增加发布和安装复杂度，用户需手动选包 |

### 理由

- **运行时切换**：用户可通过 `opencode.json` 的 `mode` 字段在 local/remote 间切换，无需重新安装依赖
- **内存优化**：vectra 的 HNSW 原生 binding + huggingface ONNX runtime 内存占用 ~300MB，remote 模式完全不需要
- **启动加速**：跳过 ONNX 模型加载可节省 2-5 秒冷启动时间
- **实现简单**：`createProviders(mode, config)` 工厂函数内部用 `if/else` 做条件 `import()`

### 实现策略

```typescript
// src/providers/factory.ts
export async function createProviders(
  mode: "local" | "remote",
  config: MemoryConfig,
): Promise<{
  vectorIndex: IVectorIndexProvider;
  embedding: IEmbeddingProvider;
  fileStorage: IFileStorageProvider;
}> {
  if (mode === "local") {
    // 按需 import，local 模式下才会加载 vectra + huggingface
    const { LocalVectorIndexProvider } = await import("./local/VectorIndexProvider.js");
    const { LocalEmbeddingProvider } = await import("./local/EmbeddingProvider.js");
    const { LocalFileStorageProvider } = await import("./local/FileStorageProvider.js");
    return {
      vectorIndex: new LocalVectorIndexProvider(config),
      embedding: new LocalEmbeddingProvider(),
      fileStorage: new LocalFileStorageProvider(config),
    };
  }

  // remote 模式：不加载 vectra/huggingface
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

### 影响

- `src/index.ts` 的 `MemoryPlugin` 在初始化时调用 `createProviders(config.mode, config)`，将 provider 注入 `MemoryManager`
- `MemoryManager` 构造函数参数从 `(config: MemoryConfig)` 扩展为 `(config: MemoryConfig, providers?: Providers)`
- `vectra`、`@huggingface/transformers` 从 `dependencies` 改为 `optionalDependencies`（或保留在 dependencies 但通过动态 import 隔离）
- 已有测试需要适配：注入 mock provider 或默认使用 local provider

---

## 与已有 ADR 的兼容性检查

| 已有 ADR | 影响 | 兼容性 |
|----------|------|--------|
| **ADR-001 (scope 前缀)** | handler 返回字符串中 `[scope: ...]` 前缀不变 | ✅ 完全兼容 |
| **ADR-002 (git rev-parse fallback)** | `detectProject()` 逻辑不变，remote 模式下同样需要 projectId 用于 D1 过滤 | ✅ 完全兼容 |
| **ADR-003 (项目 daily 路径)** | 本地 `projects/{id}/daily/` 路径保留。远程映射为 `file_type='daily' + project_id='{id}'` | ✅ 语义映射 |
| **ADR-004 (handleList 不改造)** | 本次不扩展 list 功能到远程模式，远程 list 沿用现有 Worker `GET /api/memories` | ✅ 一致 |
| **ADR-005 (scope 标签直接判断)** | handler 的 `params.project` 有/无决定 scope 标签，不重复检测。remote 模式同样适用 | ✅ 完全兼容 |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| pnpm 安装后 `bun test` 路径解析异常 | 保留 plugin 的 `tsconfig.json` 不变，bun 使用自己内置的模块解析 |
| Worker 扩展字段后旧版 API 调用方报错 | `DEFAULT` 值保证旧版调用方不受影响，新字段可选 |
| 动态 import 导致 TypeScript 类型推断断裂 | Provider 接口单独定义在 `src/providers/types.ts`，工厂函数返回类型标注接口类型 |
| Vectorize 最终一致性延迟 | 插件端保留内存写入缓存（最近 30 条），搜索时合并缓存 + 远程结果 |
| 冷启动时首次 embedding 调用超时 | 超时 30s，重试 2 次，失败降级返回错误提示（不阻塞 memory 操作） |
