import type { AskResponse, Env, KeywordSearchResult, Memory, RagCitation } from '../types'
import { searchMemoriesByKeywordForRag, type FtsMemoryResult } from './keyword-search'
import { preprocessQuery } from './tokenizer'
import { normalizeScores, recencyBoost, RECENCY_WEIGHT } from './scoring'

// ─── 类型定义 ───────────────────────────────────────

interface EmbeddingResponse {
  data: number[][]
}

interface GenerationResponse {
  response?: string | {
    answer?: string
    citations?: string[]
  }
  choices?: Array<{
    message?: {
      content?: string
    }
    text?: string
  }>
}

interface VectorMatch {
  id: string
  score?: number
}

interface QueryOptions {
  query: string
  userId: string
  kind?: 'short' | 'long'
  topK?: number
}

/** 混合搜索可选项 */
interface HybridSearchOptions extends QueryOptions {
  limit?: number
  file_type?: string
  project_id?: string
}

/** 向量搜索结果（已 DB lookup 还原为 Memory） */
interface RankedMemory extends Memory {
  vectorScore: number
  score: number
}

// ─── 常量 ───────────────────────────────────────────

const MIN_ASK_TOP_K = 6
const RRF_K = 60
/** 向量检索时 over-fetch 倍率（弥补 DB 过滤后的损耗） */
const VECTOR_OVERFETCH_RATIO = 3

// ─── 纯向量检索 ─────────────────────────────────────

async function retrieveRankedMemories(
  env: Env,
  runAIWithTimeout: <T>(ai: Env['AI'], model: string, input: unknown) => Promise<T>,
  options: QueryOptions & { embeddingText?: string; file_type?: string; project_id?: string }
): Promise<RankedMemory[]> {
  if (!env.AI || !env.VEC) {
    throw new Error('AI/Vectorize not configured')
  }

  const { query, userId, kind, topK = 8, embeddingText, file_type, project_id } = options

  const embedding = await runAIWithTimeout<EmbeddingResponse>(
    env.AI,
    '@cf/qwen/qwen3-embedding-0.6b',
    { text: embeddingText || query }
  )

  const filter: Record<string, string> = { user_id: userId }
  if (kind) filter.kind = kind
  if (file_type) filter.file_type = file_type
  if (project_id) filter.project_id = project_id

  const results = await env.VEC.query(embedding.data[0], {
    topK: Math.max(topK * VECTOR_OVERFETCH_RATIO, topK),
    filter,
  })

  const matches = (results.matches || []) as VectorMatch[]
  if (matches.length === 0) return []

  const memoryMap = await fetchMemoriesByIds(env, matches.map(m => m.id), userId, kind)

  return matches
    .map((match) => {
      const memory = memoryMap.get(match.id)
      if (!memory) return null

      return {
        ...memory,
        vectorScore: typeof match.score === 'number' ? match.score : 0,
        score: typeof match.score === 'number' ? match.score : 0,
      }
    })
    .filter((m): m is RankedMemory => Boolean(m))
    .slice(0, topK)
}

async function fetchMemoriesByIds(
  env: Env,
  memoryIds: string[],
  userId: string,
  kind?: 'short' | 'long'
): Promise<Map<string, Memory>> {
  if (memoryIds.length === 0) return new Map()

  const placeholders = memoryIds.map(() => '?').join(',')
  const bindings: Array<string> = [...memoryIds, userId]
  let sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND user_id = ? AND archived = 0`

  if (kind) {
    sql += ' AND kind = ?'
    bindings.push(kind)
  }

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<Memory>()
  return new Map((results || []).map(memory => [memory.id, memory]))
}

// ─── RRF 融合 ───────────────────────────────────────

/**
 * 倒数秩融合（Reciprocal Rank Fusion）
 *
 * 将向量检索与 FTS 两个独立排序的结果合并为单一排序。
 * 仅在融合层应用一次 recency，避免双重计算。
 *
 * RRFi = 1/(k + rank_i)  求和向量/FTS各自的贡献
 * finalScore = RRF + recencyBoost * WEIGHT
 */
function reciprocalRankFusion(
  vectorResults: RankedMemory[],
  ftsResults: FtsMemoryResult[],
  topK: number
): RankedMemory[] {
  type ScoreEntry = {
    rrfScore: number
    memory: RankedMemory | null
    ftsMemory: FtsMemoryResult | null
  }
  const scoreMap = new Map<string, ScoreEntry>()

  for (let rank = 0; rank < vectorResults.length; rank++) {
    const memory = vectorResults[rank]
    scoreMap.set(memory.id, {
      rrfScore: 1 / (RRF_K + rank + 1),
      memory,
      ftsMemory: null,
    })
  }

  for (let rank = 0; rank < ftsResults.length; rank++) {
    const ftsMemory = ftsResults[rank]
    const rrfContribution = 1 / (RRF_K + rank + 1)
    const existing = scoreMap.get(ftsMemory.id)

    if (existing) {
      existing.rrfScore += rrfContribution
      existing.ftsMemory = ftsMemory
    } else {
      scoreMap.set(ftsMemory.id, { rrfScore: rrfContribution, memory: null, ftsMemory })
    }
  }

  const ranked = Array.from(scoreMap.values())
    .map(({ rrfScore, memory, ftsMemory }) => {
      const base = memory || ftsMemory!
      return {
        id: base.id,
        user_id: base.user_id,
        kind: base.kind,
        text: base.text,
        tags: base.tags,
        source: base.source,
        created_at: base.created_at,
        expires_at: base.expires_at,
        consolidated_at: base.consolidated_at,
        archived: base.archived,
        project_id: base.project_id || '',
        file_type: base.file_type || 'memory',
        date: base.date || null,
        vectorScore: memory?.vectorScore ?? 0,
        score: rrfScore + recencyBoost(base.created_at) * RECENCY_WEIGHT,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  // 归一化最终分数，方便前端展示百分比
  return normalizeScores(ranked)
}

// ─── 混合搜索（统一入口）────────────────────────────

/**
 * 混合搜索：向量检索 + FTS5 关键词并行搜索 → 分数归一化 → RRF 融合
 *
 * 这是搜索的默认入口，前端和 MCP 都使用此函数。
 * 关键词搜索作为降级选项保留。
 */
export async function hybridSearch(
  env: Env,
  runAIWithTimeout: <T>(ai: Env['AI'], model: string, input: unknown) => Promise<T>,
  options: HybridSearchOptions
): Promise<KeywordSearchResult[]> {
  const { limit = 5, file_type, project_id } = options
  const topK = Math.max(limit * 2, options.topK || limit)
  const processed = preprocessQuery(options.query)

  // 并行执行两种检索
  const [vectorResults, ftsResults] = await Promise.all([
    retrieveRankedMemories(env, runAIWithTimeout, { ...options, topK, file_type, project_id })
      .catch(() => [] as RankedMemory[]),
    processed.tokens.length > 0
      ? searchMemoriesByKeywordForRag(env, {
          query: options.query,
          userId: options.userId,
          kind: options.kind,
          limit: topK,
          file_type,
          project_id,
        }).catch(() => [] as FtsMemoryResult[])
      : Promise.resolve([] as FtsMemoryResult[]),
  ])

  // 如果两者都为空，直接返回
  if (vectorResults.length === 0 && ftsResults.length === 0) return []

  // 向量分数归一化到 [0, 1]
  const normalizedVector = vectorResults.length > 0
    ? normalizeScores(vectorResults)
    : []

  // FTS BM25 分数归一化到 [0, 1]
  const normalizedFts = ftsResults.length > 0
    ? normalizeScores(ftsResults.map(r => ({ ...r, score: r.bm25Score })))
    : []

  // RRF 融合
  const ranked = reciprocalRankFusion(normalizedVector, normalizedFts, limit)

  return ranked.map((m) => ({
    ...m,
    snippet: m.text.length > 220 ? `${m.text.slice(0, 217)}...` : m.text,
    matchCount: processed.tokens.length,
    score: m.score,
  }))
}

// ─── RAG 问答 ───────────────────────────────────────

function buildMessages(question: string, memories: RankedMemory[]): Array<{ role: string; content: string }> {
  const context = memories.map((m) =>
    `[${m.id}]\nkind: ${m.kind}\ncreated_at: ${new Date(m.created_at).toISOString()}\ntext:\n${m.text}`
  ).join('\n\n')

  return [
    {
      role: 'system',
      content: `You are a retrieval assistant. Answer only from the provided memory context.
If the context is insufficient, say that clearly.
Return valid JSON with this shape:
{"answer":"string","citations":["memory-id-1","memory-id-2"]}
/no_think`,
    },
    {
      role: 'user',
      content: `Question:\n${question}\n\nContext:\n${context}`,
    },
  ]
}

function parseJsonResponse(text: string): { answer?: string; citations?: string[] } | null {
  // 支持 ```json ... ``` 和裸 JSON 两种格式
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '')
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null

  try {
    return JSON.parse(match[0]) as { answer?: string; citations?: string[] }
  } catch {
    return null
  }
}

function extractStructuredAnswer(
  response: GenerationResponse
): { answer?: string; citations?: string[] } | null {
  const candidate = response.response
  if (typeof candidate === 'object' && candidate !== null) {
    const answer = typeof candidate.answer === 'string' ? candidate.answer : undefined
    const citations = Array.isArray(candidate.citations)
      ? candidate.citations.filter((item): item is string => typeof item === 'string')
      : undefined

    if (answer !== undefined || citations !== undefined) {
      return { answer, citations }
    }
  }

  const text = extractModelText(response)
  if (text) {
    return parseJsonResponse(text)
  }

  return null
}

function extractModelText(response: GenerationResponse): string {
  if (typeof response.response === 'string') {
    return response.response
  }

  const firstChoice = response.choices?.[0]
  if (typeof firstChoice?.message?.content === 'string') {
    return firstChoice.message.content
  }

  if (typeof firstChoice?.text === 'string') {
    return firstChoice.text
  }

  return ''
}

export async function answerQuestion(
  env: Env,
  runAIWithTimeout: <T>(ai: Env['AI'], model: string, input: unknown) => Promise<T>,
  options: QueryOptions
): Promise<AskResponse> {
  if (!env.AI) throw new Error('AI not configured')

  const topK = Math.max(options.topK || MIN_ASK_TOP_K, MIN_ASK_TOP_K)

  // 并行执行两种检索
  const [vectorResults, ftsResults] = await Promise.all([
    retrieveRankedMemories(env, runAIWithTimeout, { ...options, topK })
      .catch(() => [] as RankedMemory[]),
    searchMemoriesByKeywordForRag(env, {
      query: options.query,
      userId: options.userId,
      kind: options.kind,
      limit: topK,
    }).catch(() => [] as FtsMemoryResult[]),
  ])

  // 归一化后 RRF 融合
  const normalizedVector = normalizeScores(vectorResults)
  const normalizedFts = ftsResults.map(r => ({ ...r, score: r.bm25Score }))
  const normalizedFtsScores = normalizeScores(normalizedFts)
  const rankedMemories = reciprocalRankFusion(normalizedVector, normalizedFtsScores, topK)

  if (rankedMemories.length === 0) {
    return { answer: 'I could not find relevant memories for that question.', citations: [] }
  }

  // LLM 生成
  const promptMemories = rankedMemories.slice(0, 5)
  const generationInput = {
    messages: buildMessages(options.query, promptMemories),
    max_tokens: 4096,
    temperature: 0.2,
  }

  let response: GenerationResponse
  try {
    response = await runAIWithTimeout<GenerationResponse>(
      env.AI,
      '@cf/qwen/qwen3-30b-a3b-fp8',
      {
        ...generationInput,
        response_format: {
          type: 'json_schema',
          json_schema: {
            type: 'object',
            properties: {
              answer: { type: 'string' },
              citations: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['answer', 'citations'],
            additionalProperties: false,
          },
        },
      }
    )
  } catch {
    response = await runAIWithTimeout<GenerationResponse>(
      env.AI,
      '@cf/qwen/qwen3-30b-a3b-fp8',
      generationInput
    )
  }

  const rawText = extractModelText(response)
  const parsed = extractStructuredAnswer(response)
  const citedIds = new Set(
    parsed?.citations?.length
      ? parsed.citations
      : promptMemories.slice(0, 3).map(m => m.id)
  )

  const citations: RagCitation[] = promptMemories
    .filter(m => citedIds.has(m.id))
    .map(m => ({
      memoryId: m.id,
      text: m.text,
      createdAt: m.created_at,
      kind: m.kind,
      score: m.score,
    }))

  return {
    answer: parsed?.answer?.trim() || rawText.trim() || 'I could not generate an answer from the retrieved context.',
    citations,
  }
}
