import * as path from "node:path";

/**
 * 基于字符串键的进程内异步互斥锁。
 * 用于串行化同一文件或同一索引目录的并发读-改-写操作，避免 Lost Update。
 */
export class KeyedAsyncMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const normalizedKey = path.resolve(key);
    const prev = this.tails.get(normalizedKey) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(normalizedKey, tail);

    await prev;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(normalizedKey) === tail) {
        this.tails.delete(normalizedKey);
      }
    }
  }
}
