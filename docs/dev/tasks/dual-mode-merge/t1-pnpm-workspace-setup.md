---
name: "pnpm workspace 设置"
phase: 1
depends_on: []
labels: ["config"]
worktree_root: ".worktree/t1-pnpm-workspace/"
test_commands:
  - "pnpm typecheck"
verify_commands:
  - "pnpm -r run typecheck"
  - "ls pnpm-workspace.yaml"
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "pnpm-workspace.yaml 定义子包路径：worker/, web/, packages/*"
    verification_type: manual
  - criteria: "根 package.json 包含 workspace scripts（typecheck, dev, build）"
    verification_type: manual
  - criteria: "bun.lock 已删除"
    verification_type: manual
  - criteria: "pnpm install 无报错"
    verification_type: test
    test_command: "pnpm install"
  - criteria: "pnpm typecheck 递归通过"
    verification_type: test
    test_command: "pnpm -r run typecheck"
---

# T1: pnpm workspace 设置

**阶段**：Phase 1 — 仓库合并
**依赖**：无
**标签**：`config`
**预估**：1h

## 目标

在 opencode-memory 根目录建立 pnpm workspace，为后续子包迁移做准备。

## 背景

当前 opencode-memory 使用 Bun 管理依赖（bun.lock），cloudflare-memory 使用 pnpm workspace。合并后统一使用 pnpm workspace，Bun 仅用于插件测试（bun test）。

## 实现步骤

### 1. 创建 `pnpm-workspace.yaml`

```yaml
packages:
  - "worker"
  - "web"
  - "packages/*"
allowBuilds:
  esbuild: true
  msgpackr-extract: true
  sharp: true
  workerd: true
```

### 2. 更新根 `package.json`

- 新增 workspace scripts：
  - `"typecheck": "pnpm -r run typecheck"`
  - `"dev": "pnpm --filter @cfmem/api dev"`
  - `"build:web": "pnpm --filter @cfmem/web build"`
- 保留原插件相关 scripts（build, test 等由 `pnpm --filter @devcxl/opencode-memory` 调用）
- 设置 `"private": true`（monorepo 根）

### 3. 移除 Bun 锁文件

- 删除 `bun.lock`（或 `bun.lockb`）
- 保留 `bunfig.toml`（如有，用于 bun test 配置）

### 4. 执行安装

```bash
pnpm install
```

### 5. 验证

```bash
pnpm -r run typecheck
```

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `pnpm-workspace.yaml` |
| ✏️ 修改 | `package.json` |
| ❌ 删除 | `bun.lock` 或 `bun.lockb` |

## 注意事项

- cloudflare-memory 的 `pnpm-workspace.yaml` 包含 `allowBuilds` 配置（esbuild, sharp, workerd），这些需要迁移到合并后的 workspace
- 插件自身的 `package.json` 中 Bun 相关脚本保持不变（`bun test` 由 pnpm 调用）
- 不要在根 `package.json` 中添加 `@devcxl/opencode-memory` 作为 workspace 包（它本身就是根包）
