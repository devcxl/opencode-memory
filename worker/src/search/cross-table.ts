import type { Env, KeywordSearchResult } from '../types'
import type { runAIWithTimeout } from '../utils/ai'

const SOURCE_TABLES = ['instructions', 'learnings', 'dailies'] as const
type SourceTable = (typeof SOURCE_TABLES)[number]

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
  source_table: SourceTable
  snippet?: string
  matchCount?: number
  score: number
  vectorScore: number
  ftsScore: number
}

/**
 * 按 source_table 分组批量查询完整记录。
 * instructions → 取 content 字段
 * learnings   → 取 content 字段
 * dailies     → 取 content 字段
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
        sql = `SELECT id, content AS text, created_at FROM instructions WHERE id IN (${placeholders}) AND archived = 0`
        break
      case 'learnings':
        sql = `SELECT id, content AS text, created_at FROM learnings WHERE id IN (${placeholders}) AND archived = 0`
        break
      case 'dailies':
        sql = `SELECT id, content AS text, created_at FROM dailies WHERE id IN (${placeholders}) AND archived = 0`
        break
    }

    const { results } = await env.DB.prepare(sql).bind(...bindings).all<{
      id: string
      text: string
      created_at: number
    }>()

    for (const row of results || []) {
      recordMap.set(row.id, { ...row, source_table: table })
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
 * 跨表统一搜索入口。
 *
 * 1. AI embedding → Vectorize.query（单 namespace，source_table metadata 区分来源）
 * 2. FTS 搜索 learnings + dailies（instructions 不走 FTS）
 * 3. RRF 融合
 * 4. 批量查询对应表获取完整 record
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

  const vecResults = await env.VEC.query(embedding.data[0], {
    topK: Math.max(topK * 3, topK),
    filter: vecFilter,
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

  // 3. FTS 搜索（learnings + dailies）
  const ftsScores = new Map<string, number>()
  for (const table of ['learnings', 'dailies'] as const) {
    try {
      const ftsResults = await env.DB.prepare(
        `SELECT id, snippet(${table}_fts, 0, '<b>', '</b>', '...', 40) AS snippet,
                bm25(${table}_fts) AS score
         FROM ${table}_fts
         WHERE ${table}_fts MATCH ? AND user_id = ?
         ORDER BY score DESC LIMIT ?`,
      ).bind(query, userId, topK).all<{ id: string; snippet: string; score: number }>()

      for (const row of ftsResults.results || []) {
        const existing = ftsScores.get(row.id)
        if (!existing || row.score > existing) {
          ftsScores.set(row.id, row.score)
        }
      }
    } catch {
      // FTS 表可能未创建或查询失败，跳过
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

  // 5. 收集所有需要查询的 ID
  const allIdsByTable = new Map<SourceTable, string[]>()
  for (const [table, ids] of idsByTable.entries()) {
    allIdsByTable.set(table, ids)
  }
  for (const [id] of ftsScores.entries()) {
    if (!vecScores.has(id)) {
      // FTS-only results → need to figure out which table (default learning)
      if (!allIdsByTable.has('learnings')) allIdsByTable.set('learnings', [])
      if (!allIdsByTable.get('learnings')!.includes(id)) {
        allIdsByTable.get('learnings')!.push(id)
      }
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
    kind: kind || 'long',
    text: r.text,
    tags: '[]',
    created_at: r.created_at,
    archived: 0,
    project_id: '',
    file_type: r.source_table,
    score: r.score,
    snippet: '',
    matchCount: 0,
  }))
}
