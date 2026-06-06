import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** 内存插件运行时配置 */
export interface MemoryConfig {
  memoryDir: string;
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

/** 生成运行时配置对象 */
export function loadConfig(): MemoryConfig {
  const memoryDir = getMemoryDir();
  return { memoryDir };
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
