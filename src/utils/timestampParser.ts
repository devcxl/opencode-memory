import type { TimestampEntry } from "../types.js";

// 匹配 HTML 注释包裹的时间戳：<!-- 2024-01-01 --> 或 <!-- 2024-01-01 12:00:00 -->
const TIMESTAMP_REGEX =
  /<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s*-->/g;

/**
 * 将带时间戳标记的文本解析为结构化条目数组。
 * 利用 split 特性：正则带捕获组时，结果数组交替为 [文本, 时间戳, 文本, 时间戳, ...]。
 * @param content - 带 <!-- timestamp --> 标记的原始文本
 * @returns 解析后的时间戳条目列表
 */
export function parseContentByTimestamp(content: string): TimestampEntry[] {
  const entries: TimestampEntry[] = [];
  const parts = content.split(TIMESTAMP_REGEX);

  for (let i = 1; i < parts.length; i += 2) {
    const timestamp = parts[i];
    const nextContent = parts[i + 1] || "";

    // 条目内容中可能嵌套新的时间戳标记，取其分割后的第一部分（即当前条目的正文）
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
