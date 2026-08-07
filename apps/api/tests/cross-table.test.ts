import test from 'node:test'
import assert from 'node:assert/strict'
import { crossTableSearch } from '../src/search/cross-table'
import type { Env } from '../src/types'

const dailyRecord = {
  id: 'daily-1',
  text: '调研：OpenAI gpt-realtime-whisper 与 Realtime API 接入评估',
  created_at: 1_777_099_454_001,
}

function createEnv(): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              // FTS 查询
              if (sql.includes('_fts')) {
                return { results: [] as T[] }
              }

              // 向量命中记录还原：dailies 表
              if (sql.includes('FROM dailies WHERE id IN')) {
                return { results: [dailyRecord] as T[] }
              }

              // learnings/instructions 表应无匹配（用于验证 dailies 被正确分组）
              return { results: [] as T[] }
            },
          }
        },
      }
    },
  }

  const vec = {
    async query(_vector: number[], _options: { returnMetadata?: unknown }) {
      // 模拟 returnMetadata:'all' 生效：返回带 source_table=dailies 的匹配
      assert.equal(_options.returnMetadata, 'all')
      return {
        matches: [
          {
            id: dailyRecord.id,
            score: 0.98,
            metadata: { source_table: 'dailies' },
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

test('crossTableSearch 能按 source_table 召回 dailies', async () => {
  const env = createEnv()

  const runAIWithTimeout = async <T,>(_ai: Env['AI'], model: string): Promise<T> => {
    assert.equal(model, '@cf/qwen/qwen3-embedding-0.6b')
    return { data: [[0.1, 0.2, 0.3]] } as T
  }

  const results = await crossTableSearch(env, runAIWithTimeout, {
    query: 'gpt-realtime-whisper transcription',
    userId: 'user-1',
    topK: 5,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'daily-1')
  assert.equal(results[0].file_type, 'dailies')
  assert.equal(results[0].text, dailyRecord.text)
})

// ─── 统一检索：纳入 classic memories 表 ──────────────────────

test('crossTableSearch 能召回 classic memories 表记录并保留 kind', async () => {
  const memoryRecord = {
    id: 'mem-1',
    text: 'Remember to use PostgreSQL',
    created_at: 1_777_000_000_000,
    kind: 'short',
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes('_fts')) return { results: [] as T[] }
              if (sql.includes('FROM memories WHERE id IN')) {
                return { results: [memoryRecord] as T[] }
              }
              return { results: [] as T[] }
            },
          }
        },
      }
    },
  }

  const vec = {
    async query() {
      return {
        matches: [
          { id: memoryRecord.id, score: 0.9, metadata: { source_table: 'memories' } },
        ],
      }
    },
    async upsert() {}, async describe() { return {} }, async insert() {},
    async deleteByIds() {}, async getByIds() { return { results: [] } },
  }

  const env = {
    DB: db as Env['DB'],
    VEC: vec as unknown as Env['VEC'],
    AI: { async run() { return {} } },
    JWT_SECRET: 's',
  }

  const runAIWithTimeout = async <T,>(_ai: Env['AI']): Promise<T> => {
    return { data: [[0.1]] } as T
  }

  const results = await crossTableSearch(env, runAIWithTimeout, {
    query: 'postgresql',
    userId: 'user-1',
    topK: 5,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'mem-1')
  assert.equal(results[0].file_type, 'memories')
  assert.equal(results[0].kind, 'short')
})

// ─── FTS-only 结果按真实来源表路由 ──────────────────────────

test('FTS-only daily 命中按真实来源表路由到 dailies（不再误入 learnings）', async () => {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              // dailies_fts 给出纯关键词命中
              if (sql.includes('FROM dailies_fts')) {
                return { results: [{ id: 'daily-1', snippet: '...', score: -1 }] as T[] }
              }
              if (sql.includes('FROM learnings_fts') || sql.includes('memory_id')) {
                return { results: [] as T[] }
              }
              // 只有 dailies 表能还原该记录
              if (sql.includes('FROM dailies WHERE id IN')) {
                return { results: [dailyRecord] as T[] }
              }
              return { results: [] as T[] }
            },
          }
        },
      }
    },
  }

  const vec = {
    async query() {
      return { matches: [] }
    },
    async upsert() {}, async describe() { return {} }, async insert() {},
    async deleteByIds() {}, async getByIds() { return { results: [] } },
  }

  const env = {
    DB: db as Env['DB'],
    VEC: vec as unknown as Env['VEC'],
    AI: { async run() { return {} } },
    JWT_SECRET: 's',
  }

  const runAIWithTimeout = async <T,>(_ai: Env['AI']): Promise<T> => {
    return { data: [[0.1]] } as T
  }

  const results = await crossTableSearch(env, runAIWithTimeout, {
    query: 'gpt-realtime-whisper',
    userId: 'user-1',
    topK: 5,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'daily-1')
  assert.equal(results[0].text, dailyRecord.text)
  assert.equal(results[0].file_type, 'dailies')
})
