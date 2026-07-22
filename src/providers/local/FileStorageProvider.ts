import type { IFileStorageProvider } from "../types.js";
import type { MemoryConfig } from "../../config/runtime.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSafe } from "../../utils/fs.js";
import { atomicWrite } from "../../utils/atomicWrite.js";

/**
 * 本地文件系统存储 Provider。
 *
 * 直接操作 memoryDir 下的文件，使用 atomicWrite 保证写入原子性。
 * appendFile 不带时间戳——时间戳逻辑属于 MemoryManager（业务层），不属于存储层。
 */
export class LocalFileStorageProvider implements IFileStorageProvider {
  private memoryDir: string;

  constructor(config: MemoryConfig) {
    this.memoryDir = config.memoryDir;
  }

  async readFile(filePath: string): Promise<string | null> {
    return readFileSafe(filePath);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    atomicWrite(filePath, content);
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    const existing = await this.readFile(filePath);
    const separator = existing?.trim() ? "\n\n" : "";
    const newContent = (existing ?? "") + separator + content;
    atomicWrite(filePath, newContent);
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.existsSync(filePath);
  }

  async listFiles(pattern: string): Promise<string[]> {
    const results: string[] = [];
    this.walkDir(this.memoryDir, pattern, results);
    return results;
  }

  /**
   * 递归遍历目录，收集匹配 pattern 的文件路径。
   * pattern 为简单子串匹配（非 glob/regex）。
   */
  private walkDir(
    dir: string,
    pattern: string,
    results: string[],
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") {
        this.walkDir(fullPath, pattern, results);
      } else if (entry.isFile()) {
        const relativePath = path.relative(this.memoryDir, fullPath);
        if (this.matchPattern(relativePath, pattern)) {
          results.push(fullPath);
        }
      }
    }
  }

  /**
   * pattern 为 "*" 时匹配所有文件，否则按子串包含匹配。
   */
  private matchPattern(relativePath: string, pattern: string): boolean {
    if (pattern === "*") return true;
    return relativePath.includes(pattern);
  }
}
