import type { Env, AskResponse, RagCitation, SearchResult } from '../types'
import { LLM_MODEL } from '../types'
import { searchMemories } from '../search/hybrid'
import { runAIWithTimeout } from '../utils/ai'

/**
 * RAG 问答：两桶分层检索 → 拼 context → LLM 结构化生成 {answer, citations}。
 */

const MIN_ASK_TOP_K = 6

interface AskOptions {
  question: string
  userId: string
  projectId?: string
  topK?: number
}

export async function answerQuestion(env: Env, opts: AskOptions): Promise<AskResponse> {
  if (!env.AI) throw new Error('AI not configured')

  const topK = Math.max(opts.topK || MIN_ASK_TOP_K, MIN_ASK_TOP_K)
  const results = await searchMemories(env, {
    query: opts.question,
    userId: opts.userId,
    projectId: opts.projectId,
    topK,
  })
  if (results.length === 0) {
    return { answer: 'I could not find relevant memories for that question.', citations: [] }
  }

  const context = results
    .map((r) => `[${r.id}]\ntype: ${r.type}${r.subtype ? `/${r.subtype}` : ''}\ndate: ${r.date}\ntext:\n${r.title ? `${r.title}\n` : ''}${r.content}`)
    .join('\n\n')

  const generationInput = {
    messages: [
      {
        role: 'system',
        content: `You are a retrieval assistant. Answer only from the provided memory context.
If the context is insufficient, say that clearly.
Return valid JSON: {"answer":"string","citations":["memory-id-1","memory-id-2"]}
/no_think`,
      },
      { role: 'user', content: `Question:\n${opts.question}\n\nContext:\n${context}` },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  }

  let response: unknown
  try {
    response = await runAIWithTimeout(env.AI, LLM_MODEL, {
      ...generationInput,
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            citations: { type: 'array', items: { type: 'string' } },
          },
          required: ['answer', 'citations'],
          additionalProperties: false,
        },
      },
    })
  } catch {
    response = await runAIWithTimeout(env.AI, LLM_MODEL, generationInput)
  }

  const parsed = extractJson(response)
  const rawText = extractText(response)
  const citedIds = new Set(
    parsed?.citations?.length ? parsed.citations : results.slice(0, 3).map((r) => r.id),
  )

  const citations: RagCitation[] = results
    .filter((r: SearchResult) => citedIds.has(r.id))
    .map((r) => ({
      memoryId: r.id,
      text: r.title ? `${r.title}\n${r.content}` : r.content,
      createdAt: r.created_at,
      type: r.type,
      score: r.score,
    }))

  return {
    answer: parsed?.answer?.trim() || rawText.trim() || 'I could not generate an answer from the retrieved context.',
    citations,
  }
}

function extractJson(response: unknown): { answer?: string; citations?: string[] } | null {
  const raw = extractText(response)
  if (!raw) return null
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '')
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as { answer?: string; citations?: string[] }
  } catch {
    return null
  }
}

function extractText(response: unknown): string {
  if (typeof response === 'string') return response
  const direct = (response as { response?: string | { answer?: string } })?.response
  if (typeof direct === 'string') return direct
  if (direct && typeof direct === 'object' && typeof direct.answer === 'string') return direct.answer
  const choice = (response as { choices?: Array<{ message?: { content?: string }; text?: string }> })?.choices?.[0]
  return choice?.message?.content || choice?.text || ''
}
