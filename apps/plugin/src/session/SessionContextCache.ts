import type { MemoryCallInfo } from "./SessionStateStore.js";

/** 会话级冻结注入快照 */
export interface CachedContextSnapshot {
  projectId: string | null;
  instructions: string;
  memoryContext: string;
}

/**
 * 判断一次成功的 memory 工具调用是否应使当前会话的注入快照失效。
 * - 只读操作（read/search/list）不失效
 * - `target === "daily"` 不进入自动注入上下文，写 daily 不失效（保护 KV Cache）
 * - 写入/编辑/删除 memory、identity、user、bootstrap 等注入目标时失效
 */
export function shouldInvalidateContextCache(info: MemoryCallInfo): boolean {
  const action = info.action ?? "";
  if (action !== "write" && action !== "edit" && action !== "delete") {
    return false;
  }
  return info.target !== "daily";
}

/**
 * 按 sessionID 缓存静态指令与记忆注入正文快照。
 * 会话内连续请求直接复用同一快照以保持系统提示词前缀字节稳定，
 * 仅在当前会话写更新了注入目标、发生压缩或引导状态切换时精准失效。
 */
export class SessionContextCache {
  private readonly cache = new Map<string, CachedContextSnapshot>();

  async getOrBuild(
    sessionID: string,
    projectId: string | null,
    builder: () => Promise<{ instructions: string; memoryContext: string }>,
  ): Promise<CachedContextSnapshot> {
    const existing = this.cache.get(sessionID);
    if (existing && existing.projectId === projectId) {
      return existing;
    }

    const built = await builder();
    const snapshot: CachedContextSnapshot = {
      projectId,
      instructions: built.instructions,
      memoryContext: built.memoryContext,
    };
    this.cache.set(sessionID, snapshot);
    return snapshot;
  }

  invalidate(sessionID: string): void {
    this.cache.delete(sessionID);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  delete(sessionID: string): void {
    this.cache.delete(sessionID);
  }

  clear(): void {
    this.cache.clear();
  }

  has(sessionID: string): boolean {
    return this.cache.has(sessionID);
  }
}
