import test from 'node:test'
import assert from 'node:assert/strict'
import { triggerExtraction, getExtractionStatus } from '../src/services/extraction-service'
import type { Env, Daily, ExtractionLog } from '../src/types'

function createMockDB() {
  type CapturedQuery = { sql: string; bindings: unknown[] }
  const queries: CapturedQuery[] = []
  const allResults: { results: Record<string, unknown>[] }[] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          queries.push({ sql, bindings })
          const idx = queries.length - 1
          return {
            async run() { return { success: true } },
            async all<T>() {
              const preset = allResults[idx]
              return preset ? preset as { results: T[] } : { results: [] as T[] }
            },
            async first<T>() {
              const preset = allResults[idx]
              return preset ? preset.results[0] as T : undefined
            },
          }
        },
      }
    },
  }

  function setAllResults(results: { results: Record<string, unknown>[] }[]) {
    allResults.length = 0
    allResults.push(...results)
  }

  return { db, getQueries: () => queries, setAllResults }
}

function createEnv(db: ReturnType<typeof createMockDB>['db']): Env {
  return {
    DB: db as Env['DB'],
    VEC: { upsert: async () => {}, deleteByIds: async () => {}, query: async () => ({ matches: [] }) } as unknown as Env['VEC'],
    AI: {
      run: async () => ({ response: JSON.stringify([{ id: 'd1', action: 'extract', type: 'episodic', title: 'Bug修复', content: '修复了JSON解析问题', confidence: 0.8 }]) }),
    } as Env['AI'],
    JWT_SECRET: 'test',
  }
}

test('triggerExtraction 无 dailies 时返回空统计', async () => {
  const { db, setAllResults } = createMockDB()
  const env = createEnv(db)

  // 预设：无未提取的 dailies
  setAllResults([
    { results: [] }, // extraction_log INSERT
    { results: [] }, // getUnextractedDailies
  ])

  const result = await triggerExtraction(env, 'user-1', '2026-07-26')
  assert.equal(result.daily_count, 0)
  assert.equal(result.extracted_count, 0)
  assert.equal(result.status, 'completed')
})

test('triggerExtraction 有 dailies 时触发 LLM 提取', async () => {
  const { db, setAllResults } = createMockDB()
  const env = createEnv(db)

  // 预设返回值顺序：
  // 0: extraction_log INSERT
  // 1: getUnextractedDailies — 返回 1 条 daily
  // 2: createLearning (extracted) → id
  // 3: markExtracted (UPDATE)
  // 4: extraction_log UPDATE
  const daily: Daily = {
    id: 'd1', user_id: 'user-1', content: '修复了 JSON 解析 bug', content_fts: '',
    project_id: 'owner/repo', date: '2026-07-25', extracted: 0, extracted_at: null,
    tags: '[]', created_at: 1, archived: 0,
  }

  setAllResults([
    { results: [] },                        // INSERT extraction_log
    { results: [daily as unknown as Record<string, unknown>] },                   // getUnextractedDailies
    { results: [] },                        // upsertProjectStats (from createLearning)
    { results: [] },                        // CREATE learning INSERT
    { results: [] },                        // upsertProjectStats (learning)
    { results: [] },                        // markExtracted UPDATE
    { results: [] },                        // UPDATE extraction_log
  ])

  const result = await triggerExtraction(env, 'user-1', '2026-07-26', 10)

  assert.equal(result.daily_count, 1)
  assert.equal(result.status, 'completed')
})

test('getExtractionStatus 返回最新任务', async () => {
  const { db, setAllResults } = createMockDB()
  const env = createEnv(db)

  const log: ExtractionLog = {
    id: 'log-1', user_id: 'user-1', started_at: 1, completed_at: 2,
    daily_count: 5, extracted_count: 3, status: 'completed', error: null, created_at: 1,
  }

  setAllResults([
    { results: [log as unknown as Record<string, unknown>] },
  ])

  const result = await getExtractionStatus(env, 'user-1')
  assert.ok(result)
  assert.equal(result!.status, 'completed')
  assert.equal(result!.extracted_count, 3)
})
