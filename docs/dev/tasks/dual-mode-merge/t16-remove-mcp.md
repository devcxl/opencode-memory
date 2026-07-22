---
name: "删除 MCP 代码"
phase: 4
depends_on: ["T15"]
labels: ["backend"]
worktree_root: ".worktree/t16-remove-mcp/"
test_commands:
  - "pnpm --filter @cfmem/api typecheck"
  - "pnpm --filter @cfmem/api test"
verify_commands:
  - "! test -f worker/src/mcp/agent.ts"
  - "pnpm --filter @cfmem/api typecheck"
  - "pnpm --filter @cfmem/api test"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "worker/src/mcp/agent.ts 已删除"
    verification_type: manual
  - criteria: "Worker POST /mcp 和 GET /mcp 路由已移除"
    verification_type: manual
  - criteria: "@modelcontextprotocol/sdk 依赖已删除"
    verification_type: manual
  - criteria: "pnpm --filter @cfmem/api typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/api typecheck"
  - criteria: "Worker wrangler dev 正常启动"
    verification_type: manual
---

# T16: 删除 MCP 代码

**阶段**：Phase 4 — 清理
**依赖**：T15（端到端集成测试通过）
**标签**：`backend`
**预估**：0.5h

## 目标

清除 cloudflare-memory 中废弃的 MCP 协议相关代码，包括 Worker 端的 MCP agent、路由和依赖。

## 背景

ADM-002 确认远程模式使用直调 REST API 替代 MCP 协议。cloudflare-memory 原有的 MCP agent（`src/mcp/agent.ts`）和 MCP 路由（`POST /mcp`、`GET /mcp`）不再需要，应清理。

## 实现步骤

### 1. 删除 MCP agent 文件

```bash
rm worker/src/mcp/agent.ts
# 如果 mcp/ 目录为空，同时删除目录
rmdir worker/src/mcp/ 2>/dev/null || true
```

### 2. 移除 MCP 路由（`worker/src/index.ts`）

删除以下代码段：

```typescript
// 删除 MCP 相关 import
- import { MemoryMCP } from './mcp/agent'

// 删除 MCP 认证中间件
- app.use('/mcp', authMiddleware)

// 删除 POST /mcp 路由
- app.post('/mcp', async (c) => { ... })

// 删除 GET /mcp SSE 路由
- app.get('/mcp', async (c) => { ... })
```

同时更新 `wrangler.toml` 中的 `run_worker_first`：

```toml
# 从
run_worker_first = ["/api/*", "/mcp", "/health"]
# 改为
run_worker_first = ["/api/*", "/health"]
```

### 3. 移除 MCP 依赖

```bash
pnpm --filter @cfmem/api remove @modelcontextprotocol/sdk
```

如果 `@modelcontextprotocol/sdk` 不在 `worker/package.json` 的 dependencies 中（可能是在 cloudflare-memory 根 package.json），检查并移除。

### 4. 清理 MCP 类型引用

搜索 Worker 代码中残留的 MCP 类型 import（如 `import type { ... } from '@modelcontextprotocol/sdk'`），全部清理。

### 5. 验证

```bash
pnpm --filter @cfmem/api typecheck
pnpm --filter @cfmem/api test
wrangler dev  # 确认 Worker 正常启动
```

## 文件变更

| 操作 | 文件 |
|------|------|
| ❌ 删除 | `worker/src/mcp/agent.ts`（及空目录 `worker/src/mcp/`） |
| ✏️ 修改 | `worker/src/index.ts`（移除 MCP 路由和 import） |
| ✏️ 修改 | `worker/wrangler.toml`（移除 `/mcp` from run_worker_first） |
| ✏️ 修改 | `worker/package.json`（移除 @modelcontextprotocol/sdk 依赖） |

## 注意事项

- 删除前确认没有测试文件引用 `./mcp/agent`
- MCP 相关的测试文件（如 `worker/src/mcp/__tests__/`）也应一并删除
- 如果 `@modelcontextprotocol/sdk` 也是其他子包的依赖（不太可能），不要从根 workspace 移除
- 如果 cloudflare-memory 的 `apps/plugin/` 目录未被 T2 迁移（应该没有），无需额外处理
