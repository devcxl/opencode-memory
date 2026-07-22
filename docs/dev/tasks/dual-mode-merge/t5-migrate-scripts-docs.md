---
name: "迁移 scripts/docs"
phase: 1
depends_on: ["T1"]
labels: ["config"]
worktree_root: ".worktree/t5-migrate-scripts-docs/"
test_commands: []
verify_commands:
  - "ls scripts/"
  - "ls -la docs/"  # 检查是否有需要合并的文档
tdd:
  mode: strict
  min_cycles: 1
acceptance:
  - criteria: "cloudflare-memory 的脚本和配置文件迁入 scripts/ 或相应位置"
    verification_type: manual
  - criteria: "不迁入 .github/ (CI 延后到 Phase 4)"
    verification_type: manual
---

# T5: 迁移 scripts/docs

**阶段**：Phase 1 — 仓库合并
**依赖**：T1（pnpm workspace 设置）
**标签**：`config`
**预估**：0.5h

## 目标

将 cloudflare-memory 的辅助脚本和配置文档迁入合并仓库，同时清理不需要的文件。

## 背景

cloudflare-memory 根目录有一些辅助脚本（如 JWT 生成脚本、部署脚本）和配置文件，需要选择性迁入合并仓库。

## 实现步骤

### 1. 检查 cloudflare-memory 根目录

需要迁入的文件（如有）：
- `scripts/` 目录中的工具脚本
- `docs/` 中的项目文档
- `.env.example` 或类似配置模板

### 2. 排除的文件（不迁入）

- `.github/` — CI 延后到 Phase 4
- `README.md` — 内容合并到根 README（T17 处理）
- cloudflare-memory 根 `package.json` — 已被新的 workspace 根配置替代

### 3. 放置位置

- 脚本文件 → 仓库根 `scripts/` 目录
- 文档 → 如果已有 `docs/`，检查冲突后合并

### 4. 清理

- 删除 opencode-memory 中已被替代的冗余配置

## 文件变更

| 操作 | 文件 |
|------|------|
| 🆕 新增 | `scripts/` 中的工具脚本 |
| ❌ 排除 | `.github/` |

## 注意事项

- 以最小迁移为原则 — 不需要的脚本不搬
- 如果 cloudflare-memory 没有额外的 scripts/，此任务可以标记为已完成（NOP）
- 不要覆盖 opencode-memory 已有的 scripts
