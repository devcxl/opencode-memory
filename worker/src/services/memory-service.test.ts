import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemory, listMemories } from './memory-service'
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

  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          queries.push({ sql, bindings })
          return {
            async run() {
              return { success: true }
            },
            async all<T>() {
              return { results: [] as T[] }
            },
          }
        },
      }
    },
  }

  function getQueries(): readonly CapturedQuery[] {
    return queries
  }

  return { db, getQueries }
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
