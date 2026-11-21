import * as crypto from "node:crypto";
import * as path from "node:path";
import type { MemoryOrigin } from "../types.js";

const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;

/** SHA256 哈希，用于增量去重 */
function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Markdown 文档的切片单元。
 * heading 为空字符串时表示该切片位于文件顶部（无标题区域）。
 */
export interface Chunk {
  /** 切片正文内容（不含合成前缀） */
  text: string;
  /** 供向量化模型编码的上下文增强文本（含文件名与标题面包屑） */
  embeddingText?: string;
  /** 切片所属的最近一级标题（## 或 ###） */
  heading: string;
  /** 来源文件路径 */
  filePath: string;
  /** 基于 filePath + heading + timestamp + text 计算的 SHA256 哈希，用于增量去重 */
  hash: string;
  /** 条目对应的时间戳，来自最近的 <!-- timestamp --> 标记 */
  timestamp?: string;
  /** 条目来源标记（owner / agent / external） */
  origin?: MemoryOrigin;
}

/** 对超长文本按字符上限与重叠窗口做二次切分，优先在换行处断开 */
function splitOversizedText(
  text: string,
  maxChars: number = MAX_CHUNK_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const newlineBreak = text.lastIndexOf("\n", end);
      if (newlineBreak > start + Math.floor(maxChars * 0.5)) {
        end = newlineBreak;
      }
    }

    const slice = text.slice(start, end).trim();
    if (slice) {
      parts.push(slice);
    }

    if (end >= text.length) break;
    const nextStart = Math.max(end - overlapChars, start + 1);
    start = nextStart;
  }

  return parts;
}

function buildEmbeddingText(
  filePath: string,
  heading: string,
  text: string,
): string {
  const baseName = path.basename(filePath);
  const label = heading ? `${baseName} > ${heading}` : baseName;
  return `[${label}]\n${text}`;
}

/**
 * 将 Markdown 内容按 ## 和 ### 标题及时间戳标记分割为语义切片，
 * 为超长段落做带重叠窗口的二次切分，并为嵌入文本注入文件与标题上下文。
 */
export function chunkMarkdown(content: string, filePath: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headingRegex = /^(#{2,3})\s+(.+)$/;
  const timestampRegex =
    /^<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)(?:\s*\|\s*origin:\s*(owner|agent|external))?\s*-->$/;
  let currentHeading = "";
  let currentTimestamp: string | undefined;
  let currentOrigin: MemoryOrigin | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;

    const segments = splitOversizedText(text);
    for (const seg of segments) {
      chunks.push({
        text: seg,
        embeddingText: buildEmbeddingText(filePath, currentHeading, seg),
        heading: currentHeading,
        filePath,
        hash: hashContent(
          `${filePath}:${currentHeading}:${currentTimestamp ?? ""}:${seg}`,
        ),
        ...(currentTimestamp ? { timestamp: currentTimestamp } : {}),
        ...(currentOrigin ? { origin: currentOrigin } : {}),
      });
    }
  };

  for (const line of content.split("\n")) {
    const timestampMatch = line.match(timestampRegex);
    if (timestampMatch) {
      flush();
      currentTimestamp = timestampMatch[1];
      currentOrigin = timestampMatch[2] as MemoryOrigin | undefined;
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
