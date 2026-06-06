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
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const sections = content.split(headingRegex);

  let currentHeading = "";
  for (let i = 0; i < sections.length; i += 3) {
    const heading = sections[i + 1];
    const text = sections[i + 2];

    if (heading) {
      currentHeading = heading.trim();
    }

    if (text && text.trim()) {
      chunks.push({
        text: text.trim(),
        heading: currentHeading,
        filePath,
        hash: hashContent(`${filePath}:${currentHeading}:${text.trim()}`),
      });
    }
  }

  // 兜底：没有任何标题匹配时，将全文作为一个切片
  if (chunks.length === 0 && content.trim()) {
    chunks.push({
      text: content.trim(),
      heading: "",
      filePath,
      hash: hashContent(`${filePath}:${content.trim()}`),
    });
  }

  return chunks;
}
