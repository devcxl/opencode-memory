---
slug: "optimize-git-init"
createdAt: "2026-05-29T18:56:23.721Z"
---

# Proposal: optimize-git-init

## 问题

当前 `ensureGitRepo()`（`src/git.ts:6-23`）仅通过检查 `{memoryDir}/.git` 目录是否存在来决定是否执行 `git init`。当用户已通过上层目录（如 `~/.config/opencode/`）对配置进行 git 管理时，memory 目录已在父级 git work tree 中，此时在 memory 目录内再次执行 `git init` 会导致嵌套 git 仓库，破坏预期行为。

## 方案

- 在 `ensureGitRepo()` 中增加父级 git work tree 检测（`git rev-parse --is-inside-work-tree`）
- 若 memory 目录已在父级仓库中，跳过 `git init`
- `gitCommit()` 适配父仓库场景：在父仓库根目录执行 `git add` / `git commit`，避免仅提交 memory 子目录导致上下文丢失
- **不新增 git push 功能**，推送由用户自行完成

## 影响

- 改动文件：`src/git.ts`（主要）
- 不改动向量索引、文件写入、MemoryManager 其他部分、tool 定义
