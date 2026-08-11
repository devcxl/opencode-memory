import test from 'node:test'
import assert from 'node:assert/strict'
import { crossTableSearch } from '../src/search/cross-table'
import type { Env } from '../src/types'

const dailyRecord = {
  id: 'daily-1',
  text: '调研：OpenAI gpt-realtime-whisper 与 Realtime API 接入评估',
  created_at: 1_777_099_454_001,
}

const vecQueryOptions: Array<Record<string, unknown>> = []

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
      vecQueryOptions.push({ ..._options })
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

test('crossTableSearch 向量查询 topK 不超过 Vectorize 上限 50（returnMetadata=all）', async () => {
  vecQueryOptions.length = 0
  const env = createEnv()

  const runAIWithTimeout = async <T,>(_ai: Env['AI']): Promise<T> => {
    return { data: [[0.1, 0.2, 0.3]] } as T
  }

  await crossTableSearch(env, runAIWithTimeout, {
    query: 'some query',
    userId: 'user-1',
    topK: 20,
  })

  assert.equal(vecQueryOptions.length, 1)
  const topK = vecQueryOptions[0].topK as number
  assert.ok(topK <= 50, `topK=${topK} 超过 Vectorize 上限 50`)
  assert.equal(topK, 50)
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

// ─── kind 过滤 ──────────────────────────────────────────────

test('crossTableSearch 传 kind 时向量过滤并跳过结构化表 FTS', async () => {
  const ftsSql: string[] = []
  let vecFilter: Record<string, string> | undefined

  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes('_fts')) {
                ftsSql.push(sql)
                return { results: [] as T[] }
              }
              return { results: [] as T[] }
            },
          }
        },
      }
    },
  }

  const vec = {
    async query(_vector: number[], options: { filter?: Record<string, string> }) {
      vecFilter = options.filter
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

  await crossTableSearch(env, runAIWithTimeout, {
    query: 'short query',
    userId: 'user-1',
    kind: 'short',
    topK: 5,
  })

  // 向量过滤必须带 kind
  assert.equal(vecFilter?.kind, 'short')
  // memories_fts 带 kind 条件，learnings/dailies FTS 跳过
  assert.ok(ftsSql.some((sql) => sql.includes('memories_fts') && sql.includes('AND kind = ?')))
  assert.ok(!ftsSql.some((sql) => sql.includes('learnings_fts')))
  assert.ok(!ftsSql.some((sql) => sql.includes('dailies_fts')))
})

// ─── 元数据保留 ─────────────────────────────────────────────

test('crossTableSearch 保留 tags/project_id 元数据', async () => {
  const learningRecord = {
    id: 'learn-1',
    text: '使用 pnpm workspace 管理 monorepo',
    created_at: 1_777_000_000_000,
    kind: 'long',
    tags: '["架构"]',
    project_id: 'owner/repo',
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes('_fts')) return { results: [] as T[] }
              if (sql.includes('FROM learnings WHERE id IN')) {
                return { results: [learningRecord] as T[] }
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
          { id: learningRecord.id, score: 0.88, metadata: { source_table: 'learnings' } },
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
    query: 'monorepo',
    userId: 'user-1',
    topK: 5,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].tags, '["架构"]')
  assert.equal(results[0].project_id, 'owner/repo')
})
