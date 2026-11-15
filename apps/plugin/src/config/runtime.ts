import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * 解析 opencode.json 配置（兼容 JSONC trailing comma）。
 * 先用正则移除 trailing comma，再用标准 JSON.parse。
 * opencode 自身使用 JSONC 解析器，但插件侧无此依赖，此处做最小兼容。
 */
function parseConfigFile(raw: string): unknown {
  // 移除 trailing comma: ,] → ]  ,} → }
  const cleaned = raw.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

/** 内存插件运行时配置 */
export interface MemoryConfig {
  memoryDir: string;
}

/**
 * 远程模式已迁出本包。
 *
 * 仍然识别旧的 `mode: "remote"` / `remote` 配置和 `OPM_MODE=remote`，
 * 但只用于抛出迁移错误，绝不静默回退 local。
 */
const REMOTE_MIGRATION_MESSAGE = [
  "[opencode-memory] Remote mode is no longer supported in this package.",
  "Remote memory (Cloudflare Worker + web console) has moved to @devcxl/cabbage-memory.",
  'Remove `mode: "remote"` / `remote` from your opencode config and unset',
  "OPM_MODE / OPM_API_URL / OPM_API_KEY, then reinstall this plugin.",
  "If you still need remote memory, install @devcxl/cabbage-memory.",
].join(" ");

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

/**
 * 从配置文件中查找本插件的 options。
 *
 * 兼容两代配置形状：
 * - V1: `plugin: ["pkg", ["pkg", { ... }]]`
 * - V2: `plugins: ["pkg", { package: "pkg", options: { ... } }]`
 *
 * 后面的条目覆盖前面的条目。
 */
function findPluginOptions(
  cfg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;

  const legacyEntries = cfg.plugin;
  if (Array.isArray(legacyEntries)) {
    for (const entry of legacyEntries) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "string" &&
        entry[0].includes("opencode-memory")
      ) {
        const opts = entry[1];
        if (opts && typeof opts === "object") {
          result = opts as Record<string, unknown>;
        }
      }
    }
  }

  const entries = cfg.plugins;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

      const candidate = entry as { package?: unknown; options?: unknown };
      if (
        typeof candidate.package === "string" &&
        candidate.package.includes("opencode-memory") &&
        candidate.options &&
        typeof candidate.options === "object"
      ) {
        result = candidate.options as Record<string, unknown>;
      }
    }
  }

  return result;
}

/** 获取插件配置对象（完整的嵌套 JSON 对象，而非扁平 key） */
export function getPluginConfigObject(): Record<string, unknown> | undefined {
  const configPath = getOpencodeConfigPath();

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = parseConfigFile(raw) as Record<string, unknown>;
    return findPluginOptions(cfg);
  } catch {}

  return undefined;
}

/**
 * 远程模式迁移守卫。
 *
 * 检测旧的插件 options（`mode: "remote"` 或残留的 `remote` 配置块）
 * 与 `OPM_MODE=remote` 环境变量。命中时直接抛错，避免静默以 local 运行。
 */
function assertLocalOnly(pluginOpts: Record<string, unknown>): void {
  const hasRemoteOptions =
    pluginOpts.mode === "remote" ||
    (pluginOpts.remote !== undefined && pluginOpts.remote !== null);

  if (process.env.OPM_MODE === "remote" || hasRemoteOptions) {
    throw new Error(REMOTE_MIGRATION_MESSAGE);
  }
}

/**
 * 生成运行时配置对象。
 *
 * 插件 options 覆盖 opencode.json 中的同名配置。配置只描述本地文件位置；
 * 远程配置会在解析阶段被迁移守卫拒绝。
 */
export function loadConfig(overrides?: Record<string, unknown>): MemoryConfig {
  const pluginOpts: Record<string, unknown> = {
    ...getPluginConfigObject(),
    ...overrides,
  };

  assertLocalOnly(pluginOpts);

  return { memoryDir: getMemoryDir() };
}

/** 获取 opencode 配置文件路径 */
export function getOpencodeConfigPath(): string {
  return path.join(getHomeDir(), ".config", "opencode", "opencode.json");
}

/** 从 opencode 配置文件读取本插件配置选项 */
export function getPluginConfigOption(key: string): string | undefined {
  const opts = getPluginConfigObject();
  if (!opts || !(key in opts)) return undefined;
  return String(opts[key]);
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
