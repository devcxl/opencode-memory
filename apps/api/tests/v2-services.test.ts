import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSubtype, createMemory } from '../src/services/memory-service'
import { runDailyDigest } from '../src/services/digest-service'
import { handleMcpPost } from '../src/mcp/server'
import { generateApiToken, hashToken } from '../src/auth/tokens'
import { userYesterday } from '../src/utils/tz'
import type { Env, MemoryRecord } from '../src/types'
import { makeRecord, createMockEnv } from './helpers'

// ── subtype 校验 ──

test('subtype 校验：fact/instruction 合法细分放行，非法组合拒绝', () => {
  assert.equal(validateSubtype('fact', 'preference'), 'preference')
  assert.equal(validateSubtype('instruction', 'rule'), 'rule')
  assert.equal(validateSubtype('daily', ''), '')
  assert.throws(() => validateSubtype('fact', 'rule'))
  assert.throws(() => validateSubtype('daily', 'preference'))
})

// ── API Token ──

test('API Token：格式固定且哈希稳定', async () => {
  const token = generateApiToken()
  assert.ok(token.startsWith('opm_'))
  assert.ok(token.length > 40)
  assert.equal(await hashToken(token), await hashToken(token))
  assert.notEqual(await hashToken(token), await hashToken(generateApiToken()))
})

// ── 时区 ──

test('东八区昨天计算：跨时区日期边界', () => {
  // 2026-09-02T16:10Z = 北京时间 09-03 00:10，昨天 = 09-02
  const ts = Date.UTC(2026, 8, 2, 16, 10)
  assert.equal(userYesterday(8, ts), '2026-09-02')
  // 2026-09-02T12:00Z = 北京时间 09-02 20:00，昨天 = 09-01
  const ts2 = Date.UTC(2026, 8, 2, 12, 0)
  assert.equal(userYesterday(8, ts2), '2026-09-01')
})

// ── MCP JSON-RPC 分发 ──

test('MCP：initialize 与 tools/list 正常返回', async () => {
  const env = createMockEnv({})
  const init = await handleMcpPost(env, undefined, 'u-1', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  })
  assert.equal(init.status, 200)
  const result = init.body?.result as { serverInfo: { name: string }; capabilities: { tools: object } }
  assert.equal(result.serverInfo.name, 'cabbage-memory')

  const list = await handleMcpPost(env, undefined, 'u-1', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (list.body?.result as { tools: Array<{ name: string }> }).tools
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['memory_add', 'memory_context', 'memory_delete', 'memory_get', 'memory_search', 'memory_update', 'memory_digest_status'].sort(),
  )
})

test('MCP：通知请求返回 202，未知方法返回 -32601', async () => {
  const env = createMockEnv({})
  const notify = await handleMcpPost(env, undefined, 'u-1', { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notify.status, 202)
  assert.equal(notify.body, undefined)

  const unknown = await handleMcpPost(env, undefined, 'u-1', { jsonrpc: '2.0', id: 3, method: 'bogus/method' })
  assert.equal(unknown.body?.error?.code, -32601)
})

// ── digest 幂等占位 ──

/** 可变存储 mock：覆盖 digest 依赖的 SQL 语句 */
function createDigestEnv(existing: MemoryRecord[]) {
  const rows = [...existing]
  const digestKeys = new Set<string>()
  const llmCalls: unknown[] = []

  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind(...args: unknown[]) {
            return {
              all: async <T>() => ({ results: query(sql, args) as T[] }),
              first: async <T>() => (query(sql, args) as T[])[0] ?? null,
              run: async () => exec(sql, args),
            }
          },
          all: async <T>() => ({ results: query(sql, []) as T[] }),
          first: async <T>() => (query(sql, []) as T[])[0] ?? null,
          run: async () => exec(sql, []),
        }
        return stmt
      },
    } as unknown as Env['DB'],
    VEC: { async upsert() {}, async deleteByIds() {} } as unknown as Env['VEC'],
    AI: {
      async run(_model: string, input: { messages?: unknown[] }) {
        if (Array.isArray(input.messages)) {
          llmCalls.push(input)
          return { response: JSON.stringify({ title: '9月1日工作总结', content: '完成华东区销售额统计。', tags: ['销售'], entities: [{ key: 'region', value: '华东' }] }) }
        }
        return { data: [[0.1]] }
      },
    } as unknown as Env['AI'],
    JWT_SECRET: 'test',
    TZ_OFFSET_HOURS: '8',
  } as Env

  function query(sql: string, args: unknown[]): unknown[] {
    // digestOneGroup 的单组 daily 查询（带 project_id 过滤）
    if (sql.includes("type = 'daily'") && sql.includes('project_id = ?')) {
      const [userId, projectId, date] = args as string[]
      return rows.filter(
        (r) => r.type === 'daily' && r.user_id === userId && r.project_id === projectId && r.date === date && !r.digested_at && r.archived === 0,
      )
    }
    // runDailyDigest 的分组查询（GROUP BY user_id, project_id）
    if (sql.includes("type = 'daily'") && sql.includes('GROUP BY user_id')) {
      const date = args[0] as string
      return rows.filter((r) => r.type === 'daily' && r.date === date && !r.digested_at && r.archived === 0)
    }
    if (sql.includes("type = 'digest'") && sql.includes('SELECT id FROM memories')) {
      const [userId, projectId, date] = args as string[]
      return rows.filter((r) => r.type === 'digest' && r.user_id === userId && r.project_id === projectId && r.date === date && r.archived === 0)
    }
    if (sql.includes('FROM memory_entities')) return []
    return []
  }

  function exec(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql.includes('INSERT OR IGNORE INTO memories')) {
      const [id, userId, , scope, projectId, date] = args as string[]
      const key = `${userId}|${projectId}|${date}`
      if (digestKeys.has(key)) return { meta: { changes: 0 } }
      digestKeys.add(key)
      rows.push(makeRecord({ id, user_id: userId, type: 'digest', title: '__digest_pending__', content: '', scope: scope as 'global', project_id: projectId, date }))
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE memories SET title')) {
      const [title, content, , tags, sourceIds, , id] = args as unknown[]
      const row = rows.find((r) => r.id === id)
      if (row) {
        row.title = title as string
        row.content = content as string
        row.tags = tags as string
        row.source_ids = sourceIds as string
      }
      return { meta: { changes: row ? 1 : 0 } }
    }
    if (sql.includes('SET digested_at')) {
      const [now, ...ids] = args as unknown[]
      let changes = 0
      for (const row of rows) {
        if ((ids as string[]).includes(row.id)) {
          row.digested_at = now as number
          changes++
        }
      }
      return { meta: { changes } }
    }
    if (sql.includes('INSERT OR IGNORE INTO memory_entities')) {
      // 记录实体写入（仅计数）
      return { meta: { changes: 1 } }
    }
    return { meta: { changes: 0 } }
  }

  return { env, rows, llmCalls }
}

test('digest：成功生成单条事实并标记 daily 已消费', async () => {
  const daily = makeRecord({
    id: 'd-1',
    type: 'daily',
    subtype: '',
    title: '',
    content: '修复了登录 bug',
    date: '2026-09-01',
  })
  const { env, rows } = createDigestEnv([daily])

  const result = await runDailyDigest(env)
  assert.equal(result.processed, 1)

  const digest = rows.find((r) => r.type === 'digest')
  assert.ok(digest)
  assert.equal(digest!.content, '完成华东区销售额统计。')
  assert.notEqual(digest!.content, '__digest_pending__')
  assert.equal(daily.digested_at !== null, true)
})

test('digest：重复执行不会产生第二条 digest（幂等占位）', async () => {
  const daily = makeRecord({
    id: 'd-1',
    type: 'daily',
    subtype: '',
    title: '',
    content: '修复了登录 bug',
    date: '2026-09-01',
  })
  const { env, rows } = createDigestEnv([daily])

  await runDailyDigest(env)
  const countAfterFirst = rows.filter((r) => r.type === 'digest').length
  assert.equal(countAfterFirst, 1)

  // daily 已消费 → 第二次运行无待处理数据
  const result = await runDailyDigest(env)
  assert.equal(result.processed, 0)
  assert.equal(rows.filter((r) => r.type === 'digest').length, 1)
})

test('digest：无 daily 时直接返回，不写 job 失败', async () => {
  const { env } = createDigestEnv([])
  const result = await runDailyDigest(env)
  assert.equal(result.processed, 0)
  assert.equal(result.failed, 0)
})

// createMemory 冒烟：mock DB + 无 AI 时不抛错
test('createMemory：AI 未配置时仍完成 D1 写入', async () => {
  const inserts: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            inserts.push({ sql, args })
            return {
              async run() {
                return { meta: { changes: 1 } }
              },
              async all<T>() {
                return { results: [] as T[] }
              },
              async first<T>() {
                return null as T
              },
            }
          },
        }
      },
    } as unknown as Env['DB'],
    VEC: undefined,
    AI: undefined,
    JWT_SECRET: 'test',
    TZ_OFFSET_HOURS: '8',
  } as unknown as Env

  const result = await createMemory(env, 'u-1', { type: 'daily', content: '今天写了新表结构' })
  assert.ok(result.id)
  assert.equal(inserts.length, 1)
  assert.ok(inserts[0].sql.includes('INSERT INTO memories'))
})
