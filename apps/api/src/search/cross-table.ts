import type { Env, KeywordSearchResult } from '../types'
import type { runAIWithTimeout } from '../utils/ai'
import { preprocessQuery, buildFtsMatchExpression } from './tokenizer'

const SOURCE_TABLES = ['instructions', 'learnings', 'dailies', 'memories'] as const
type SourceTable = (typeof SOURCE_TABLES)[number]

/** 各表的 FTS 虚拟表配置（表结构不一致，需分别指定 id 列与 snippet 列） */
const FTS_TABLES: Array<{
  sourceTable: SourceTable
  ftsTable: string
  idExpr: string
  snippetCol: number
}> = [
  { sourceTable: 'learnings', ftsTable: 'learnings_fts', idExpr: 'id', snippetCol: 0 },
  { sourceTable: 'dailies', ftsTable: 'dailies_fts', idExpr: 'id', snippetCol: 0 },
  { sourceTable: 'memories', ftsTable: 'memories_fts', idExpr: 'memory_id', snippetCol: 3 },
]

interface VectorMatch {
  id: string
  score?: number
  metadata?: {
    source_table?: string
  }
}

interface HydratedRecord {
  id: string
  text: string
  created_at: number
  kind?: 'short' | 'long'
  tags?: string
  project_id?: string
  source_table: SourceTable
  snippet?: string
  matchCount?: number
  score: number
  vectorScore: number
  ftsScore: number
}

/**
 * 按 source_table 分组批量查询完整记录。
 * instructions/learnings/dailies → content 字段，kind 固定为 long；
 * memories → text 字段，保留真实 kind。
 */
async function fetchRecordsByIds(
  env: Env,
  idsByTable: Map<SourceTable, string[]>,
): Promise<Map<string, Omit<HydratedRecord, 'score' | 'vectorScore' | 'ftsScore'>>> {
  const recordMap = new Map<string, Omit<HydratedRecord, 'score' | 'vectorScore' | 'ftsScore'>>()

  for (const [table, ids] of idsByTable.entries()) {
    if (ids.length === 0) continue

    const placeholders = ids.map(() => '?').join(',')
    const bindings: string[] = [...ids]

    let sql = ''
    switch (table) {
      case 'instructions':
        sql = `SELECT id, content AS text, created_at, tags, project_id FROM instructions WHERE id IN (${placeholders}) AND archived = 0`
        break
      case 'learnings':
        sql = `SELECT id, content AS text, created_at, tags, project_id FROM learnings WHERE id IN (${placeholders}) AND archived = 0`
        break
      case 'dailies':
        sql = `SELECT id, content AS text, created_at, tags, project_id FROM dailies WHERE id IN (${placeholders}) AND archived = 0`
        break
      case 'memories':
        sql = `SELECT id, text AS text, created_at, kind, tags, project_id FROM memories WHERE id IN (${placeholders}) AND archived = 0`
        break
    }

    const { results } = await env.DB.prepare(sql).bind(...bindings).all<{
      id: string
      text: string
      created_at: number
      kind?: string
      tags?: string
      project_id?: string
    }>()

    for (const row of results || []) {
      recordMap.set(row.id, {
        ...row,
        kind: (row.kind as 'short' | 'long') || 'long',
        source_table: table,
      })
    }
  }

  return recordMap
}

/**
 * RRF (Reciprocal Rank Fusion) 融合向量分数和 FTS 分数。
 */
function rrf(items: Array<{ id: string; vectorScore: number; ftsScore: number }>, k = 60): Map<string, number> {
  const scores = new Map<string, number>()

  const vectorSorted = [...items].sort((a, b) => b.vectorScore - a.vectorScore)
  const ftsSorted = [...items].sort((a, b) => b.ftsScore - a.ftsScore)

  for (let i = 0; i < vectorSorted.length; i++) {
    const id = vectorSorted[i].id
    scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1))
  }
  for (let i = 0; i < ftsSorted.length; i++) {
    const id = ftsSorted[i].id
    scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1))
  }

  return scores
}

interface CrossTableSearchOptions {
  query: string
  userId: string
  kind?: 'short' | 'long'
  topK?: number
  file_type?: string
  project_id?: string
}

/**
 * 跨表统一搜索入口（结构化表 + 经典 memories 表）。
 *
 * 1. AI embedding → Vectorize.query（单 namespace，source_table metadata 区分来源）
 * 2. FTS 关键词搜索 learnings/dailies/memories（instructions 不走 FTS）
 * 3. RRF 融合
 * 4. 按 source_table 批量查询对应表获取完整 record
 */
export async function crossTableSearch(
  env: Env,
  depsRunAIWithTimeout: typeof runAIWithTimeout,
  options: CrossTableSearchOptions,
): Promise<KeywordSearchResult[]> {
  const { query, userId, kind, topK = 8, file_type, project_id } = options

  if (!env.AI || !env.VEC) {
    return []
  }

  // 1. Vectorize 向量搜索
  const embedding = await depsRunAIWithTimeout<{ data: number[][] }>(
    env.AI,
    '@cf/qwen/qwen3-embedding-0.6b',
    { text: query },
  )

  const vecFilter: Record<string, string> = { user_id: userId }
  if (file_type) vecFilter.file_type = file_type
  if (project_id) vecFilter.project_id = project_id
  if (kind) vecFilter.kind = kind

  // Vectorize 限制：returnMetadata: 'all' 时 topK 上限 50，超出会抛错
  const vectorTopK = Math.min(Math.max(topK * 3, topK), 50)
  const vecResults = await env.VEC.query(embedding.data[0], {
    topK: vectorTopK,
    filter: vecFilter,
    returnMetadata: 'all',
  })

  const vecMatches = (vecResults.matches || []) as VectorMatch[]

  // 2. 按 source_table 分组向量匹配
  const idsByTable = new Map<SourceTable, string[]>()
  const vecScores = new Map<string, number>()

  for (const match of vecMatches) {
    const sourceTable = (match.metadata?.source_table || 'learnings') as SourceTable
    if (!SOURCE_TABLES.includes(sourceTable)) continue

    if (!idsByTable.has(sourceTable)) idsByTable.set(sourceTable, [])
    idsByTable.get(sourceTable)!.push(match.id)
    vecScores.set(match.id, match.score ?? 0)
  }

  // 3. FTS 关键词搜索（learnings + dailies + memories）
  const ftsScores = new Map<string, number>()
  const ftsTableById = new Map<string, SourceTable>()
  const ftsSnippets = new Map<string, string>()
  const processed = preprocessQuery(query)
  const matchExpression = buildFtsMatchExpression(processed.tokens)

  if (matchExpression) {
    for (const { sourceTable, ftsTable, idExpr, snippetCol } of FTS_TABLES) {
      // 结构化表只有 long 记录：kind=short 时跳过（memories 表才有 short）
      if (kind && kind !== 'long' && sourceTable !== 'memories') continue
      try {
        const bindings: Array<string | number> = [matchExpression, userId]
        let sql = `SELECT ${idExpr} AS id, snippet(${ftsTable}, ${snippetCol}, '<b>', '</b>', '...', 40) AS snippet,
                  bm25(${ftsTable}) AS score
           FROM ${ftsTable}
           WHERE ${ftsTable} MATCH ? AND user_id = ?`
        if (kind && sourceTable === 'memories') {
          sql += ' AND kind = ?'
          bindings.push(kind)
        }
        sql += ' ORDER BY score DESC LIMIT ?'
        bindings.push(topK)

        const ftsResults = await env.DB.prepare(sql).bind(...bindings).all<{ id: string; snippet: string; score: number }>()

        for (const row of ftsResults.results || []) {
          const existing = ftsScores.get(row.id)
          if (!existing || row.score > existing) {
            ftsScores.set(row.id, row.score)
            ftsTableById.set(row.id, sourceTable)
            if (row.snippet) ftsSnippets.set(row.id, row.snippet)
          }
        }
      } catch {
        // FTS 表可能未创建或查询失败，跳过
      }
    }
  }

  // 4. RRF 融合
  const fusionInput = [
    ...vecMatches.map((m) => ({
      id: m.id,
      vectorScore: m.score ?? 0,
      ftsScore: ftsScores.get(m.id) ?? 0,
    })),
    ...Array.from(ftsScores.entries())
      .filter(([id]) => !vecScores.has(id))
      .map(([id, score]) => ({
        id,
        vectorScore: 0,
        ftsScore: score,
      })),
  ]

  const finalScores = rrf(fusionInput)

  // 5. 收集所有需要查询的 ID（按真实来源表分组）
  const allIdsByTable = new Map<SourceTable, string[]>()
  const push = (table: SourceTable, id: string) => {
    if (!allIdsByTable.has(table)) allIdsByTable.set(table, [])
    if (!allIdsByTable.get(table)!.includes(id)) allIdsByTable.get(table)!.push(id)
  }

  for (const [table, ids] of idsByTable.entries()) {
    for (const id of ids) push(table, id)
  }
  for (const [id] of ftsScores.entries()) {
    if (!vecScores.has(id)) {
      push(ftsTableById.get(id) || 'learnings', id)
    }
  }

  // 6. 批量查询完整记录
  const records = await fetchRecordsByIds(env, allIdsByTable)

  // 7. 组装结果
  const results: HydratedRecord[] = []
  for (const [id, score] of finalScores.entries()) {
    const record = records.get(id)
    if (!record) continue

    results.push({
      ...record,
      score,
      vectorScore: vecScores.get(id) ?? 0,
      ftsScore: ftsScores.get(id) ?? 0,
    })
  }

  results.sort((a, b) => b.score - a.score)

  return results.slice(0, topK).map((r) => ({
    id: r.id,
    user_id: userId,
    kind: r.kind || kind || 'long',
    text: r.text,
    tags: r.tags ?? '[]',
    created_at: r.created_at,
    archived: 0,
    project_id: r.project_id ?? '',
    file_type: r.source_table,
    score: r.score,
    snippet: r.snippet ?? ftsSnippets.get(r.id) ?? '',
    matchCount: r.matchCount ?? (ftsScores.has(r.id) ? processed.tokens.length : 0),
  }))
}
