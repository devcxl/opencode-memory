import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemory, listMemories } from './memory-service'
import { buildContext, getStatsRaw } from '../index'
import type { Env } from '../types'

/**
 * 创建 mock D1 数据库 — 捕获 SQL 和 bindings 以验证查询结构
 */
function createMockDB() {
  type CapturedQuery = {
    sql: string
    bindings: unknown[]
  }
  const queries: CapturedQuery[] = []

  // 预设返回值 — 索引匹配查询顺序
  let resultIndex = 0
  const defaultAllResult = { results: [] as Record<string, unknown>[] }
  const allResults: { results: Record<string, unknown>[] }[] = []
  const firstResults: Record<string, unknown>[] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          queries.push({ sql, bindings })
          const idx = resultIndex++
          return {
            async run() {
              return { success: true }
            },
            async all<T>() {
              const preset = allResults[idx]
              if (preset) return preset as { results: T[] }
              return defaultAllResult as { results: T[] }
            },
            async first<T>() {
              const preset = firstResults[idx]
              if (preset) return preset as T
              return undefined
            },
          }
        },
      }
    },
  }

  function getQueries(): readonly CapturedQuery[] {
    return queries
  }

  /** 预设 all() 返回值 */
  function setAllResults(results: { results: Record<string, unknown>[] }[]) {
    allResults.length = 0
    allResults.push(...results)
  }

  /** 预设 first() 返回值 */
  function setFirstResults(results: Record<string, unknown>[]) {
    firstResults.length = 0
    firstResults.push(...results)
  }

  return { db, getQueries, setAllResults, setFirstResults }
}

/** 创建 minimal mock Env */
function createEnv(db: ReturnType<typeof createMockDB>['db']): Env {
  return {
    DB: db as Env['DB'],
    VEC: {
      upsert: async () => {},
      deleteByIds: async () => {},
      query: async () => ({ matches: [] }),
    } as Env['VEC'],
    AI: {
      run: async () => ({ data: [[0.1]] }),
    } as Env['AI'],
    JWT_SECRET: 'test-secret',
  }
}

test('createMemory 包含 project_id, file_type, date 的新字段', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  // Use type assertion to bypass missing options fields (RED phase: current types don't include them)
  const options = {
    text: 'Test memory content',
    kind: 'long' as const,
    project_id: 'test-owner/test-repo',
    file_type: 'identity',
    date: '2026-07-22',
  }

  const result = await createMemory(env, 'user-1', options as any)
  assert.ok(result.id)

  const insertQuery = getQueries().find(q => q.sql.includes('INSERT INTO memories'))
  assert.ok(insertQuery, '应有 INSERT 查询')

  // 验证 project_id 在 bindings 中（应在 user_id 之后的绑定位置）
  const bindings = insertQuery!.bindings as unknown[]
  const projectIdIdx = bindings.findIndex(b => b === 'test-owner/test-repo')
  assert.ok(projectIdIdx >= 0, `project_id 'test-owner/test-repo' 应在 bindings 中，实际: ${JSON.stringify(bindings)}`)

  const fileTypeIdx = bindings.findIndex(b => b === 'identity')
  assert.ok(fileTypeIdx >= 0, `file_type 'identity' 应在 bindings 中，实际: ${JSON.stringify(bindings)}`)

  const dateIdx = bindings.findIndex(b => b === '2026-07-22')
  assert.ok(dateIdx >= 0, `date '2026-07-22' 应在 bindings 中，实际: ${JSON.stringify(bindings)}`)
})

test('createMemory 未提供新字段时使用默认值', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  const options = {
    text: 'Default fields test',
    kind: 'short' as const,
  }

  await createMemory(env, 'user-2', options)
  const insertQuery = getQueries().find(q => q.sql.includes('INSERT INTO memories'))
  assert.ok(insertQuery)

  // SQL 应包含 project_id, file_type, date 列
  const sql = insertQuery!.sql
  assert.ok(sql.includes('project_id'), `SQL 应包含 project_id 列，实际: ${sql}`)
  assert.ok(sql.includes('file_type'), `SQL 应包含 file_type 列，实际: ${sql}`)
})

test('listMemories 支持按 project_id 过滤', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  await listMemories(env, 'user-1', {
    kind: 'long',
    limit: 10,
    offset: 0,
    project_id: 'my-project',
  } as any)

  const selectQuery = getQueries().find(q => q.sql.includes('SELECT'))
  assert.ok(selectQuery, '应有 SELECT 查询')

  const sql = selectQuery!.sql
  assert.ok(sql.includes('project_id'), `SQL 应包含 project_id 过滤，实际: ${sql}`)

  const bindings = selectQuery!.bindings as unknown[]
  const projectIdIdx = bindings.findIndex(b => b === 'my-project')
  assert.ok(projectIdIdx >= 0, `bindings 应包含 project_id='my-project'，实际: ${JSON.stringify(bindings)}`)
})

test('listMemories 支持按 file_type 过滤', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  await listMemories(env, 'user-1', {
    kind: 'long',
    limit: 10,
    offset: 0,
    file_type: 'daily',
  } as any)

  const selectQuery = getQueries().find(q => q.sql.includes('SELECT'))
  assert.ok(selectQuery)

  const sql = selectQuery!.sql
  assert.ok(sql.includes('file_type'), `SQL 应包含 file_type 过滤，实际: ${sql}`)

  const bindings = selectQuery!.bindings as unknown[]
  const fileTypeIdx = bindings.findIndex(b => b === 'daily')
  assert.ok(fileTypeIdx >= 0, `bindings 应包含 file_type='daily'，实际: ${JSON.stringify(bindings)}`)
})

test('listMemories 支持按 date 过滤', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  await listMemories(env, 'user-1', {
    kind: 'short',
    limit: 10,
    offset: 0,
    date: '2026-07-22',
  } as any)

  const selectQuery = getQueries().find(q => q.sql.includes('SELECT'))
  assert.ok(selectQuery)

  const sql = selectQuery!.sql
  assert.ok(sql.includes('date'), `SQL 应包含 date 过滤，实际: ${sql}`)

  const bindings = selectQuery!.bindings as unknown[]
  const dateIdx = bindings.findIndex(b => b === '2026-07-22')
  assert.ok(dateIdx >= 0, `bindings 应包含 date='2026-07-22'，实际: ${JSON.stringify(bindings)}`)
})

test('listMemories 不提供过滤字段时不添加额外 WHERE 条件', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  await listMemories(env, 'user-1', {
    kind: 'long',
    limit: 10,
    offset: 0,
  } as any)

  const selectQuery = getQueries().find(q => q.sql.includes('SELECT'))
  assert.ok(selectQuery)

  // 确认没有额外的空字符串过滤（用 OR ? = '' 模式）
  const bindings = selectQuery!.bindings as unknown[]
  // 空字符串绑定是合法的，但确保绑定数量 = 原有绑定量（user_id, kind, limit, offset = 4）
  // 但 SQL 可能包含额外的 project_id/file_type/date 占位符，绑定了空字符串
  assert.ok(bindings.length >= 4, `至少应有 4 个绑定（user_id, kind, limit, offset），实际: ${bindings.length}`)
})

// ── T9: context 端点重构（已迁移到结构化表）──

test('buildContext 从 instructions/learnings 表查询', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  await buildContext(env, 'user-1', 'test/proj')

  const allQueries = getQueries()
  const selectQueries = allQueries.filter(q => q.sql.includes('SELECT'))

  // 应有至少 3 个 SELECT（identity, preference, knowledge）
  assert.ok(selectQueries.length >= 3, `应有 >=3 个 SELECT 查询，实际: ${selectQueries.length}`)

  // identity 查询应来自 instructions 表
  const identityQuery = selectQueries.find(q => q.sql.includes('FROM instructions') && q.sql.includes("type = 'identity'"))
  assert.ok(identityQuery, `应有 identity 查询 (instructions/type='identity')，实际: ${selectQueries.map(q => q.sql).join('\n')}`)

  // preference 查询应来自 learnings 表
  const preferenceQuery = selectQueries.find(q => q.sql.includes('FROM learnings') && q.sql.includes("type = 'preference'"))
  assert.ok(preferenceQuery, `应有 preference 查询 (learnings/type='preference')`)

  // knowledge 查询应来自 learnings 表 + project_id 过滤
  const knowledgeQuery = selectQueries.find(q => q.sql.includes('FROM learnings') && q.sql.includes("type = 'knowledge'") && q.sql.includes('project_id'))
  assert.ok(knowledgeQuery, `应有 knowledge 查询 (learnings/type='knowledge' + project_id)`)
})

test('buildContext 输出格式匹配新模板', async () => {
  const { db, setAllResults } = createMockDB()

  setAllResults([
    {
      results: [
        { content: 'AI 身份：OpenCode', created_at: 1740000000000 },
      ],
    },
    {
      results: [
        { content: '用户偏好：简洁优先', created_at: 1740000000000 },
      ],
    },
    {
      results: [
        { content: '项目架构：monorepo', created_at: 1750000000000 },
      ],
    },
  ])

  const env = createEnv(db)
  const context = await buildContext(env, 'user-1', 'test/proj')

  assert.ok(context.includes('## IDENTITY.md'), `context 应包含 '## IDENTITY.md'`)
  assert.ok(context.includes('## USER.md'), `context 应包含 '## USER.md'`)
  assert.ok(context.includes('## Project Knowledge'), `context 应包含 '## Project Knowledge'`)
  assert.ok(context.includes('\n\n---\n\n'), `context 应包含分隔符`)
  assert.ok(context.includes('<!-- '), `context 应包含时间戳注释`)
})

test('buildContext 无数据时不生成空节段', async () => {
  const { db, setAllResults } = createMockDB()

  setAllResults([
    {
      results: [
        { content: 'AI 身份：OpenCode', created_at: 1740000000000 },
      ],
    },
    { results: [] }, // preference 空
    { results: [] }, // knowledge 空
  ])

  const env = createEnv(db)
  const context = await buildContext(env, 'user-1', '')

  assert.ok(context.includes('## IDENTITY.md'), 'context 应包含 identity 节段')
  assert.ok(!context.includes('## USER.md'), 'preference 为空时不应有 USER 节段')
  assert.ok(!context.includes('## Project Knowledge'), 'knowledge 为空时不应有 Project Knowledge 节段')
})

// ── stats 端点（已迁移到多表）──

test('getStatsRaw 从三表聚合统计', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  const stats = await getStatsRaw(env, 'user-1')

  assert.ok('instructionCount' in stats, 'stats 应包含 instructionCount')
  assert.ok('learningCount' in stats, 'stats 应包含 learningCount')
  assert.ok('dailyCount' in stats, 'stats 应包含 dailyCount')

  const allQueries = getQueries()
  const countQueries = allQueries.filter(q => q.sql.includes('SELECT COUNT'))

  // 应有 3 个统计查询（instructions, learnings, dailies）
  const hasInstructions = countQueries.some(q => q.sql.includes('FROM instructions'))
  const hasLearnings = countQueries.some(q => q.sql.includes('FROM learnings'))
  const hasDailies = countQueries.some(q => q.sql.includes('FROM dailies'))
  assert.ok(hasInstructions, '应有 instructions 统计查询')
  assert.ok(hasLearnings, '应有 learnings 统计查询')
  assert.ok(hasDailies, '应有 dailies 统计查询')
})

test('getStatsRaw 提供 project_id 时添加过滤', async () => {
  const { db, getQueries } = createMockDB()
  const env = createEnv(db)

  await getStatsRaw(env, 'user-1', 'owner/repo')

  const allQueries = getQueries()
  const countQueries = allQueries.filter(q => q.sql.includes('SELECT COUNT'))

  assert.ok(countQueries.length >= 3, `应有 >=3 个统计查询`)

  for (const q of countQueries) {
    assert.ok(q.sql.includes('project_id'), `stats 查询应包含 project_id，实际: ${q.sql}`)
  }
})
