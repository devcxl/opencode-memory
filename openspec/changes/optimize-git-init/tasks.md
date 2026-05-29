# Tasks: optimize-git-init

## Implementation

- [x] 1.1 修改 `ensureGitRepo()`：在本地 `.git` 检查后、`git init` 前，增加父级 git work tree 检测
  - 通过 `git rev-parse --is-inside-work-tree` 检测
  - 检测到父仓库 → 直接 return（跳过 init + config）
  - 异常 → 静默回退到本地 init 逻辑
- [x] 1.2 修改 `gitCommit()`：通过 `git rev-parse --show-toplevel` 获取仓库根目录
  - 父仓库场景下，`cwd` 切换为父仓库根目录
  - 本地仓库或无仓库场景下，`cwd` 保持为 memoryDir
- [x] 1.3 运行 `npm run typecheck` 确保编译通过

## Verification

- [x] 2.1 场景一验证：memory 目录不在任何 git 仓库中 → 行为与当前一致
  - 确保 `~/.config/opencode/memory/` 不在任何仓库中
  - 触发写入操作，确认 `git init` 正常执行，commit 在 memoryDir 完成
- [x] 2.2 场景二验证：memory 目录已在父级 git 仓库中
  - 在 `~/.config/opencode/` 执行 `git init`，模拟父仓库
  - 触发写入操作，确认不创建 `~/.config/opencode/memory/.git`
  - 确认 commit 在 `~/.config/opencode/` 根目录完成
- [x] 2.3 场景三（边缘）验证：memory 目录自身已有 `.git`，但父级也有仓库
  - 手动在 memory 目录执行 `git init`，同时父级也是仓库
  - 触发写入操作，确认使用 memory 自身的 `.git`（不切换到父仓库）
- [x] 2.4 异常降级验证：git 未安装
  - 模拟 git 不可用（PATH 中移除 git）
  - 触发写入操作，确认不抛异常，写入正常完成
