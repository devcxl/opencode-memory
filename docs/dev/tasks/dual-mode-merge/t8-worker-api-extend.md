---
name: "Worker API 扩展 + 测试"
phase: 2
depends_on: ["T7"]
labels: ["backend"]
worktree_root: ".worktree/t8-worker-api-extend/"
test_commands:
  - "pnpm --filter @cfmem/api test"
  - "pnpm --filter @cfmem/api typecheck"
verify_commands:
  - "pnpm --filter @cfmem/api test"
  - "pnpm --filter @cfmem/api typecheck"
  - "wrangler dev"  # 手动验证
tdd:
  mode: strict
  min_cycles: 2
acceptance:
  - criteria: "POST /api/memories 接受新增 file_type, project_id, date 字段"
    verification_type: test
    test_command: "pnpm --filter @cfmem/api test"
  - criteria: "POST /api/memories/search 接受新增 file_type, project_id 过滤参数"
    verification_type: test
    test_command: "pnpm --filter @cfmem/api test"
  - criteria: "GET /api/memories 支持 file_type, project_id 查询参数过滤"
    verification_type: test
    test_command: "pnpm --filter @cfmem/api test"
  - criteria: "indexing.ts 的 Vectorize metadata 包含 project_id, file_type, date"
    verification_type: manual
  - criteria: "D1 写入新记录时 project_id, file_type, date 正确持久化"
    verification_type: manual
  - criteria: "hybridSearch 支持按 file_type, project_id 过滤"
    verification_type: manual
---

# T8: Worker API 扩展 + 测试

**阶段**：Phase 2 — Worker 扩展
**依赖**：T7（D1 Migration 0006）
**标签**：`backend`
**预估**：2h

## 目标

扩展 Worker API 的所有端点，支持 `project_id`、`file_type`、`date` 三个新字段的读写和过滤，并编写对应的单元测试。

## 背景

当前 Worker API 的 `memories` 表只有 `kind` 和 `tags` 用于分类，新增三字段后可以实现与插件文件系统完全对应的逻辑隔离。

## 实现步骤

### 1. 扩展 Zod schema（`worker/src/index.ts`）

在 `memorySchema` 中新增可选字段：

```typescript
const memorySchema = z.object({
  text: z.string().min(1).max(10000),
  tags: z.array(z.string()).optional(),
  kind: z.enum(['short', 'long']).optional(),
  file_type: z.enum(['memory', 'identity', 'user', 'daily']).optional(),  // 🆕
  project_id: z.string().max(200).optional(),  // 🆕
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // 🆕
})
```

### 2. 扩展 `semanticSearchSchema`

```typescript
const semanticSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  topK: z.number().int().min(1).max(20).optional(),
  file_type: z.string().optional(),  // 🆕
  project_id: z.string().optional(),  // 🆕
})
```

### 3. 扩展 `createMemory()`（`memory-service.ts`）

- `CreateMemoryOptions` 新增 `file_type`, `project_id`, `date`
- SQL INSERT 语句新增三个字段和对应的绑定参数
- `upsertMemoryVector` 调用时传递新字段到 Vectorize metadata

### 4. 扩展 `indexing.ts`

`upsertMemoryVector` 的 Vectorize metadata 新增：

```typescript
metadata: {
  user_id: memory.user_id,
  kind: memory.kind,
  created_at: memory.created_at,
  project_id: memory.project_id || '',      // 🆕
  file_type: memory.file_type || 'memory',  // 🆕
  date: memory.date || '',                  // 🆕
}
```

### 5. 扩展搜索端点

#### POST /api/memories/search
- `hybridSearch` 传递 `file_type` 和 `project_id` 过滤参数
- `retrieveRankedMemories` 的 Vectorize filter 新增 `project_id` 和 `file_type`

#### GET /api/memories
- 请求参数新增 `file_type`, `project_id`, `date`
- `listMemories` SQL 新增 WHERE 条件：
  ```sql
  AND (project_id = ? OR ? = '')
  AND (file_type = ? OR ? = '')
  AND (date = ? OR ? = '')
  ```

### 6. 扩展 `Memory` 类型（`@cfmem/shared`）

在 `packages/shared/src/schema.ts` 中扩展 `Memory` 接口：

```typescript
export interface Memory {
  // ... existing fields
  project_id: string;    // 🆕
  file_type: string;     // 🆕
  date?: string;         // 🆕
}
```

### 7. 编写测试

在 `worker/src/` 中新增或扩展测试文件：

- `createMemory` 写入带新字段的记忆，读取验证
- `searchMemories` 按 `file_type` 和 `project_id` 过滤搜索
- `listMemories` 按新字段查询过滤

### 8. 验证

```bash
pnpm --filter @cfmem/api test
pnpm --filter @cfmem/api typecheck
wrangler dev  # 手动 curl 验证新端点
```

## 文件变更

| 操作 | 文件 |
|------|------|
| ✏️ 修改 | `worker/src/index.ts`（Zod schema + 路由） |
| ✏️ 修改 | `worker/src/services/memory-service.ts`（SQL + 类型） |
| ✏️ 修改 | `worker/src/search/indexing.ts`（Vectorize metadata） |
| ✏️ 修改 | `worker/src/search/hybrid.ts`（搜索过滤） |
| ✏️ 修改 | `packages/shared/src/schema.ts`（Memory 类型） |
| 🆕 新增 | `worker/src/services/memory-service.test.ts`（或扩展已有） |

## 注意事项

- **Vectorize metadata index**：如果当前 Vectorize index 未预定义 `project_id`、`file_type`、`date` 的 metadata index，需要在 Cloudflare Dashboard 中重建 Vectorize index 以支持过滤
- **最终一致性**：新增 Vectorize metadata filter 后，写入后搜索结果可能延迟出现（<5min），这是预期行为
- **向后兼容**：所有新字段均为可选，旧版 API 调用方不受影响
