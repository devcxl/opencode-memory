import test from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion } from './hybrid'
import type { Env, Memory } from '../types'

const baseMemory: Memory = {
  id: 'memory-1',
  user_id: 'user-1',
  kind: 'short',
  text: 'Today I learned how to deploy Cloudflare Workers with D1 and Vectorize indexing.',
  tags: '[]',
  created_at: 1_777_099_454_001,
  archived: 0,
  source: undefined,
  expires_at: null,
  consolidated_at: null,
}

function createEnv(memory: Memory = baseMemory): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes('FROM memories_fts')) {
                return { results: [] as T[] }
              }

              if (sql.includes('FROM memories WHERE id IN')) {
                return { results: [memory] as T[] }
              }

              return { results: [] as T[] }
            },
          }
        },
      }
    },
  }

  const vec = {
    async query(_vector: number[], _options: unknown) {
      return { matches: [{ id: memory.id, score: 0.92 }] }
    },
  }

  return {
    DB: db as Env['DB'],
    VEC: vec as Env['VEC'],
    AI: {
      async run() {
        throw new Error('AI.run should be mocked via runAIWithTimeout')
      },
    },
    JWT_SECRET: 'test-secret',
  }
}

test('answerQuestion 支持 JSON Mode 直接返回结构化对象', async () => {
  const env = createEnv()

  const runAIWithTimeout = async <T,>(_ai: Env['AI'], model: string, input: unknown): Promise<T> => {
    if (model === '@cf/qwen/qwen3-embedding-0.6b') {
      return { data: [[0.1, 0.2, 0.3]] } as T
    }

    assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8')
    const generationInput = input as { response_format?: unknown }
    assert.ok(generationInput.response_format)

    return {
      response: {
        answer: 'Today I learned how to deploy Cloudflare Workers with D1 and Vectorize indexing.',
        citations: ['memory-1'],
      },
    } as T
  }

  const result = await answerQuestion(env, runAIWithTimeout, {
    query: 'deploy Cloudflare Workers with D1',
    userId: 'user-1',
    topK: 6,
  })

  assert.equal(result.answer, 'Today I learned how to deploy Cloudflare Workers with D1 and Vectorize indexing.')
  assert.deepEqual(result.citations.map((item) => item.memoryId), ['memory-1'])
})

test('answerQuestion 在 JSON Mode 失败后回退到文本模式解析 JSON 字符串', async () => {
  const env = createEnv()
  let generationCalls = 0

  const runAIWithTimeout = async <T,>(_ai: Env['AI'], model: string, input: unknown): Promise<T> => {
    if (model === '@cf/qwen/qwen3-embedding-0.6b') {
      return { data: [[0.1, 0.2, 0.3]] } as T
    }

    assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8')
    generationCalls += 1
    const generationInput = input as { response_format?: unknown }

    if (generationCalls === 1) {
      assert.ok(generationInput.response_format)
      throw new Error('JSON Mode could not be met')
    }

    assert.equal(generationInput.response_format, undefined)
    return {
      response: '{"answer":"Fallback answer from text mode","citations":["memory-1"]}',
    } as T
  }

  const result = await answerQuestion(env, runAIWithTimeout, {
    query: 'deploy Cloudflare Workers with D1',
    userId: 'user-1',
    topK: 6,
  })

  assert.equal(generationCalls, 2)
  assert.equal(result.answer, 'Fallback answer from text mode')
  assert.deepEqual(result.citations.map((item) => item.memoryId), ['memory-1'])
})
