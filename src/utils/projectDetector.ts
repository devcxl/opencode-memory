import { execSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { getMemoryDir } from "../config/runtime.js";

/**
 * 探测当前目录所属的项目标识。
 * 优先从 git remote origin 获取（如 "owner/repo"），
 * 否则 fallback 到目录名。特殊目录（home、dotfiles、memory 自身）返回 null。
 * @param cwd - 要探测的目录路径，默认 process.cwd()
 * @returns 项目 ID 或 null
 */
export function detectProject(cwd: string = process.cwd()): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (remoteUrl) {
      const parsed = parseGitUrl(remoteUrl);
      if (parsed) return parsed;
    }
  } catch {}

  const basename = path.basename(cwd);

  const homeDir = os.homedir();
  if (cwd === homeDir || cwd.startsWith(homeDir + path.sep + ".")) {
    return null;
  }

  if (cwd === homeDir) return null;

  const memoryDirCandidate = getMemoryDir();
  if (
    cwd.startsWith(memoryDirCandidate + path.sep) ||
    cwd === memoryDirCandidate
  ) {
    return null;
  }

  return basename;
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
