/**
 * 文本预处理：中文分词 + FTS 查询构建
 *
 * 使用 Intl.Segmenter (V8, available in Cloudflare Workers)
 * 对中文做 word-level 分词，非 CJK 回退到正则匹配
 */

export interface ProcessedQuery {
  /** 原始用户输入 */
  original: string
  /** 分词后空格连接的文本，用于 FTS MATCH 表达式 */
  matchText: string
  /** 清洗后的 token 列表（去重） */
  tokens: string[]
}

// FTS5 MATCH 表达式中需要转义的特殊字符
const FTS_SPECIAL_CHARS = /[\"\*\(\)\:\^{}\[\]\\]/g
// 非字母数字/非中文/非日文片假名的字符（用于非 segmenter 回退）
const NON_WORD_CHARS = /[^\p{L}\p{N}]+/gu
// FTS 内嵌单字符英文 token 通常无意义，最小长度
const MIN_ASCII_TOKEN_LENGTH = 2

/**
 * 检测文本是否包含 CJK（中日韩）字符
 */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text)
}

/**
 * 清洗 FTS token：移除特殊字符
 */
function sanitizeToken(token: string): string {
  return token.replace(FTS_SPECIAL_CHARS, '').trim()
}

/**
 * 写入索引时使用的分词（不需要去重或构建 tokens 列表）
 */
export function segmentForIndex(text: string): string {
  if (!text) return ''

  if (!hasCJK(text)) {
    // 非 CJK 文本：直接小写 + 移除特殊字符即可，FTS5 unicode61 会自动处理
    return text.toLowerCase()
  }

  const words: string[] = []
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const segments = segmenter.segment(text)

  for (const { segment, isWordLike } of segments) {
    const cleaned = sanitizeToken(segment.toLowerCase())
    if (!cleaned) continue

    // 保留所有中文 token（即使是单字，中文里单字也有意义）
    // 英文 token 只保留长度 >= MIN_ASCII_TOKEN_LENGTH
    if (/[\u4e00-\u9fff]/.test(cleaned)) {
      words.push(cleaned)
    } else if (cleaned.length >= MIN_ASCII_TOKEN_LENGTH) {
      words.push(cleaned)
    }
  }

  return words.join(' ')
}

/**
 * 用户查询预处理：分词 + 构建 MATCH 表达式 tokens
 */
export function preprocessQuery(raw: string): ProcessedQuery {
  const original = raw.trim()
  if (!original) {
    return { original: '', matchText: '', tokens: [] }
  }

  if (!hasCJK(original)) {
    // 纯非 CJK：降级到常规 token 切分（保留原逻辑）
    const tokens = Array.from(
      new Set(
        (original.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
          .map(sanitizeToken)
          .filter(t => t.length >= MIN_ASCII_TOKEN_LENGTH)
      )
    )
    return {
      original,
      matchText: tokens.join(' '),
      tokens,
    }
  }

  const tokenSet = new Set<string>()
  const words: string[] = []
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const segments = segmenter.segment(original)

  for (const { segment, isWordLike } of segments) {
    const cleaned = sanitizeToken(segment.toLowerCase())
    if (!cleaned) continue

    if (/[\u4e00-\u9fff]/.test(cleaned)) {
      // 中文 token：保留单字
      if (isWordLike !== false) {
        // isWordLike 可能 undefined，仅在有明确标注时才过滤
        words.push(cleaned)
        tokenSet.add(cleaned)
      } else {
        // 非 word-like 的 segment（如标点符号）：跳过
      }
    } else if (cleaned.length >= MIN_ASCII_TOKEN_LENGTH) {
      // 非中文 token（英文/数字）：需要最小长度
      words.push(cleaned)
      tokenSet.add(cleaned)
    }
  }

  return {
    original,
    matchText: words.join(' '),
    tokens: Array.from(tokenSet),
  }
}

/**
 * 构建 FTS5 MATCH 表达式：token1* AND token2* AND ...
 * 所有 token 做前缀匹配（`*` 后缀）
 */
export function buildFtsMatchExpression(
  tokens: string[],
  mode: 'AND' | 'OR' = 'AND'
): string | null {
  const sanitized = tokens
    .map(t => sanitizeToken(t))
    .filter(t => t.length > 0)

  if (sanitized.length === 0) return null

  const operator = mode === 'AND' ? ' AND ' : ' OR '
  return sanitized
    .map(token => {
      // 如果 token 包含空格（分段结果），每个子词单独加后缀
      const subTokens = token.split(/\s+/).filter(Boolean)
      if (subTokens.length <= 1) return `${token}*`
      return subTokens.map(st => `${st}*`).join(operator)
    })
    .join(operator)
}
