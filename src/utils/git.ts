import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";
import { getMemoryDir } from "./config.js";

export async function ensureGitRepo(): Promise<void> {
  const memoryDir = getMemoryDir();
  const gitDir = path.join(memoryDir, ".git");

  if (fs.existsSync(gitDir)) {
    return;
  }

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

export async function gitCommit(operation: string): Promise<void> {
  const memoryDir = getMemoryDir();

  await ensureGitRepo();

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
    await $`git add .`.cwd(repoRoot).quiet();
    const status = await $`git status --porcelain`.cwd(repoRoot).text();

    if (!status.trim()) {
      return;
    }

    await $`git commit -m ${operation}`.cwd(repoRoot).quiet();
  } catch (err) {
    const errorMessage = (err as Error).message;
    if (!errorMessage.includes("nothing to commit")) {
      console.error(`[git] Commit failed: ${errorMessage}`);
    }
  }
}
