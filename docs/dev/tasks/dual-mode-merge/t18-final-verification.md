---
name: "最终验证"
phase: 4
depends_on: ["T16", "T17"]
labels: ["backend", "config"]
worktree_root: ".worktree/t18-final-verification/"
test_commands:
  - "pnpm -r run typecheck"
  - "bun test"
  - "pnpm --filter @devcxl/opencode-memory build"
verify_commands:
  - "pnpm -r run typecheck"
  - "bun test"
  - "pnpm --filter @devcxl/opencode-memory build"
  - "pnpm --filter @cfmem/api dev"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "pnpm -r run typecheck 全仓库递归通过"
    verification_type: test
    test_command: "pnpm -r run typecheck"
  - criteria: "bun test 全部通过（local 模式无回归）"
    verification_type: test
    test_command: "bun test"
  - criteria: "pnpm run build 产出 dist/ 目录（含 instructions/*.md）"
    verification_type: test
    test_command: "pnpm --filter @devcxl/opencode-memory build"
  - criteria: "wrangler dev 正常启动，Worker API 可用"
    verification_type: manual
  - criteria: "local 模式手动验证：write/search/read/delete/list 全功能正常"
    verification_type: manual
  - criteria: "remote 模式手动验证：wrangler dev + mode=remote 全功能端到端"
    verification_type: manual
  - criteria: "web/ 构建产物可正常托管（可选）"
    verification_type: manual
---

# T18: 最终验证

**阶段**：Phase 4 — 清理
**依赖**：T16（删除 MCP 代码）, T17（文档更新）
**标签**：`backend`, `config`
**预估**：1h

## 目标

在所有代码改动完成后，执行全链路验证，确保仓库可构建、可测试、可部署。

## 实现步骤

### 1. 全仓库类型检查

```bash
pnpm -r run typecheck
```

确认所有子包类型检查通过：
- `@devcxl/opencode-memory`（插件）
- `@cfmem/api`（Worker）
- `@cfmem/web`（Web UI）
- `@cfmem/shared`（共享类型）

### 2. 插件构建

```bash
pnpm --filter @devcxl/opencode-memory build
```

验证：
- `dist/index.js` 产出正确
- `dist/instructions/*.md` 已复制
- `dist/index.d.ts` 类型声明生成

### 3. 全量测试

```bash
bun test
```

验证：
- `tests/high-risk.test.ts` — local 模式高风险回归测试
- `tests/remote-providers.test.ts` — remote Provider mock 测试
- `tests/provider-factory.test.ts` — Provider 工厂测试
- `tests/memorymanager-injection.test.ts` — MemoryManager 注入测试
- `tests/config.test.ts` — 配置加载测试

### 4. Worker 本地启动

```bash
cd worker && wrangler dev
```

验证：
- Worker 正常启动（无 import 错误）
- `/health` 返回 `"OK"`
- `/api/memories` 可正常访问（需要 JWT token）
- `/api/stats` 返回统计数据
- Web UI（如有 `web/dist/`）可正常访问

### 5. Local 模式手动验证

使用默认配置（mode=local），在 opencode 环境中执行：

```bash
memory --action write --target memory --content '测试记忆'
memory --action search --query '测试'
memory --action read --target memory
memory --action delete --target memory --timestamp '2026-07-22 00:00:00'
memory --action list
```

### 6. Remote 模式手动验证

配置 `mode=remote` + `apiUrl=http://localhost:8787`，执行与 local 模式相同的测试序列：

```bash
# 先确保 Worker wrangler dev 运行中
memory --action write --target memory --content '远程测试记忆'
memory --action search --query '远程'
memory --action read --target memory
memory --action write --target daily --content '今日任务：完成双模式合并'
```

验证：
- 写入后 D1 中有新记录
- 搜索能返回结果（注意 Vectorize 延迟，等待 1-2 分钟）
- context 注入包含正确的记忆摘要

### 7. Web UI 构建（可选）

```bash
pnpm --filter @cfmem/web build
```

验证 `web/dist/` 产物存在。

## 验证清单

| # | 检查项 | 命令 | 预期结果 |
|---|--------|------|----------|
| 1 | 全仓库 typecheck | `pnpm -r run typecheck` | 0 error |
| 2 | 插件构建 | `pnpm --filter @devcxl/opencode-memory build` | dist/ 生成 |
| 3 | 全量测试 | `bun test` | 全部 PASS |
| 4 | Worker 启动 | `wrangler dev` | 启动成功，/health = OK |
| 5 | local mode 手动 | memory write/search/read/delete/list | 功能正常 |
| 6 | remote mode 手动 | memory write/search/read/delete | 功能正常 |
| 7 | Web 构建 | `pnpm --filter @cfmem/web build` | dist/ 生成 |

## 文件变更

无新增/修改代码文件（仅验证操作）。

## 注意事项

- 如果 Vectorize 搜索返回空结果，等待 1-2 分钟后重试（最终一致性延迟）
- API Key（JWT）可通过 `scripts/generate-jwt.js`（如果存在）或手动用 `jose` 库生成
- 如果 `bun test` 有失败，按照 T11/T13 的实现步骤逐个排查，优先修复 local 模式回归
