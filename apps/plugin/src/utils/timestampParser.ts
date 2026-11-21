import type { MemoryOrigin, TimestampEntry } from "../types.js";

// 匹配 HTML 注释包裹的时间戳及可选 origin 元数据：
// <!-- 2024-01-01 --> / <!-- 2024-01-01 12:00:00 | origin: owner -->
const TIMESTAMP_REGEX =
  /<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)(?:\s*\|\s*origin:\s*(owner|agent|external))?\s*-->/g;

/** 格式化时间戳注释行；默认 agent 省略属性以保持向后兼容 */
export function formatTimestampComment(
  timestamp: string,
  origin?: MemoryOrigin,
): string {
  if (origin && origin !== "agent") {
    return `<!-- ${timestamp} | origin: ${origin} -->`;
  }
  return `<!-- ${timestamp} -->`;
}

/**
 * 将带时间戳标记的文本解析为结构化条目数组。
 *
 * 正则含 2 个捕获组（timestamp 与可选 origin），因此 split 结果每 3 个元素为一组：
 * [prefix, ts1, origin1, body1, ts2, origin2, body2, ...]
 */
export function parseContentByTimestamp(content: string): TimestampEntry[] {
  const entries: TimestampEntry[] = [];
  const parts = content.split(TIMESTAMP_REGEX);

  for (let i = 1; i < parts.length; i += 3) {
    const timestamp = parts[i];
    const origin = parts[i + 1] as MemoryOrigin | undefined;
    const nextContent = parts[i + 2] || "";

    // 防止嵌套时间戳：对正文再次 split，取第一部分（当前条目正文）
    const contentParts = nextContent.split(TIMESTAMP_REGEX);
    const entryContent = contentParts[0].trim();

    if (entryContent) {
      entries.push({
        timestamp,
        content: entryContent,
        ...(origin ? { origin } : {}),
      });
    }
  }

  return entries;
}

/**
 * 从常驻注入文本中剔除所有 `origin: external` 的条目，
 * 保留前置非时间戳引导内容与其它来源条目，结构性阻断外部检索回流污染。
 */
export function stripExternalOriginEntries(content: string): string {
  if (!content.includes("origin:")) {
    return content.trim();
  }

  const parts = content.split(TIMESTAMP_REGEX);
  const kept: string[] = [];

  const preamble = (parts[0] ?? "").trim();
  if (preamble) {
    kept.push(preamble);
  }

  for (let i = 1; i < parts.length; i += 3) {
    const timestamp = parts[i];
    const origin = parts[i + 1] as MemoryOrigin | undefined;
    const body = (parts[i + 2] ?? "").split(TIMESTAMP_REGEX)[0].trim();
    if (!body || origin === "external") {
      continue;
    }
    kept.push(`${formatTimestampComment(timestamp, origin)}\n${body}`);
  }

  return kept.join("\n\n").trim();
}

/** 提取文本中所有出现的时间戳字符串。用于校验、统计等场景 */
export function extractTimestamps(content: string): string[] {
  const regex = new RegExp(TIMESTAMP_REGEX.source, "g");
  const timestamps: string[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    timestamps.push(match[1]);
  }

  return timestamps;
}
