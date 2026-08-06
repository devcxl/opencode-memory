import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";
import { getMemoryDir } from "../config/runtime.js";

/**
 * 确保 memory 目录是一个 git 仓库。
 * 如果已有 .git 或在已有仓库中则跳过；否则初始化并设置 identity。
 * 用 git 做版本管理而非手动备份，降低数据丢失风险。
 */
export async function ensureGitRepo(
  memoryDir: string = getMemoryDir(),
): Promise<void> {
  const gitDir = path.join(memoryDir, ".git");

  if (fs.existsSync(gitDir)) {
    return;
  }

  // 检查是否已属于某个 git 仓库（例如用户自己的项目）
  try {
    const insideWorkTree = await $`git rev-parse --is-inside-work-tree`
      .cwd(memoryDir)
      .quiet()
      .text();
    if (insideWorkTree.trim() === "true") {
      return;
    }
  } catch {}

  try {
    await $`git init`.cwd(memoryDir).quiet();
    await $`git config user.name "OpenCode Memory"`.cwd(memoryDir).quiet();
    await $`git config user.email "memory@opencode.local"`
      .cwd(memoryDir)
      .quiet();
  } catch (err) {
    console.error(`[git] Failed to initialize repo: ${(err as Error).message}`);
  }
}

/**
 * 执行 git add + commit。
 * 先确保仓库存在，再检查是否有变更，没有变更则跳过提交。
 *
 * 路径安全：
 * - 先找到真正的 repo root（支持 memory 目录为现有仓库子目录的场景）
 * - 校验相对路径不超出 repo 根目录（防止路径穿越）
 * - 仅对具体文件路径 add + commit，避免意外提交整个目录
 *
 * @param operation - 用于 commit message 的操作描述，如 "write: daily/2026-06-06.md"
 */
export async function gitCommit(
  operation: string,
  filePath: string,
  memoryDir: string = getMemoryDir(),
  extraPaths: string[] = [],
): Promise<void> {
  await ensureGitRepo(memoryDir);

  // 找到真正的仓库根目录（memory 目录可能属于另一个 git 仓库的子目录）
  let repoRoot = memoryDir;
  try {
    const root = await $`git rev-parse --show-toplevel`
      .cwd(memoryDir)
      .quiet()
      .text();
    if (root.trim()) {
      repoRoot = root.trim();
    }
  } catch {}

  try {
    const relativePath = path.relative(repoRoot, filePath);
    // 路径穿越检查：相对路径不能以 .. 开头或为绝对路径
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      console.error(`[git] Refusing to commit path outside repo: ${filePath}`);
      return;
    }

    // 收集所有需要 stage 的路径：主文件 + 索引文件
    const allPaths = [relativePath];
    for (const extra of extraPaths) {
      const relExtra = path.relative(repoRoot, extra);
      if (
        relExtra !== ".." &&
        !relExtra.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relExtra)
      ) {
        allPaths.push(relExtra);
      }
    }

    // 过滤不存在的文件（如 embedding 引擎未初始化时索引文件未被创建）
    const existingPaths = allPaths.filter((p) =>
      fs.existsSync(path.join(repoRoot, p)),
    );

    if (existingPaths.length === 0) {
      return;
    }

    // 过滤被 .gitignore 忽略的路径（如 daily.index 目录），避免 git add 失败
    const pathsToStage: string[] = [];
    for (const p of existingPaths) {
      try {
        const ignored = await $`git check-ignore -q ${p}`
          .cwd(repoRoot)
          .quiet()
          .nothrow();
        if (ignored.exitCode !== 0) {
          pathsToStage.push(p);
        }
      } catch {
        pathsToStage.push(p);
      }
    }

    if (pathsToStage.length === 0) {
      return;
    }

    // 一次性 stage 所有路径
    await $`git add ${pathsToStage}`.cwd(repoRoot).quiet();

    // 检查是否有变更
    const status = await $`git status --porcelain ${pathsToStage}`
      .cwd(repoRoot)
      .text();

    // 无变更时不生成空 commit，避免干扰历史
    if (!status.trim()) {
      return;
    }

    await $`git commit -m ${operation} ${pathsToStage}`.cwd(repoRoot).quiet();
  } catch (err) {
    const errorMessage = (err as Error).message;
    if (!errorMessage.includes("nothing to commit")) {
      console.error(`[git] Commit failed: ${errorMessage}`);
    }
  }
}
