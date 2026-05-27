import { execSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

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

  const memoryDirCandidate = path.join(
    homeDir,
    ".config",
    "opencode",
    "memory",
  );
  if (
    cwd.startsWith(memoryDirCandidate + path.sep) ||
    cwd === memoryDirCandidate
  ) {
    return null;
  }

  return basename;
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
