# Design: optimize-git-init

## Overview

修改 `ensureGitRepo()` 和 `gitCommit()` 的仓库定位逻辑，使其能感知父级 git work tree，避免嵌套仓库问题。

## Goals

1. 检测父级 git work tree，避免嵌套 `git init`
2. 在父仓库场景下，commit 操作使用父仓库根目录

## Non-Goals

- 不添加 `git push` 功能
- 不修改 git remote 管理
- 不修改 commit message 格式
- 不改变向量索引、文件写入等其他模块

## Constraints

- 最小改动原则：仅改动 `src/git.ts`，不引入新依赖
- 静默降级：任何 git 检测异常不应影响业务流程
- 向后兼容：无父仓库时行为与当前完全一致

## Technical Approach

### 检测父仓库

在 `ensureGitRepo()` 中，先于本地 `.git` 检查前执行：

```typescript
// 1. 已有本地 .git → 保持现状
if (fs.existsSync(gitDir)) return;

// 2. 检测父级 work tree
try {
  const insideWorkTree = await $`git rev-parse --is-inside-work-tree`
    .cwd(memoryDir).quiet().text();
  if (insideWorkTree.trim() === "true") return; // 跳过 init
} catch {
  // 静默回退：继续尝试本地 init
}

// 3. 无父仓库 → 本地 init（现有逻辑）
```

### 在父仓库中 commit

`gitCommit()` 需要区分两种模式：

```typescript
let repoRoot = memoryDir;
try {
  const root = await $`git rev-parse --show-toplevel`
    .cwd(memoryDir).quiet().text();
  if (root.trim()) repoRoot = root.trim();
} catch {}

// 后续 git add / commit 使用 repoRoot 作为 cwd
```

### 关键决策

**为什么用 `git rev-parse --show-toplevel` 而不是直接换到父目录？**
父仓库可能不在 memory 的直接父目录，而是在更上层（如 `~/.config/`），`--show-toplevel` 能准确定位。

**为什么不把 `git add .` 改为 `git add {memoryDir}`？**
当前方案保留 `git add .`，因为父仓库场景下用户已明确对父仓库进行管理，应该提交父仓库的所有变更。若仅 add memoryDir，其他同仓库的配置变更会被遗漏，导致仓库状态不一致。

**为什么检测父仓库在本地 `.git` 检查之后？**
如果 memory 目录已有本地 `.git` 仓库（用户可能先有本地仓库后又创建父仓库），本地仓库优先，保持行为可预测。

## Alternatives Considered

| 方案 | 优劣 |
|------|------|
| **方案 A（采用）**：检测父仓库 → 跳过 init → 在父仓库根目录 commit | 直接解决问题，改动最小 |
| 方案 B：在父仓库下仅 add memoryDir | 避免误提交其他文件，但会导致 git 状态不一致（仓库根目录可见 uncommitted changes） |
| 方案 C：添加 config 选项让用户控制 | 增加复杂度，不符合最小可行原则 |

## Impacted Files / Modules

| 文件 | 改动 |
|------|------|
| `src/git.ts` | `ensureGitRepo()` 增加父仓库检测；`gitCommit()` 适配父仓库 cwd |
| 其他文件 | 无改动 |

## Risks and Mitigations

| 风险 | 缓解 |
|------|------|
| `git rev-parse --is-inside-work-tree` 在某些 git 版本中行为不一致 | try/catch 静默降级 |
| 父仓库中 `git add .` 会提交 memory 以外的文件 | commit message 已标注来源（`operation` 参数），这是符合预期的行为 |
| 检测父仓库的性能开销 | 仅执行一次 git 子命令，可忽略 |
| 父仓库没有配置 user.name/user.email 导致 commit 失败 | 与现有行为一致（之前只在本地 init 时配置），不新增处理 |
