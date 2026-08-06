import type { TimestampEntry } from "../types.js";

// 匹配 HTML 注释包裹的时间戳：<!-- 2024-01-01 --> 或 <!-- 2024-01-01 12:00:00 -->
const TIMESTAMP_REGEX =
  /<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s*-->/g;

/**
 * 将带时间戳标记的文本解析为结构化条目数组。
 *
 * 核心技巧：利用 String.split() 的正则捕获组特性。
 * 当正则包含捕获组时，split 结果数组形如：
 *   ["prefix", "2024-01-01", "content-a", "2024-01-02", "content-b", ...]
 * 低位索引为文本段，奇位为时间戳捕获。从 i=1 开始逐对处理。
 *
 * 嵌套标记处理：条目内容自身可能内含新的时间戳标记，
 * 此时再次执行 split 取第一部分（即当前条目正文），后续部分属于下一条目。
 *
 * @param content - 带 <!-- timestamp --> 标记的原始文本
 * @returns 解析后的时间戳条目列表
 */
export function parseContentByTimestamp(content: string): TimestampEntry[] {
  const entries: TimestampEntry[] = [];
  const parts = content.split(TIMESTAMP_REGEX);

  // 从 i=1 开始，每次跳 2 个：奇数位为时间戳，随后偶数位为正文
  for (let i = 1; i < parts.length; i += 2) {
    const timestamp = parts[i];
    const nextContent = parts[i + 1] || "";

    // 防止嵌套时间戳：对正文再次 split，取第一部分（当前条目正文）
    const contentParts = nextContent.split(TIMESTAMP_REGEX);
    const entryContent = contentParts[0].trim();

    if (entryContent) {
      entries.push({
        timestamp,
        content: entryContent,
      });
    }
  }

  return entries;
}

/** 提取文本中所有出现的时间戳字符串。用于校验、统计等场景 */
export function extractTimestamps(content: string): string[] {
  const timestamps: string[] = [];
  let match;

  while ((match = TIMESTAMP_REGEX.exec(content)) !== null) {
    timestamps.push(match[1]);
  }

  return timestamps;
}

/**
 * 将日期格式补全为完整时间戳用于显示/排序。
 * "2024-01-01" → "2024-01-01 00:00:00"，已有时间的原样返回。
 */
export function formatTimestampForDisplay(timestamp: string): string {
  if (timestamp.includes(" ")) {
    return timestamp;
  }
  return `${timestamp} 00:00:00`;
}
