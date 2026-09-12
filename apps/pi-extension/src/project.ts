import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";

/**
 * 项目探测（从 OpenCode 插件的 projectDetector 移植的精简版）：
 * 1. git remote origin → owner/repo
 * 2. git rev-parse --show-toplevel → basename + 路径哈希
 * 3. basename(cwd) + 路径哈希
 */

export function detectProject(cwd: string = process.cwd()): string | null {
  const resolved = path.resolve(cwd);

  const remoteId = tryGetRemoteId(resolved);
  if (remoteId) return remoteId;

  const repoRoot = tryGetRepoRoot(resolved);
  if (repoRoot) return deduplicateName(path.basename(repoRoot), repoRoot);

  return deduplicateName(path.basename(resolved), resolved);
}

function tryGetRemoteId(cwd: string): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (remoteUrl) return parseGitUrl(remoteUrl);
  } catch {}
  return null;
}

function tryGetRepoRoot(cwd: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return path.resolve(root);
  } catch {}
  return null;
}

function deduplicateName(name: string, dirPath: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(dirPath)
    .digest("hex")
    .slice(0, 8);
  return `${name}.${hash}`;
}

function parseGitUrl(url: string): string | null {
  let match: RegExpMatchArray | null;
  match = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (match) return match[1];
  match = url.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (match) return match[1];
  match = url.match(/^ssh:\/\/git@[^/]+\/(.+?)(?:\.git)?$/);
  if (match) return match[1];
  return null;
}
