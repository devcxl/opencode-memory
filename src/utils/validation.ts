const VALID_TARGETS = ["memory", "identity", "user", "daily", "bootstrap"];
const VALID_ACTIONS = ["read", "write", "edit", "delete", "search", "list"];
const VALID_SCOPES = ["all", "global", "project"];
const MAX_CONTENT_SIZE = 100 * 1024; // 单条内容上限 100KB，防止意外写入大文件
const MAX_MEMORY_LINES = 1000; // MEMORY.md 行数上限，避免单文件膨胀

/** 校验 target 参数是否在允许的取值范围内 */
export function validateTarget(target: string): void {
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(
      `Invalid target: ${target}. Must be one of: ${VALID_TARGETS.join(", ")}`,
    );
  }
}

/** 校验 action 参数是否在允许的取值范围内 */
export function validateAction(action: string): void {
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(
      `Invalid action: ${action}. Must be one of: ${VALID_ACTIONS.join(", ")}`,
    );
  }
}

/** 校验写入内容不为空且不超过大小限制。防止空写和超大 payload */
export function validateContent(content: string): void {
  if (!content || typeof content !== "string") {
    throw new Error("Content must be a non-empty string");
  }
  if (content.length > MAX_CONTENT_SIZE) {
    throw new Error(
      `Content exceeds ${MAX_CONTENT_SIZE} bytes (current: ${content.length})`,
    );
  }
}

/** 校验时间戳格式必须为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS */
export function validateTimestamp(timestamp: string): void {
  const fullRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (!fullRegex.test(timestamp) && !dateRegex.test(timestamp)) {
    throw new Error(
      `Invalid timestamp format: ${timestamp}. Must be YYYY-MM-DD or YYYY-MM-DD HH:MM:SS`,
    );
  }
}

/** 校验必填的时间戳或日期参数不为空 */
export function validateTimestampOrDate(value: string): void {
  if (!value) {
    throw new Error("Timestamp or date is required");
  }
  validateTimestamp(value);
}

/** 仅对 MEMORY.md 做行数上限检查，避免历史累积导致性能问题 */
export function checkLineLimit(filePath: string, content: string): void {
  const fileName = filePath.split("/").pop();
  if (fileName === "MEMORY.md") {
    const lines = content.split("\n").length;
    if (lines > MAX_MEMORY_LINES) {
      throw new Error(
        `MEMORY.md exceeds ${MAX_MEMORY_LINES} line limit (current: ${lines} lines). Use memory_delete to remove entries by timestamp.`,
      );
    }
  }
}

/** 校验搜索 scope 参数是否在允许取值范围内 */
export function validateScope(scope: string): void {
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${VALID_SCOPES.join(", ")}`,
    );
  }
}
