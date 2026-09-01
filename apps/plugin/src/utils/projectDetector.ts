import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 探测当前目录所属的项目标识。
 *
 * 三级 fallback 策略：
 * 1. git remote origin → 解析 owner/repo（最优先，保持现有行为）
 * 2. git rev-parse --show-toplevel → repo root basename（本地仓库无 remote）
 * 3. basename(cwd) + 路径哈希去重（最后兜底）
 *
 * 特殊目录（home、dotfiles、memory 自身）返回 null。
 *
 * @param cwd - 要探测的目录路径，默认 process.cwd()
 * @returns 项目 ID 或 null
 */
export function detectProject(cwd: string = process.cwd()): string | null {
  const resolved = path.resolve(cwd);

  // 排除 home 和 dotfiles 目录（即使有 git remote 也不应识别为项目）
  if (isExcludedPath(resolved)) return null;

  // 策略 1：git remote origin → owner/repo
  const remoteId = tryGetRemoteId(resolved);
  if (remoteId) return remoteId;

  // 策略 2：git rev-parse --show-toplevel → repo root basename
  // 适用于无 remote 的本地仓库（含 worktree、submodule 等场景）
  const repoRoot = tryGetRepoRoot(resolved);
  if (repoRoot) {
    if (isExcludedPath(repoRoot)) return null;
    return deduplicateName(path.basename(repoRoot), repoRoot);
  }

  // 策略 3：目录名 + 路径哈希去重
  return deduplicateName(path.basename(resolved), resolved);
}

/** 尝试从 git remote origin 解析项目 ID */
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

/** 尝试获取 git 仓库根目录路径 */
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

/**
 * 判断路径是否为排除目录（home 目录、dotfiles 目录）。
 * 使用 path.relative 精确判断，避免误伤 ~/Projects/ 等正常路径。
 */
function isExcludedPath(dirPath: string): boolean {
  const homeDir = os.homedir();
  if (dirPath === homeDir) return true;

  // 仅排除以 . 开头的隐藏目录（如 ~/.config、~/.local）
  // 不排除 ~/Projects/、~/work/ 等正常目录
  const relative = path.relative(homeDir, dirPath);
  if (relative && !relative.startsWith("..")) {
    const segments = relative.split(path.sep);
    if (
      segments.length > 0 &&
      segments[0] !== "" &&
      segments[0].startsWith(".")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 同名目录去重：取目录名 + 路径 SHA256 前 8 位。
 * 如 "my-project" + hash("/home/user/work/my-project") → "my-project.a1b2c3d4"
 * 碰撞概率 ~1/4e9，对个人/小团队足够。
 */
function deduplicateName(name: string, dirPath: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(dirPath)
    .digest("hex")
    .slice(0, 8);
  return `${name}.${hash}`;
}

/**
 * 从 git remote URL 中解析出 owner/repo 格式的项目 ID。
 * 支持 HTTPS、SSH 和 git@ 三种常见格式。
 */
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
