import * as path from "node:path";
import { DEFAULT_MEMORY_LIMITS, type MemoryLimits } from "../config/runtime.js";
import { parseContentByTimestamp } from "./timestampParser.js";

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

/** 将 daily 的 date 参数规范为 YYYY-MM-DD；空值表示未指定 */
export function normalizeDailyDate(date?: string): string | undefined {
  if (date === undefined) return undefined;
  const value = date.trim();
  if (!value) return undefined;
  validateTimestamp(value);
  return value.slice(0, 10);
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

/** 解析指定文件适用的字符预算上限；daily/bootstrap 返回 null 表示不受限 */
export function getCharLimitForFile(
  filePath: string,
  memoryDir: string,
  limits: MemoryLimits = DEFAULT_MEMORY_LIMITS,
): number | null {
  const rel = path.relative(path.resolve(memoryDir), path.resolve(filePath));
  if (rel === "MEMORY.md") return limits.memory;
  if (rel === "USER.md") return limits.user;
  if (rel === "IDENTITY.md") return limits.identity;
  if (
    rel.startsWith(`projects${path.sep}`) &&
    path.basename(rel) === "MEMORY.md"
  ) {
    return limits.projectMemory;
  }
  return null;
}

/**
 * 校验受限记忆文件的字符预算。
 * 超限时抛出错误，并附上现有条目时间戳与首段预览，方便模型单次清理腾挪。
 */
export function checkCharBudget(
  filePath: string,
  newContent: string,
  memoryDir: string,
  limits: MemoryLimits = DEFAULT_MEMORY_LIMITS,
  existingContent?: string,
): void {
  const limit = getCharLimitForFile(filePath, memoryDir, limits);
  if (limit === null) return;

  if (newContent.length <= limit) return;

  const displayRel =
    path
      .relative(path.resolve(memoryDir), path.resolve(filePath))
      .replaceAll(path.sep, "/") || path.basename(filePath);
  const sourceForListing = existingContent ?? newContent;
  const entries = parseContentByTimestamp(sourceForListing);

  let listing = "";
  if (entries.length > 0) {
    const lines = entries.slice(0, 20).map((entry) => {
      const oneLine = entry.content.replace(/\s+/g, " ").trim();
      const preview =
        oneLine.length > 60 ? `${oneLine.slice(0, 60)}...` : oneLine;
      return `- [${entry.timestamp}] ${preview}`;
    });
    listing = `\nExisting entries:\n${lines.join("\n")}`;
  }

  throw new Error(
    `${displayRel} exceeds character budget (${newContent.length}/${limit} chars). Use delete or write with replace_timestamps to trim stale entries.${listing}`,
  );
}

/** 生成简洁的字符预算占用率提示行；非受限文件返回 null */
export function formatBudgetNote(
  filePath: string,
  content: string,
  memoryDir: string,
  limits: MemoryLimits = DEFAULT_MEMORY_LIMITS,
): string | null {
  const limit = getCharLimitForFile(filePath, memoryDir, limits);
  if (limit === null) return null;

  const len = content.length;
  const pct = Math.round((len / limit) * 100);
  const base = `Budget: ${len.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars (${pct}%)`;
  if (pct >= 85) {
    return `${base} — near limit, consider consolidating or deleting stale entries.`;
  }
  return base;
}

/** 校验搜索 scope 参数是否在允许取值范围内 */
export function validateScope(scope: string): void {
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${VALID_SCOPES.join(", ")}`,
    );
  }
}

/** 校验项目 ID 只能是安全的相对路径，如 owner/repo */
export function validateProjectId(projectId: string): void {
  if (!projectId || projectId.trim() !== projectId) {
    throw new Error("Invalid project id: must be a non-empty string");
  }

  if (
    projectId.startsWith("/") ||
    projectId.includes("\\") ||
    /^[A-Za-z]:/.test(projectId)
  ) {
    throw new Error("Invalid project id: absolute paths are not allowed");
  }

  const segments = projectId.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid project id: path traversal is not allowed");
  }

  if (!/^[A-Za-z0-9._/-]+$/.test(projectId)) {
    throw new Error(
      "Invalid project id: only letters, numbers, '.', '_', '-', and '/' are allowed",
    );
  }
}
