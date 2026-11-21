import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 原子写入文件：先写入临时文件再 rename，避免写入过程中崩溃导致内容损坏。
 * 临时文件名包含进程 PID 与随机 UUID，防止同毫秒并发写入互相覆盖。
 * @param filePath - 目标文件路径
 * @param content - 写入的文本内容
 */
export function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}
