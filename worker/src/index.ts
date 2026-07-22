import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import { MemoryMCP } from './mcp/agent'
import { consolidateMemories, cleanupExpiredMemories } from './cron/consolidate'
import { replaceMemoryIndex } from './search/indexing'
import { searchMemoriesByKeyword } from './search/keyword-search'
import { answerQuestion } from './search/hybrid'
import { runAIWithTimeout } from './utils/ai'
import { withRetry } from './utils/retry'
import { createMemory, listMemories, searchMemories, promoteMemory, deleteMemory } from './services/memory-service'
import type { MiddlewareHandler } from 'hono'
import type { Env, Variables } from './types'
import { DEFAULT_LIMIT, MAX_LIMIT, CRON_SCHEDULE } from './types'

// Input validation schemas
const memorySchema = z.object({
  text: z.string().min(1).max(10000),
  tags: z.array(z.string()).optional(),
  kind: z.enum(['short', 'long']).optional(),
})

const semanticSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  topK: z.number().int().min(1).max(20).optional(),
})

const keywordSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

const askSchema = z.object({
  question: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  topK: z.number().int().min(1).max(20).optional(),
})

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use('*', cors((c) => {
  // Get allowed origins from environment variable or use defaults
  const allowedOrigins = c.env.ALLOWED_ORIGINS
    ? c.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://127.0.0.1:3000']

  // Get the origin from the request header
  const requestOrigin = c.req.header('Origin') || c.req.header('origin')

  // Check if the origin is allowed
  const isAllowed = allowedOrigins.includes(requestOrigin || '')

  return {
    origin: isAllowed ? requestOrigin : (allowedOrigins[0] || '*'),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  }
}))

// Structured logging middleware
app.use('*', async (c, next) => {
  const start = Date.now()
  const requestId = crypto.randomUUID()
  const method = c.req.method
  const path = c.req.path

  // Add request ID to context for tracking
  c.set('requestId', requestId)

  // Get user ID if available (after auth)
  const userId = c.get('userId') as string | undefined

  try {
    await next()
  } finally {
    const duration = Date.now() - start
    const status = c.res.status

    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      userId: userId || null,
      method,
      path,
      status,
      duration,
    }

    // Log as JSON
    console.log(JSON.stringify(logEntry))
  }
})

interface JWTPayload {
  sub: string
  role?: string
  iat?: number
  exp?: number
}

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 // 60 seconds
const DEFAULT_RATE_LIMIT = 100 // requests per window

async function checkRateLimit(env: Env, userId: string): Promise<boolean> {
  const limit = parseInt(env.RATE_LIMIT || String(DEFAULT_RATE_LIMIT))
  const now = Date.now()
  const windowStart = Math.floor(now / 1000 / RATE_LIMIT_WINDOW) * RATE_LIMIT_WINDOW

  try {
    // Try to increment counter using D1
    await env.DB.prepare(
      'INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1)'
    ).bind(userId, windowStart).run()

    // Get current count
    const current = await env.DB.prepare(
      'SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?'
    ).bind(userId, windowStart).first() as { count: number } | undefined

    return (current?.count || 0) <= limit
  } catch (error) {
    // If rate_limits table doesn't exist, use alternative check
    // Try to use INSERT OR REPLACE as fallback
    try {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO rate_limits (user_id, window_start, count) SELECT ?, ?, COALESCE((SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?), 0) + 1'
      ).bind(userId, windowStart, userId, windowStart).run()

      const current = await env.DB.prepare(
        'SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?'
      ).bind(userId, windowStart).first() as { count: number } | undefined

      return (current?.count || 0) <= limit
    } catch {
      // If table doesn't exist, allow the request
      console.warn('Rate limit table not available')
      return true
    }
  }
}

async function verifyJWT(token: string, env: Env): Promise<JWTPayload> {
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET)
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
    })
    return payload as JWTPayload
  } catch {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }
}

// 认证 + 限流中间件（/api/* 和 /mcp 共用）
const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Unauthorized' })
  }
  const payload = await verifyJWT(auth.slice(7), c.env)
  c.set('userId', payload.sub)
  c.set('userRole', payload.role)

  const allowed = await checkRateLimit(c.env, payload.sub)
  if (!allowed) {
    throw new HTTPException(429, { message: 'Too many requests' })
  }

  await next()
}

app.use('/api/*', authMiddleware)
app.use('/mcp', authMiddleware)

app.get('/api/memories', async (c) => {
  const userId = c.get('userId') as string
  const kind = (c.req.query('kind') || 'short') as 'short' | 'long'
  const limit = Math.min(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT)) || DEFAULT_LIMIT, MAX_LIMIT)
  const offset = parseInt(c.req.query('offset') || '0') || 0

  const results = await listMemories(c.env, userId, { kind, limit, offset })
  return c.json({ success: true, data: results })
})

app.post('/api/memories', async (c) => {
  const userId = c.get('userId') as string

  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength) > 10240) {
    throw new HTTPException(413, { message: 'Payload too large - max 10KB' })
  }

  const body = await c.req.json()
  const validation = memorySchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: `Invalid input: ${validation.error.issues.map(i => i.message).join(', ')}` })
  }

  const { text, tags, kind } = validation.data
  const result = await createMemory(c.env, userId, { text, tags, kind })
  return c.json({ success: true, data: result })
})

app.post('/api/memories/search', async (c) => {
  const userId = c.get('userId') as string

  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength) > 10240) {
    throw new HTTPException(413, { message: 'Payload too large - max 10KB' })
  }

  const body = await c.req.json()
  const validation = semanticSearchSchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: `Invalid input: ${validation.error.issues.map(i => i.message).join(', ')}` })
  }

  const { query, topK = 5, kind } = validation.data
  const memories = await searchMemories(c.env, userId, { query, kind, topK })
  return c.json({ success: true, data: memories })
})

app.post('/api/memories/search/keyword', async (c) => {
  const userId = c.get('userId') as string

  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength) > 10240) {
    throw new HTTPException(413, { message: 'Payload too large - max 10KB' })
  }

  const body = await c.req.json()
  const validation = keywordSearchSchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: `Invalid input: ${validation.error.issues.map(i => i.message).join(', ')}` })
  }

  const { query, kind, limit = 10 } = validation.data
  const memories = await searchMemoriesByKeyword(c.env, { query, userId, kind, limit })

  return c.json({ success: true, data: memories })
})

app.post('/api/ask', async (c) => {
  const userId = c.get('userId') as string

  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength) > 10240) {
    throw new HTTPException(413, { message: 'Payload too large - max 10KB' })
  }

  const body = await c.req.json()
  const validation = askSchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: `Invalid input: ${validation.error.issues.map(i => i.message).join(', ')}` })
  }

  const { question, kind, topK = 6 } = validation.data
  const response = await answerQuestion(c.env, runAIWithTimeout, {
    query: question,
    userId,
    kind,
    topK,
  })

  return c.json({ success: true, data: response })
})

app.post('/api/memories/:id/promote', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  await promoteMemory(c.env, userId, id)

  return c.json({ success: true })
})

app.delete('/api/memories/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')

  await deleteMemory(c.env, userId, id)

  return c.json({ success: true })
})

app.get('/api/stats', async (c) => {
  const userId = c.get('userId') as string
  const projectId = c.req.query('project_id')
  const stats = await getStatsRaw(c.env, userId, projectId || undefined)
  return c.json({ success: true, data: stats })
})

app.post('/mcp', async (c) => {
  const userId = c.get('userId') as string

  // Limit request body size to 10KB to prevent DoS
  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength) > 10240) {
    throw new HTTPException(413, { message: 'Payload too large - max 10KB' })
  }

  const body = await c.req.json()

  const mcp = new MemoryMCP(c.env, userId)
  const response = await mcp.handleRequest(body)

  return c.json(response)
})

// SSE endpoint temporarily disabled due to Miniflare bug
app.get('/mcp', async (c) => {
  return c.json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'SSE not available in dev mode' }
  }, 501)
})

// 返回用户记忆摘要，用于 OpenCode 插件注入 system prompt
app.get('/api/context', async (c) => {
  const userId = c.get('userId') as string
  const projectId = c.req.query('project_id') || ''
  const context = await buildContext(c.env, userId, projectId)
  return c.json({ success: true, data: context })
})

// 重新索引所有现有记忆到 Vectorize（管理员功能）
app.post('/api/admin/reindex', async (c) => {
  const userRole = c.get('userRole') as string | undefined

  if (userRole !== 'admin') {
    throw new HTTPException(403, { message: 'Forbidden: admin role required' })
  }

  let success = 0
  let failed = 0
  let skipped = 0
  let processed = 0
  const errors: string[] = []

  const { results: memories } = await c.env.DB.prepare(
    'SELECT id, user_id, kind, text, created_at FROM memories WHERE archived = 0 ORDER BY created_at DESC'
  ).all<{ id: string; user_id: string; kind: 'short' | 'long'; text: string; created_at: number }>()

  for (const memory of memories || []) {
    if (!c.env.AI || !c.env.VEC) {
      skipped++
      continue
    }

    try {
      await replaceMemoryIndex(
        { env: c.env, runAIWithTimeout, withRetry },
        memory
      )
      success++
    } catch (error) {
      failed++
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Memory ${memory.id}: ${errorMsg}`)
      console.error(`Failed to index memory ${memory.id}:`, error)
    }

    processed++
  }

  return c.json({
    success: true,
    data: {
      total: processed,
      success,
      failed,
      skipped,
      errors: errors.slice(0, 10)
    }
  })
})

app.get('/health', (c) => c.text('OK'))

// ── 导出函数（供测试和路由复用）──

/**
 * 构建注入 system prompt 的记忆上下文
 * 按 file_type 分类：MEMORY.md > IDENTITY.md > USER.md
 * @param projectId 为空字符串时查询全局记忆（不按 project 过滤）
 */
export async function buildContext(env: Env, userId: string, projectId: string): Promise<string> {
  const queries = [
    // MEMORY.md（全局 + 项目，支持项目过滤）
    env.DB.prepare(
      `SELECT text, created_at FROM memories
       WHERE user_id = ? AND file_type = 'memory' AND kind = 'long'
         AND (project_id = ? OR ? = '')
         AND archived = 0
       ORDER BY created_at DESC LIMIT 10`
    ).bind(userId, projectId, projectId).all<{ text: string; created_at: number }>(),

    // IDENTITY.md（全局，不按项目过滤）
    env.DB.prepare(
      `SELECT text, created_at FROM memories
       WHERE user_id = ? AND file_type = 'identity' AND kind = 'long'
         AND archived = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).all<{ text: string; created_at: number }>(),

    // USER.md（全局，不按项目过滤）
    env.DB.prepare(
      `SELECT text, created_at FROM memories
       WHERE user_id = ? AND file_type = 'user' AND kind = 'long'
         AND archived = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).all<{ text: string; created_at: number }>(),
  ]

  const [memoryRows, identityRows, userRows] = await Promise.all(queries)

  const fmtSection = (title: string, items: { text: string; created_at: number }[]): string => {
    if (!items || items.length === 0) return ''
    const content = items.map(r => {
      const date = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)
      return `<!-- ${date} -->\n${r.text}`
    }).join('\n\n')
    return `## ${title}\n\n${content}`
  }

  const sections = [
    fmtSection('MEMORY.md', memoryRows.results || []),
    fmtSection('IDENTITY.md', identityRows.results || []),
    fmtSection('USER.md', userRows.results || []),
  ].filter(Boolean)

  return sections.join('\n\n---\n\n')
}

/**
 * 获取记忆统计信息
 * @param projectId 可选，按 project 过滤统计
 */
export async function getStatsRaw(env: Env, userId: string, projectId?: string): Promise<{ shortCount: number; longCount: number }> {
  const projectFilter = projectId ? ' AND project_id = ?' : ''
  const bindingsBase = projectId ? [userId, projectId] : [userId]

  const [shortRow, longRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND kind = 'short' AND archived = 0${projectFilter}`
    ).bind(...bindingsBase).first<{ count: number } | undefined>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND kind = 'long' AND archived = 0${projectFilter}`
    ).bind(...bindingsBase).first<{ count: number } | undefined>(),
  ])

  return {
    shortCount: shortRow?.count ?? 0,
    longCount: longRow?.count ?? 0,
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const cron = event.cron
    if (cron === CRON_SCHEDULE) {
      ctx.waitUntil(Promise.all([
        consolidateMemories(env),
        cleanupExpiredMemories(env),
      ]))
    }
  },
}
