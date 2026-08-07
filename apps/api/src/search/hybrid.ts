import type { AskResponse, Env, KeywordSearchResult, Memory, RagCitation } from '../types'
import { crossTableSearch } from './cross-table'

// ─── 类型定义 ───────────────────────────────────────

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

interface QueryOptions {
  query: string
  userId: string
  kind?: 'short' | 'long'
  topK?: number
}

/** 跨表检索结果（已还原为 Memory 结构） */
interface RankedMemory extends Memory {
  vectorScore: number
  score: number
}

// ─── 常量 ───────────────────────────────────────────

const MIN_ASK_TOP_K = 6

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

function mapSource(source?: string): 'learning' | 'instruction' | 'daily' | 'memory' | undefined {
  switch (source) {
    case 'learnings':
    case 'learning':
      return 'learning'
    case 'instructions':
    case 'instruction':
      return 'instruction'
    case 'dailies':
    case 'daily':
      return 'daily'
    case 'memories':
    case 'memory':
      return 'memory'
    default:
      return undefined
  }
}

export async function answerQuestion(
  env: Env,
  runAIWithTimeout: <T>(ai: Env['AI'], model: string, input: unknown) => Promise<T>,
  options: QueryOptions
): Promise<AskResponse> {
  if (!env.AI) throw new Error('AI not configured')

  const topK = Math.max(options.topK || MIN_ASK_TOP_K, MIN_ASK_TOP_K)

  // 跨表统一检索（结构化记忆 + 经典 memories 表均由 cross-table 负责）
  const crossResults = await crossTableSearch(env, runAIWithTimeout, {
    query: options.query,
    userId: options.userId,
    kind: options.kind,
    topK,
  }).catch(() => [] as KeywordSearchResult[])

  const rankedMemories: RankedMemory[] = crossResults.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    kind: (r.kind || 'long') as 'short' | 'long',
    text: r.text,
    tags: r.tags || '[]',
    source: r.file_type,
    created_at: r.created_at,
    expires_at: null,
    consolidated_at: null,
    archived: 0,
    project_id: r.project_id || '',
    file_type: r.file_type || 'memory',
    date: r.date || null,
    vectorScore: r.score || 0,
    score: r.score || 0,
  }))

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
      source: mapSource(m.source),
    }))

  return {
    answer: parsed?.answer?.trim() || rawText.trim() || 'I could not generate an answer from the retrieved context.',
    citations,
  }
}
