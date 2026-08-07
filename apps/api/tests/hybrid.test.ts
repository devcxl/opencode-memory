import test from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion } from '../src/search/hybrid'
import type { Env } from '../src/types'

const learningRecord = {
  id: 'memory-1',
  content:
    'Today I learned how to deploy Cloudflare Workers with D1 and Vectorize indexing.',
  created_at: 1_777_099_454_001,
}

function createEnv(record: typeof learningRecord = learningRecord): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              // FTS 查询（learnings/dailies）
              if (sql.includes('_fts')) {
                return { results: [] as T[] }
              }

              // 向量命中的记录还原：按 id 查询结构化表
              if (sql.includes('FROM learnings WHERE id IN') || sql.includes('FROM instructions WHERE id IN') || sql.includes('FROM dailies WHERE id IN')) {
                return { results: [record] as T[] }
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
      return {
        matches: [
          {
            id: record.id,
            score: 0.92,
            metadata: { source_table: 'learnings' },
          },
        ],
      }
    },
    async upsert() {},
    async describe() { return {} },
    async insert() {},
    async deleteByIds() {},
    async getByIds() { return { results: [] } },
  }

  return {
    DB: db as Env['DB'],
    VEC: vec as unknown as Env['VEC'],
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
