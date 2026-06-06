import * as fs from "node:fs";

/** 递归确保目录存在，不存在则创建。避免每次写入都 try-catch */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
