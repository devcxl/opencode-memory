import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * pi 扩展运行时配置。
 * pi 扩展直接运行在 Node 环境，读取进程环境变量。
 */

export interface PiMemoryConfig {
  apiUrl: string;
  apiKey: string;
  /** 自动探测 git 项目并作为 project_id 作用域（默认开启） */
  autoProject: boolean;
}

/**
 * 配置优先级：OPM_API_URL / OPM_API_KEY 环境变量
 * > ~/.config/opencode/opencode.json 的 remote 段（与 OpenCode 插件共用一份配置，支持 env:// 前缀）。
 */
export function loadPiConfig(): PiMemoryConfig {
  const apiKey = process.env.OPM_API_KEY || readOpencodeConfigValue("apiKey");
  const apiUrl =
    process.env.OPM_API_URL || readOpencodeConfigValue("apiUrl") || "";

  if (!apiKey) {
    throw new Error(
      "[cabbage-memory-pi] 需要 API Token。先在 Web 管理台个人中心生成 Token，然后设置 OPM_API_KEY 环境变量（或在 opencode.json 的插件配置里填写 remote.apiKey）。",
    );
  }

  return { apiUrl, apiKey, autoProject: true };
}

function readOpencodeConfigValue(key: "apiKey" | "apiUrl"): string | undefined {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      "utf-8",
    );
    // 兼容 JSONC trailing comma
    const cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
    if (!Array.isArray(cfg.plugin)) return undefined;
    for (const entry of cfg.plugin) {
      if (
        (Array.isArray(entry) &&
          entry.length >= 2 &&
          typeof entry[0] === "string" &&
          entry[0].includes("cabbage-memory")) ||
        entry[0].includes("opencode-memory")
      ) {
        const remote = entry[1]?.remote;
        let value: unknown = remote?.[key];
        if (typeof value === "string" && value.startsWith("env://")) {
          value = process.env[value.slice(6)];
        }
        if (typeof value === "string") return value;
      }
    }
  } catch {}
  return undefined;
}
