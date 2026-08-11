import test from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT } from 'jose'
import apiApp from '../src/index'
import type { Env } from '../src/types'

const JWT_SECRET = 'test-secret'

function makeToken(userId: string, role?: string): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .sign(new TextEncoder().encode(JWT_SECRET))
}

function createBaseEnv(): Env {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { results: [] }
              },
              async first() {
                return null
              },
              async run() {
                return { success: true }
              },
            }
          },
        }
      },
    } as unknown as Env['DB'],
    VEC: {
      async query() {
        return { matches: [] }
      },
      async upsert() {},
      async describe() {
        return {}
      },
      async insert() {},
      async deleteByIds() {},
      async getByIds() {
        return { results: [] }
      },
    } as unknown as Env['VEC'],
    AI: {
      async run() {
        return { data: [[]] }
      },
    } as unknown as Env['AI'],
    JWT_SECRET,
  }
}

function createAppFetch(env: Env) {
  return async (req: Request) => apiApp.fetch(req, env)
}

test('未捕获异常返回 500 + JSON error message', async () => {
  const env = createBaseEnv()
  // VEC.query 抛错模拟上游服务故障
  env.VEC.query = async () => {
    throw new Error('Vectorize topK exceeds limit')
  }

  const fetch = createAppFetch(env)
  const res = await fetch(
    new Request('https://test.local/api/memories/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await makeToken('user-1')}`,
      },
      body: JSON.stringify({ query: 'hello', topK: 5 }),
    }),
  )

  assert.equal(res.status, 500)
  const body = (await res.json()) as { success: boolean; error: string }
  assert.equal(body.success, false)
  assert.equal(body.error, 'Vectorize topK exceeds limit')
})

test('未匹配路由返回 404 + JSON error message', async () => {
  const fetch = createAppFetch(createBaseEnv())
  const res = await fetch(
    new Request('https://test.local/api/nonexistent', {
      headers: { Authorization: `Bearer ${await makeToken('user-1')}` },
    }),
  )

  assert.equal(res.status, 404)
  const body = (await res.json()) as { success: boolean; error: string }
  assert.equal(body.success, false)
  assert.ok(body.error.includes('Not found'))
})

test('HTTPException 保留状态码并返回 message', async () => {
  const fetch = createAppFetch(createBaseEnv())
  const res = await fetch(
    new Request('https://test.local/api/memories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await makeToken('user-1')}`,
      },
      // 缺少 text 字段触发 zod 校验 400
      body: JSON.stringify({ kind: 'long' }),
    }),
  )

  assert.equal(res.status, 400)
  const body = (await res.json()) as { success: boolean; error: string }
  assert.equal(body.success, false)
  assert.ok(body.error.length > 0)
})

test('未认证请求返回 401 + JSON error message', async () => {
  const fetch = createAppFetch(createBaseEnv())
  const res = await fetch(
    new Request('https://test.local/api/memories', {
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  assert.equal(res.status, 401)
  const body = (await res.json()) as { success: boolean; error: string }
  assert.equal(body.success, false)
  assert.ok(body.error.length > 0)
})
