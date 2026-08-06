import type { Env, KeywordSearchResult, Memory } from '../types'
import { preprocessQuery, buildFtsMatchExpression } from './tokenizer'
import { normalizeScores } from './scoring'

interface KeywordSearchOptions {
  query: string
  userId: string
  kind?: 'short' | 'long'
  limit?: number
  file_type?: string
  project_id?: string
}

interface FtsMemoryRow extends Memory {
  rank: number
  snippet: string
}

export interface FtsMemoryResult extends Memory {
  bm25Score: number
}

/**
 * FTS5 关键词搜索（带 snippet，结果分数归一化）
 */
export async function searchMemoriesByKeyword(
  env: Env,
  options: KeywordSearchOptions
): Promise<KeywordSearchResult[]> {
  const { query, userId, kind, limit = 10, file_type, project_id } = options
  const processed = preprocessQuery(query)
  const matchExpression = buildFtsMatchExpression(processed.tokens)

  if (!matchExpression) {
    return []
  }

  const bindings: Array<string | number> = [matchExpression, userId]
  let sql = `
    SELECT
      m.*,
      snippet(memories_fts, 3, '[', ']', '...', 18) AS snippet,
      bm25(memories_fts) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.memory_id
    WHERE memories_fts MATCH ?
      AND m.user_id = ?
      AND m.archived = 0
  `

  if (kind) {
    sql += ' AND m.kind = ?'
    bindings.push(kind)
  }

  if (file_type) {
    sql += ' AND m.file_type = ?'
    bindings.push(file_type)
  }

  if (project_id) {
    sql += ' AND m.project_id = ?'
    bindings.push(project_id)
  }

  sql += ' ORDER BY rank ASC, m.created_at DESC LIMIT ?'
  bindings.push(limit)

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<FtsMemoryRow>()
  if (!results?.length) {
    return []
  }

  const mapped = results.map((row) => ({
    ...row,
    snippet: row.snippet || row.text.slice(0, 220),
    score: Number.isFinite(row.rank) ? -row.rank : 0,
    matchCount: processed.tokens.length,
  }))

  // min-max 归一化到 [0, 1]，方便前端展示一致性
  return normalizeScores(mapped)
}

/**
 * RAG 用关键词搜索（无 snippet，返回原始 BM25 分数用于后续混合检索归一化）
 */
export async function searchMemoriesByKeywordForRag(
  env: Env,
  options: KeywordSearchOptions
): Promise<FtsMemoryResult[]> {
  const { query, userId, kind, limit = 10, file_type, project_id } = options
  const processed = preprocessQuery(query)
  const matchExpression = buildFtsMatchExpression(processed.tokens)

  if (!matchExpression) {
    return []
  }

  const bindings: Array<string | number> = [matchExpression, userId]
  let sql = `
    SELECT m.*, bm25(memories_fts) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.memory_id
    WHERE memories_fts MATCH ?
      AND m.user_id = ?
      AND m.archived = 0
  `

  if (kind) {
    sql += ' AND m.kind = ?'
    bindings.push(kind)
  }

  if (file_type) {
    sql += ' AND m.file_type = ?'
    bindings.push(file_type)
  }

  if (project_id) {
    sql += ' AND m.project_id = ?'
    bindings.push(project_id)
  }

  sql += ' ORDER BY rank ASC LIMIT ?'
  bindings.push(limit)

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<FtsMemoryRow>()
  if (!results?.length) {
    return []
  }

  return results.map((row) => ({
    ...row,
    bm25Score: Number.isFinite(row.rank) ? -row.rank : 0,
  }))
}
