import * as crypto from "node:crypto";

/** SHA256 哈希，用于增量去重 */
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
 * 状态机：维护 heading（当前标题）、timestamp（当前时间戳）、buffer（文本缓冲区）三个状态。
 * 遍历每一行：
 * - 遇到 <!-- timestamp --> 标记 → 从标记中提取时间戳，随后内容归属该时间戳
 * - 遇到 ## 或 ### 标题 → 将缓冲区刷新为一个 chunk，更新当前标题
 * - 其他行 → 追加到缓冲区
 *
 * 设计原则：以标题为自然边界分组，使每个切片拥有独立的语义上下文，
 * 便于向量检索时精确匹配。若全文无合法标题则整体作为一个切片兜底。
 *
 * @param content  - 原始 Markdown 文本
 * @param filePath - 关联的文件路径，写入 metadata 与 hash 计算使用
 * @returns 按标题分组后的切片列表
 */
export function chunkMarkdown(content: string, filePath: string): Chunk[] {
  const chunks: Chunk[] = [];
  // 匹配 ## 或 ### 开头的行标题
  const headingRegex = /^(#{2,3})\s+(.+)$/;
  // 匹配 HTML 注释包裹的时间戳
  const timestampRegex =
    /^<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s*-->$/;
  let currentHeading = "";
  let currentTimestamp: string | undefined;
  let buffer: string[] = [];

  /** 将当前缓冲区内容作为一个 chunk 提交，清空缓冲区 */
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
    // 优先匹配时间戳标记 ── 标记行自身不加入正文
    const timestampMatch = line.match(timestampRegex);
    if (timestampMatch) {
      flush();
      currentTimestamp = timestampMatch[1];
      continue;
    }

    // 匹配标题行 ── 标题行自身不加入正文
    const headingMatch = line.match(headingRegex);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      continue;
    }

    // 普通正文行追加到缓冲区
    buffer.push(line);
  }

  // 刷新最后的缓冲区
  flush();

  return chunks;
}
