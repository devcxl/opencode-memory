---
name: "迁移 worker/"
phase: 1
depends_on: ["T1"]
labels: ["backend"]
worktree_root: ".worktree/t2-migrate-worker/"
test_commands:
  - "pnpm --filter @cfmem/api typecheck"
verify_commands:
  - "ls worker/src/index.ts"
  - "ls worker/wrangler.toml"
  - "ls worker/migrations/"
  - "pnpm --filter @cfmem/api typecheck"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "worker/src/index.ts 完整迁入，文件结构不变"
    verification_type: manual
  - criteria: "worker/wrangler.toml 存在，assets directory 指向 ../web/dist"
    verification_type: manual
  - criteria: "worker/migrations/ 目录包含所有现有 migration 文件"
    verification_type: manual
  - criteria: "worker/package.json 的 workspace 依赖引用正确（@cfmem/shared: workspace:*）"
    verification_type: manual
  - criteria: "pnpm --filter @cfmem/api typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/api typecheck"
---

# T2: 迁移 worker/

**阶段**：Phase 1 — 仓库合并
**依赖**：T1（pnpm workspace 设置）
**标签**：`backend`
**预估**：1.5h

## 目标

将 cloudflare-memory 的 `apps/api/` 完整迁移到合并仓库的 `worker/` 目录，调整路径引用使其在 pnpm workspace 中可构建。

## 背景

cloudflare-memory 的 Worker API 是远程模式的核心后端。需要将其迁入合并仓库的 `worker/` 子目录，保持与 `@cfmem/shared` 和 `web/` 的 workspace 依赖关系。

## 实现步骤

### 1. 复制源文件

从 `/home/devcxl/Projects/CloudflareProjects/cloudflare-memory/apps/api/` 复制到 `worker/`：

```
apps/api/src/**/*       → worker/src/
apps/api/migrations/    → worker/migrations/
apps/api/wrangler.toml  → worker/wrangler.toml
apps/api/package.json   → worker/package.json（需修改）
apps/api/tsconfig.json  → worker/tsconfig.json（需修改）
```

### 2. 调整 `worker/package.json`

- 更新 `@cfmem/shared` 依赖为 `"workspace:*"`（如尚未使用）
- 保持其他依赖不变
- `name` 保持 `@cfmem/api`

### 3. 调整 `worker/tsconfig.json`

- `extends` 路径从 `../../tsconfig.json` 调整为 `../tsconfig.base.json`（或相应的根配置路径）
- 确保 `paths` 中 `@cfmem/shared` 指向 `../packages/shared/src`

### 4. 调整 `worker/wrangler.toml`

- `[assets]` 的 `directory` 从 `"../web/dist"` 调整为 `"../web/dist"`（如果运行目录在 worker/，路径不变；如果相对于仓库根，需确认）

### 5. 验证

```bash
pnpm --filter @cfmem/api typecheck
```

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `worker/` 整个目录 |
| ✏️ 修改 | `worker/package.json`（依赖路径） |
| ✏️ 修改 | `worker/tsconfig.json`（extends 路径） |

## 排除项

- 不迁移 `apps/plugin/`（MCP client 废弃）
- 不迁移 `apps/api/src/mcp/`（后续 T16 删除）

## 注意事项

- copy 时排除 `node_modules/` 和 `.wrangler/`
- 复制后不要立即 `pnpm install`，等待所有子包迁移完成后统一安装
- 保留原有的 `.gitignore` 和 wrangler 相关配置
