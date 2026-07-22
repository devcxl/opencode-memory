---
name: "迁移 web/"
phase: 1
depends_on: ["T1"]
labels: ["frontend"]
worktree_root: ".worktree/t3-migrate-web/"
test_commands:
  - "pnpm --filter @cfmem/web typecheck"
verify_commands:
  - "ls web/src/"
  - "ls web/package.json"
  - "pnpm --filter @cfmem/web typecheck"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "web/src/ 完整迁入，React 源码不变"
    verification_type: manual
  - criteria: "web/package.json 的 @cfmem/shared 使用 workspace:*"
    verification_type: manual
  - criteria: "pnpm --filter @cfmem/web typecheck 通过"
    verification_type: test
    test_command: "pnpm --filter @cfmem/web typecheck"
---

# T3: 迁移 web/

**阶段**：Phase 1 — 仓库合并
**依赖**：T1（pnpm workspace 设置）
**标签**：`frontend`
**预估**：1h

## 目标

将 cloudflare-memory 的 Web UI（React SPA）迁移到合并仓库的 `web/` 目录。

## 背景

cloudflare-memory 的 Web UI 提供记忆管理的浏览器界面。迁入后通过 Worker 的 `[assets]` 配置作为静态资源托管。本次迁移不改功能，纯文件搬迁。

## 实现步骤

### 1. 复制源文件

从 `/home/devcxl/Projects/CloudflareProjects/cloudflare-memory/apps/web/` 复制到 `web/`：

```
apps/web/src/**/*     → web/src/
apps/web/package.json → web/package.json（需修改）
apps/web/tsconfig.json → web/tsconfig.json（需修改）
apps/web/vite.config.* → web/vite.config.*（如有）
apps/web/index.html    → web/index.html（如有）
```

### 2. 调整 `web/package.json`

- 更新 `@cfmem/shared` 依赖为 `"workspace:*"`
- `name` 保持 `@cfmem/web`
- 保持其他依赖不变

### 3. 调整 `web/tsconfig.json`

- `extends` 路径调整为正确的根类型配置路径

### 4. 验证

```bash
pnpm --filter @cfmem/web typecheck
```

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `web/` 整个目录 |
| ✏️ 修改 | `web/package.json`（workspace 依赖路径） |
| ✏️ 修改 | `web/tsconfig.json`（extends 路径） |

## 注意事项

- 排除 `node_modules/` 和 `dist/`
- Web UI 构建产物（dist/）在本地开发时不生成，`wrangler.toml` 中的 `[assets]` 引用 `../web/dist`，部署前需先 `build:web`
