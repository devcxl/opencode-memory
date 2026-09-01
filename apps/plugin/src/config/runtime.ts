import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * 插件运行时配置（v2：仅远程模式）。
 * 存储完全由 Cloudflare Worker 承担，本地不再有任何记忆文件。
 */

/** 远程 Worker 配置 */
export interface RemoteConfig {
  apiUrl: string;
  apiKey: string;
}

export interface MemoryConfig extends RemoteConfig {
  /** 自动探测 git 项目并作为 project_id 作用域（默认开启） */
  autoProject: boolean;
}

function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

/** 解析 env:// 前缀的配置值：env://OPM_API_KEY → process.env.OPM_API_KEY */
export function resolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith("env://")) {
    return process.env[value.slice(6)];
  }
  return value;
}

/** 获取 opencode 配置文件路径 */
export function getOpencodeConfigPath(): string {
  return path.join(getHomeDir(), ".config", "opencode", "opencode.json");
}

/**
 * 解析 opencode.json 配置（兼容 JSONC trailing comma）。
 * opencode 自身使用 JSONC 解析器，插件侧无此依赖，此处做最小兼容。
 */
function parseConfigFile(raw: string): unknown {
  const cleaned = raw.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

/** 获取本插件在 opencode.json 里的配置对象（plugin: [["name", {...}]] 的第二项） */
export function getPluginConfigObject(): Record<string, unknown> | undefined {
  const configPath = getOpencodeConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = parseConfigFile(raw) as Record<string, unknown>;
    if (!Array.isArray(cfg.plugin)) return undefined;
    for (const entry of cfg.plugin) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "string" &&
        entry[0].includes("opencode-memory")
      ) {
        const opts = entry[1];
        if (opts && typeof opts === "object")
          return opts as Record<string, unknown>;
      }
    }
  } catch {}
  return undefined;
}

/** 生成运行时配置。优先级：环境变量 > opencode.json remote 配置 */
export function loadConfig(): MemoryConfig {
  const pluginOpts = getPluginConfigObject();
  const remoteOpts = pluginOpts?.remote as Record<string, string> | undefined;

  const apiKey = resolveEnvRef(process.env.OPM_API_KEY || remoteOpts?.apiKey);
  const apiUrl =
    process.env.OPM_API_URL || resolveEnvRef(remoteOpts?.apiUrl) || "";

  if (!apiKey) {
    throw new Error(
      "[opencode-memory] 远程模式需要 API Token。先在 Web 管理台个人中心生成 Token，然后设置 OPM_API_KEY 环境变量，或在 opencode.json 插件配置里填写 remote.apiKey。",
    );
  }

  const autoProject =
    pluginOpts?.autoProject === undefined
      ? true
      : Boolean(pluginOpts.autoProject);

  return { apiUrl, apiKey, autoProject };
}

/** 检查是否启用 debug 日志 */
export function isDebugEnabled(): boolean {
  return process.env.OPM_DEBUG === "1";
}
