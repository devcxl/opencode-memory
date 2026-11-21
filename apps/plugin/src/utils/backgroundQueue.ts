import * as path from "node:path";
import { KeyedAsyncMutex } from "./asyncMutex.js";

/**
 * 带显式 flush 栅栏与同文件合并能力的后台异步任务队列。
 *
 * 用于将派生的向量索引更新与 Git 提交从同步写入关键路径解耦：
 * - 同一文件在任务尚未启动或正在执行期间的多次连续写入会自动合并为最新一次同步；
 * - 提供 `flush()` 栅栏供 `semanticSearch()` 与插件卸载清理前等待队列落盘；
 * - 单个任务失败被捕获隔离，不产生未处理拒绝，也不阻塞后续任务与主流程。
 */
export class BackgroundSyncQueue {
  private readonly pending = new Map<string, string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly keyLocks = new KeyedAsyncMutex();

  constructor(
    private readonly runner: (
      filePath: string,
      operation: string,
    ) => Promise<void>,
  ) {}

  /** 入队一次后台同步；同文件未执行任务会自动合并为最新 operation */
  enqueue(filePath: string, operation: string): void {
    const key = path.resolve(filePath);
    const alreadyPending = this.pending.has(key);
    this.pending.set(key, operation);
    if (alreadyPending) {
      return;
    }
    this.scheduleKey(key);
  }

  private scheduleKey(key: string): void {
    if (this.running.has(key)) {
      return;
    }

    const promise = this.keyLocks
      .withLock(key, async () => {
        while (this.pending.has(key)) {
          const operation = this.pending.get(key)!;
          this.pending.delete(key);
          try {
            await this.runner(key, operation);
          } catch (error) {
            console.error(
              `[opencode-memory] Background sync failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      })
      .finally(() => {
        if (this.running.get(key) === promise) {
          this.running.delete(key);
        }
        if (this.pending.has(key)) {
          this.scheduleKey(key);
        }
      });

    this.running.set(key, promise);
  }

  /** 栅栏：等待当前所有排队及执行中的后台同步任务完全收敛 */
  async flush(): Promise<void> {
    while (this.running.size > 0 || this.pending.size > 0) {
      for (const key of this.pending.keys()) {
        this.scheduleKey(key);
      }
      const active = Array.from(this.running.values());
      if (active.length === 0) break;
      await Promise.allSettled(active);
    }
  }

  /** 当前活跃或等待中的文件键数量 */
  pendingCount(): number {
    return new Set([...this.running.keys(), ...this.pending.keys()]).size;
  }
}
