---
name: "迁移 shared/"
phase: 1
depends_on: ["T1"]
labels: ["config"]
worktree_root: ".worktree/t4-migrate-shared/"
test_commands:
  - "pnpm --filter @cfmem/shared typecheck"
verify_commands:
  - "ls packages/shared/src/schema.ts"
  - "ls packages/shared/package.json"
  - "pnpm --filter @cfmem/shared typecheck"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "packages/shared/src/schema.ts 完整迁入"
    verification_type: manual
  - criteria: "packages/shared/package.json 的 name 为 @cfmem/shared"
    verification_type: manual
  - criteria: "pnpm --filter @cfmem/shared typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/shared typecheck"
---

# T4: 迁移 shared/

**阶段**：Phase 1 — 仓库合并
**依赖**：T1（pnpm workspace 设置）
**标签**：`config`
**预估**：0.5h

## 目标

将 cloudflare-memory 的 `packages/shared/` 迁入合并仓库，作为 Worker 和插件共享的类型定义包。

## 背景

`@cfmem/shared` 是 cloudflare-memory 的共享类型包，定义了 `Memory`、`RateLimit` 等核心接口。迁入后作为 workspace 子包（`packages/shared/`），被 `worker/`、`web/` 和插件通过 `workspace:*` 引用。

## 实现步骤

### 1. 复制源文件

从 `/home/devcxl/Projects/CloudflareProjects/cloudflare-memory/packages/shared/` 复制到 `packages/shared/`：

```
packages/shared/src/**/*     → packages/shared/src/
packages/shared/package.json → 保持不变
packages/shared/tsconfig.json → 保持不变
```

### 2. 验证

```bash
pnpm --filter @cfmem/shared typecheck
```

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `packages/shared/` 整个目录 |

## 注意事项

- 这是改动最小的任务 — opencode-memory 根目录下已有 `packages/` 的 workspace 配置
- `@cfmem/shared` 的 `package.json` 不需要修改（已是标准 npm 包结构）
- 后续 T10（Provider 接口定义）和 T8（Worker API 扩展）会扩展 `shared/` 的类型定义
