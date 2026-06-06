import * as crypto from "node:crypto";

function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Markdown 文档的切片单元。
 * heading 为空字符串时表示该切片位于文件顶部（无标题区域）。
 */
export interface Chunk {
  /** 切片正文内容 */
  text: string;
  /** 切片所属的最近一级标题（## 或 ###） */
  heading: string;
  /** 来源文件路径 */
  filePath: string;
  /** 基于 filePath + heading + text 计算的 SHA256 哈希，用于增量去重 */
  hash: string;
  /** 条目对应的时间戳，来自最近的 <!-- timestamp --> 标记 */
  timestamp?: string;
}

/**
 * 将 Markdown 内容按 ## 和 ### 标题分割为语义切片。
 *
 * 设计原则：以标题为自然边界分组，同一标题下的连续段落归入同一切片，
 * 使得每个切片拥有独立的语义上下文，便于向量检索时精确匹配。
 * 若全文无合法标题则整体作为一个切片兜底。
 *
 * @param content  - 原始 Markdown 文本
 * @param filePath - 关联的文件路径，写入 metadata 与 hash 计算使用
 * @returns 按标题分组后的切片列表
 */
export function chunkMarkdown(content: string, filePath: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headingRegex = /^(#{2,3})\s+(.+)$/;
  const timestampRegex =
    /^<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s*-->$/;
  let currentHeading = "";
  let currentTimestamp: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (!text) return;

    chunks.push({
      text,
      heading: currentHeading,
      filePath,
      hash: hashContent(
        `${filePath}:${currentHeading}:${currentTimestamp ?? ""}:${text}`,
      ),
      ...(currentTimestamp ? { timestamp: currentTimestamp } : {}),
    });
    buffer = [];
  };

  for (const line of content.split("\n")) {
    const timestampMatch = line.match(timestampRegex);
    if (timestampMatch) {
      flush();
      currentTimestamp = timestampMatch[1];
      continue;
    }

    const headingMatch = line.match(headingRegex);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      continue;
    }

    buffer.push(line);
  }

  flush();

  return chunks;
}
