import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { MemoryConfig } from "../types.js";

/** 根据平台获取 memory 目录路径。Windows 使用 AppData，其他平台使用 ~/.config */
export function getMemoryDir(): string {
  const home = os.homedir();
  if (os.platform() === "win32") {
    return path.join(home, "AppData", "Roaming", "opencode", "memory");
  }
  return path.join(home, ".config", "opencode", "memory");
}

/** 生成运行时配置对象。后续可扩展读取 opencode.json 等来源 */
export function loadConfig(): MemoryConfig {
  const memoryDir = getMemoryDir();
  return { memoryDir };
}

/** 递归确保目录存在，不存在则创建。避免每次写入都 try-catch */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
