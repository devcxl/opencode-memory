import * as fs from "node:fs";

/** 递归确保目录存在，不存在则创建。避免每次写入都 try-catch */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 安全读取文件内容，文件不存在或读取失败时返回 null 而非抛异常 */
export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** 从 unknown error 中提取错误消息，统一 catch 块的错误处理模式 */
export function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
