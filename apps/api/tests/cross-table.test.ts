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
