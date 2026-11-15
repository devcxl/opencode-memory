/** 单个会话的内存操作记录 */
export interface SessionState {
  /** 本会话所有已完成的 memory 操作 */
  memoryOperations: Array<{
    action: string;
    target: string;
    timestamp: string;
  }>;
  /** 最近一次 daily 更新的 ISO 时间戳，null 表示未更新过 */
  lastDailyUpdate: string | null;
}

/** memory 工具中用于提醒判断的字段 */
export interface MemoryCallInfo {
  action?: string;
  target?: string;
}

/** 单会话保留的操作条数上限，避免长会话无限增长 */
const MAX_OPERATIONS_PER_SESSION = 100;

/**
 * 会话级内存状态。
 *
 * V2 的 server 是共享服务，插件实例会观察多个 session，
 * 因此状态必须按 sessionID 隔离，并在 session 删除时清理。
 */
export class SessionStateStore {
  private readonly states = new Map<string, SessionState>();

  /** 获取会话状态；不存在时惰性创建 */
  get(sessionID: string): SessionState {
    let state = this.states.get(sessionID);
    if (!state) {
      state = { memoryOperations: [], lastDailyUpdate: null };
      this.states.set(sessionID, state);
    }
    return state;
  }

  /** 删除会话状态，避免内存泄漏 */
  delete(sessionID: string): void {
    this.states.delete(sessionID);
  }

  /**
   * 记录一次 memory 工具调用。
   * 只有成功完成的调用才计入，避免失败操作触发 daily 提醒。
   */
  record(sessionID: string, info: MemoryCallInfo, completed: boolean): void {
    if (!completed) return;

    const state = this.get(sessionID);
    const timestamp = new Date().toISOString();

    state.memoryOperations.push({
      action: info.action ?? "unknown",
      target: info.target ?? "unknown",
      timestamp,
    });

    if (state.memoryOperations.length > MAX_OPERATIONS_PER_SESSION) {
      state.memoryOperations.splice(
        0,
        state.memoryOperations.length - MAX_OPERATIONS_PER_SESSION,
      );
    }

    if (info.target === "daily") {
      state.lastDailyUpdate = timestamp;
    }
  }

  /**
   * 是否需要提醒更新 daily：本会话有 memory 操作但从未更新 daily。
   */
  needsDailyReminder(sessionID: string): boolean {
    const state = this.states.get(sessionID);
    if (!state) return false;
    return state.memoryOperations.length > 0 && !state.lastDailyUpdate;
  }

  /** 插件卸载时清理全部状态 */
  clear(): void {
    this.states.clear();
  }
}
