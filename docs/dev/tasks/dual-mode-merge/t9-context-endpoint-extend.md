---
name: "context 端点扩展"
phase: 2
depends_on: ["T7"]
labels: ["backend"]
worktree_root: ".worktree/t9-context-endpoint-extend/"
test_commands:
  - "pnpm --filter @cfmem/api test"
  - "pnpm --filter @cfmem/api typecheck"
verify_commands:
  - "pnpm --filter @cfmem/api test"
  - "wrangler dev"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "GET /api/context?project_id=owner/repo 返回项目级记忆摘要"
    verification_type: manual
  - criteria: "GET /api/context（无 project_id）返回全局记忆摘要"
    verification_type: manual
  - criteria: "返回格式匹配插件注入模板（按 MEMORY > IDENTITY > USER > PROJECT 分类）"
    verification_type: manual
  - criteria: "GET /api/stats 支持 project_id 过滤统计"
    verification_type: manual
---

# T9: context 端点扩展

**阶段**：Phase 2 — Worker 扩展
**依赖**：T7（D1 Migration 0006）
**标签**：`backend`
**预估**：1h

## 目标

扩展 `GET /api/context` 和 `GET /api/stats` 端点，支持按 `project_id` 和 `file_type` 过滤，使远程模式下的 system prompt 注入与本地模式语义一致。

## 背景

当前 `GET /api/context` 端点返回所有 long-term + recent short-term 记忆的混合摘要，不区分 file_type 和 project_id。远程模式下需要按 file_type 返回分类记忆（MEMORY > IDENTITY > USER > PROJECT），匹配本地模式的 `getContextFiles()` 输出格式。

## 实现步骤

### 1. 扩展 `GET /api/context`

#### 新增查询参数
- `project_id?: string` — 项目 ID 过滤

#### 新查询逻辑
按 file_type 分类查询（替代原有的 kind=long + kind=short 分类）：

```typescript
app.get('/api/context', async (c) => {
  const userId = c.get('userId') as string
  const projectId = c.req.query('project_id') || ''

  // 按 file_type 分别查询
  const queries = [
    // MEMORY.md（全局 + 项目）
    c.env.DB.prepare(
      `SELECT text, created_at FROM memories
       WHERE user_id = ? AND file_type = 'memory' AND kind = 'long'
         AND (project_id = ? OR ? = '')
         AND archived = 0
       ORDER BY created_at DESC LIMIT 10`
    ).bind(userId, projectId, projectId),
    // IDENTITY.md
    c.env.DB.prepare(
      `SELECT text, created_at FROM memories
       WHERE user_id = ? AND file_type = 'identity' AND kind = 'long'
         AND archived = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userId),
    // USER.md
    c.env.DB.prepare(
      `SELECT text, created_at FROM memories
       WHERE user_id = ? AND file_type = 'user' AND kind = 'long'
         AND archived = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userId),
  ]

  // 并行执行所有查询
  const [memoryRows, identityRows, userRows] = await Promise.all(
    queries.map(q => q.all<{ text: string; created_at: number }>())
  )

  // 按插件注入格式构建 context
  const sections: string[] = []
  if (memoryRows.results?.length) {
    sections.push('## MEMORY.md\n\n' + memoryRows.results.map(r =>
      `<!-- ${new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)} -->\n${r.text}`
    ).join('\n\n'))
  }
  // ... identity, user 同理

  const context = sections.join('\n\n---\n\n')
  return c.json({ success: true, data: context })
})
```

### 2. 扩展 `GET /api/stats`

新增 `project_id` 查询参数，按项目统计记忆数量：

```typescript
app.get('/api/stats', async (c) => {
  const userId = c.get('userId') as string
  const projectId = c.req.query('project_id')
  // ... 统计查询增加 project_id 过滤
})
```

### 3. 验证

```bash
# 写入测试数据
curl -X POST http://localhost:8787/api/memories \
  -H "Authorization: Bearer <JWT>" \
  -d '{"text":"测试记忆","kind":"long","file_type":"memory","project_id":"test/proj"}'

# 查询 context
curl http://localhost:8787/api/context?project_id=test/proj \
  -H "Authorization: Bearer <JWT>"
```

## 文件变更

| 操作 | 文件 |
|------|------|
| ✏️ 修改 | `worker/src/index.ts`（context 和 stats 路由） |

## 注意事项

- context 输出格式需匹配 `src/instructions/memoryInstructions.ts` 的注入模板（`## MEMORY.md` 等标题格式）
- IDENTITY 和 USER 是全局概念（不区分项目），不需要 project_id 过滤
- daily 日志不注入 system prompt（量太大），仅 memory/identity/user 注入
