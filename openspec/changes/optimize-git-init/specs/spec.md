# Spec: optimize-git-init

## Requirements

1. **父仓库检测**：`ensureGitRepo()` 必须在检查本地 `.git` 之前，先检测 memory 目录是否处于某个父级 git work tree 中
2. **避免嵌套 init**：若检测到父级 git 仓库，完全跳过 `git init` 和 `git config`
3. **父仓库 commit**：`gitCommit()` 在父仓库场景下，必须在父仓库根目录执行 `git add` 和 `git commit`，而非在 memory 目录内执行
4. **回退兼容**：若无父级仓库，保持现有行为不变（在 memory 目录初始化本地仓库）
5. **静默失败**：检测父仓库过程中任何异常（git 未安装、权限不足等）必须静默回退，不能抛异常中断写入流程

## Behavior

### 场景一：memory 目录不在任何 git 仓库中（现状）
- `ensureGitRepo()` 检测到本地无 `.git` 且无父仓库 → 执行 `git init` + config
- `gitCommit()` 在 memory 目录执行 add/commit
- 行为与当前完全一致

### 场景二：memory 目录已在父级 git 仓库中（新场景）
- `ensureGitRepo()` 通过 `git rev-parse --is-inside-work-tree` 检测到父仓库 → 跳过 init + config
- `gitCommit()` 通过 `git rev-parse --show-toplevel` 获取父仓库根目录 → 在根目录执行 add/commit
- 父仓库会跟踪 memory 目录下的所有文件变更

### 场景三：memory 目录自身已有 `.git`，且父级也有仓库（边缘）
- 优先使用 memory 自身的 `.git`（不检测父仓库），保持兼容

## Acceptance Criteria

- [ ] memory 目录在父仓库中时，不创建 `{memoryDir}/.git`
- [ ] memory 目录在父仓库中时，写入操作能正常 commit 到父仓库
- [ ] memory 目录不在任何仓库中时，行为与当前完全一致
- [ ] git 未安装或检测异常时，不影响写入流程（静默降级）
- [ ] TypeScript 编译通过：`npm run typecheck`
