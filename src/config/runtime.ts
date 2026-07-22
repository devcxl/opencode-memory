import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** 远程模式配置 */
export interface RemoteConfig {
  apiUrl: string;
  apiKey: string;
}

/** 内存插件运行时配置 */
export interface MemoryConfig {
  memoryDir: string;
  /** 运行模式：local（本地文件+向量索引）或 remote（Cloudflare Worker API） */
  mode: "local" | "remote";
  /** 远程模式配置（mode=remote 时必填） */
  remote?: RemoteConfig;
}

function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

/** 根据平台获取 memory 目录路径。Windows 使用 AppData，其他平台使用 ~/.config */
export function getMemoryDir(): string {
  const home = getHomeDir();
  if (os.platform() === "win32") {
    return path.join(home, "AppData", "Roaming", "opencode", "memory");
  }
  return path.join(home, ".config", "opencode", "memory");
}

/** 获取插件配置对象（完整的嵌套 JSON 对象，而非扁平 key） */
export function getPluginConfigObject(): Record<string, unknown> | undefined {
  const configPath = getOpencodeConfigPath();

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.plugin)) return undefined;

    for (const entry of cfg.plugin) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "string" &&
        entry[0].includes("opencode-memory")
      ) {
        const opts = entry[1];
        if (opts && typeof opts === "object") {
          return opts as Record<string, unknown>;
        }
      }
    }
  } catch {}

  return undefined;
}

/** 解析 env:// 前缀的配置值：env://OPM_API_KEY → process.env.OPM_API_KEY */
export function resolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith("env://")) {
    return process.env[value.slice(6)];
  }
  return value;
}

/** 生成运行时配置对象，支持 opencode.json + 环境变量双重配置 */
export function loadConfig(): MemoryConfig {
  const memoryDir = getMemoryDir();
  const pluginOpts = getPluginConfigObject();

  // 从 opencode.json 读取 mode
  const configMode = pluginOpts?.mode as string | undefined;

  // 从 opencode.json 读取 remote 嵌套配置
  const remoteConfig = pluginOpts?.remote as Record<string, string> | undefined;
  const configApiUrl = remoteConfig?.apiUrl;
  const configApiKeyRaw = remoteConfig?.apiKey;

  // 环境变量覆盖：OPM_MODE > opencode.json > 默认 "local"
  const effectiveMode: "local" | "remote" =
    process.env.OPM_MODE === "remote"
      ? "remote"
      : configMode === "remote"
        ? "remote"
        : "local";

  const config: MemoryConfig = { memoryDir, mode: effectiveMode };

  if (effectiveMode === "remote") {
    // apiKey 优先级：OPM_API_KEY 环境变量 > opencode.json remote.apiKey（均支持 env:// 前缀）
    const apiKey = resolveEnvRef(process.env.OPM_API_KEY || configApiKeyRaw);
    if (!apiKey) {
      throw new Error(
        "Remote mode requires apiKey. Set OPM_API_KEY or configure remote.apiKey in opencode.json.",
      );
    }
    config.remote = {
      apiUrl: process.env.OPM_API_URL || configApiUrl || "",
      apiKey,
    };
  }

  return config;
}

/** 获取 opencode 配置文件路径 */
export function getOpencodeConfigPath(): string {
  return path.join(getHomeDir(), ".config", "opencode", "opencode.json");
}

/** 从 opencode 配置文件读取本插件配置选项 */
export function getPluginConfigOption(key: string): string | undefined {
  const configPath = getOpencodeConfigPath();

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.plugin)) return undefined;

    for (const entry of cfg.plugin) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "string" &&
        entry[0].includes("opencode-memory")
      ) {
        const opts = entry[1];
        if (opts && typeof opts === "object" && key in opts) {
          return String(opts[key]);
        }
      }
    }
  } catch {}

  return undefined;
}

/** 检测系统 locale 是否为中文 */
export function isZhLocale(): boolean {
  const lang = (
    process.env.LANG ||
    process.env.LC_ALL ||
    process.env.LC_CTYPE ||
    ""
  ).toLowerCase();
  return lang.startsWith("zh");
}

/** 检查是否启用 debug 日志 */
export function isDebugEnabled(): boolean {
  return process.env.OPM_DEBUG === "1";
}
