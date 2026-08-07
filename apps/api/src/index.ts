import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import { consolidateMemories, cleanupExpiredMemories } from './cron/consolidate'
import { upsertMemoryVector, type IndexableMemory } from './search/indexing'
import { searchMemoriesByKeyword } from './search/keyword-search'
import { answerQuestion } from './search/hybrid'
import { runAIWithTimeout } from './utils/ai'
import { withRetry } from './utils/retry'
import { createMemory, listMemories, searchMemories, promoteMemory, deleteMemory } from './services/memory-service'
import { createInstruction, listInstructions, getInstruction, deleteInstruction } from './services/instruction-service'
import { createLearning, listLearnings, getLearning, deleteLearning } from './services/learning-service'
import { createDaily, listDailies, getDaily, deleteDaily } from './services/daily-service'
import { triggerExtraction, getExtractionStatus } from './services/extraction-service'
import type { MiddlewareHandler } from 'hono'
import type { Env, Variables } from './types'
import { DEFAULT_LIMIT, MAX_LIMIT, CRON_SCHEDULE } from './types'

// Input validation schemas
const memorySchema = z.object({
  text: z.string().min(1).max(10000),
  tags: z.array(z.string()).optional(),
  kind: z.enum(['short', 'long']).optional(),
  file_type: z.enum(['memory', 'identity', 'user', 'daily']).optional(),
  project_id: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const semanticSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  topK: z.number().int().min(1).max(20).optional(),
  file_type: z.string().optional(),
  project_id: z.string().optional(),
})

const keywordSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  file_type: z.string().optional(),
  project_id: z.string().optional(),
})

const askSchema = z.object({
  question: z.string().min(1).max(1000),
  kind: z.enum(['short', 'long']).optional(),
  topK: z.number().int().min(1).max(20).optional(),
})

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use('*', cors({
  // 动态校验请求来源，仅放行 allowlist 中的 Origin
  origin: (_origin, c) => {
    const allowedOrigins = c.env.ALLOWED_ORIGINS
      ? c.env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim())
      : ['http://localhost:3000', 'http://127.0.0.1:3000']

    // 取请求头 Origin，判断是否在 allowlist 内
    const requestOrigin = c.req.header('Origin') || c.req.header('origin')
    const isAllowed = allowedOrigins.includes(requestOrigin || '')

    return isAllowed ? requestOrigin : (allowedOrigins[0] || '*')
  },
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
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

// 认证 + 限流中间件（/api/* 共用）
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

app.get('/api/memories', async (c) => {
  const userId = c.get('userId') as string
  const kind = (c.req.query('kind') || 'short') as 'short' | 'long'
  const limit = Math.min(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT)) || DEFAULT_LIMIT, MAX_LIMIT)
  const offset = parseInt(c.req.query('offset') || '0') || 0
  const project_id = c.req.query('project_id') || ''
  const file_type = c.req.query('file_type') || ''
  const date = c.req.query('date') || ''

  const results = await listMemories(c.env, userId, { kind, limit, offset, project_id, file_type, date })
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

  const { text, tags, kind, file_type, project_id, date } = validation.data
  const result = await createMemory(c.env, userId, { text, tags, kind, file_type, project_id, date })
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

  const { query, topK = 5, kind, file_type, project_id } = validation.data
  const memories = await searchMemories(c.env, userId, { query, kind, topK, file_type, project_id })
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

// ── 结构化记忆 API ──

// Zod schemas for new endpoints
const instructionSchema = z.object({
  type: z.enum(['identity', 'rule', 'workflow']),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(10000),
  scope: z.enum(['global', 'project', 'user', 'local']).optional(),
  project_id: z.string().max(200).optional(),
  path_pattern: z.string().max(500).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  tags: z.array(z.string()).optional(),
})

const learningSchema = z.object({
  type: z.enum(['preference', 'episodic', 'knowledge']),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(10000),
  scope: z.enum(['global', 'project', 'user']).optional(),
  project_id: z.string().max(200).optional(),
  source: z.enum(['manual', 'extracted', 'imported']).optional(),
  source_ids: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
})

const dailySchema = z.object({
  content: z.string().min(1).max(10000),
  project_id: z.string().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tags: z.array(z.string()).optional(),
})

// Instructions
app.post('/api/instructions', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const validation = instructionSchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: validation.error.issues.map(i => i.message).join(', ') })
  }
  const result = await createInstruction(c.env, userId, validation.data)
  return c.json({ success: true, data: result })
})

app.get('/api/instructions', async (c) => {
  const userId = c.get('userId') as string
  const type = c.req.query('type') as string | undefined
  const scope = c.req.query('scope') as string | undefined
  const project_id = c.req.query('project_id') || ''
  const limit = Math.min(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT)), MAX_LIMIT)
  const offset = parseInt(c.req.query('offset') || '0') || 0

  const results = await listInstructions(c.env, userId, {
    type: type as 'identity' | 'rule' | 'workflow' | undefined,
    scope: scope as 'global' | 'project' | 'user' | 'local' | undefined,
    project_id,
    limit,
    offset,
  })
  return c.json({ success: true, data: results })
})

app.get('/api/instructions/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const result = await getInstruction(c.env, userId, id)
  if (!result) throw new HTTPException(404, { message: 'Not found' })
  return c.json({ success: true, data: result })
})

app.delete('/api/instructions/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  await deleteInstruction(c.env, userId, id)
  return c.json({ success: true })
})

// Learnings
app.post('/api/learnings', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const validation = learningSchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: validation.error.issues.map(i => i.message).join(', ') })
  }
  const result = await createLearning(c.env, userId, validation.data)
  return c.json({ success: true, data: result })
})

app.get('/api/learnings', async (c) => {
  const userId = c.get('userId') as string
  const type = c.req.query('type') as string | undefined
  const source = c.req.query('source') as string | undefined
  const scope = c.req.query('scope') as string | undefined
  const project_id = c.req.query('project_id') || ''
  const limit = Math.min(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT)), MAX_LIMIT)
  const offset = parseInt(c.req.query('offset') || '0') || 0

  const results = await listLearnings(c.env, userId, {
    type: type as 'preference' | 'episodic' | 'knowledge' | undefined,
    source: source as 'manual' | 'extracted' | 'imported' | undefined,
    scope: scope as 'global' | 'project' | 'user' | undefined,
    project_id,
    limit,
    offset,
  })
  return c.json({ success: true, data: results })
})

app.get('/api/learnings/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const result = await getLearning(c.env, userId, id)
  if (!result) throw new HTTPException(404, { message: 'Not found' })
  return c.json({ success: true, data: result })
})

app.delete('/api/learnings/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  await deleteLearning(c.env, userId, id)
  return c.json({ success: true })
})

// Dailies
app.post('/api/dailies', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json()
  const validation = dailySchema.safeParse(body)
  if (!validation.success) {
    throw new HTTPException(400, { message: validation.error.issues.map(i => i.message).join(', ') })
  }
  const result = await createDaily(c.env, userId, validation.data)
  return c.json({ success: true, data: result })
})

app.get('/api/dailies', async (c) => {
  const userId = c.get('userId') as string
  const project_id = c.req.query('project_id') || ''
  const date = c.req.query('date') || ''
  const limit = Math.min(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT)), MAX_LIMIT)
  const offset = parseInt(c.req.query('offset') || '0') || 0

  const results = await listDailies(c.env, userId, { project_id, date, limit, offset })
  return c.json({ success: true, data: results })
})

app.delete('/api/dailies/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  await deleteDaily(c.env, userId, id)
  return c.json({ success: true })
})

// ── 提取端点 ──

app.post('/api/extract', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => ({}))
  const beforeDate = body.date || new Date().toISOString().slice(0, 10)

  const result = await triggerExtraction(c.env, userId, beforeDate)
  return c.json({ success: true, data: result })
})

app.get('/api/extract/status', async (c) => {
  const userId = c.get('userId') as string
  const result = await getExtractionStatus(c.env, userId)
  return c.json({ success: true, data: result })
})

app.get('/api/stats', async (c) => {
  const userId = c.get('userId') as string
  const projectId = c.req.query('project_id')
  const stats = await getStatsRaw(c.env, userId, projectId || undefined)
  return c.json({ success: true, data: stats })
})

// 重新索引所有现有记忆到 Vectorize（管理员功能）
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

  if (!c.env.AI || !c.env.VEC) {
    return c.json({
      success: true,
      data: { total: 0, success: 0, failed: 0, skipped: 0, errors: ['AI/VEC not configured'] }
    })
  }

  const indexOne = async (label: string, item: IndexableMemory) => {
    try {
      await upsertMemoryVector({ env: c.env, runAIWithTimeout, withRetry }, item)
      success++
    } catch (error) {
      failed++
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`${label} ${item.id}: ${errorMsg}`)
      console.error(`Failed to index ${label} ${item.id}:`, error)
    }
    processed++
  }

  // 旧 memories 表（short/long）
  const { results: memories } = await c.env.DB.prepare(
    'SELECT id, user_id, kind, text, created_at, project_id, file_type, date FROM memories WHERE archived = 0 ORDER BY created_at DESC'
  ).all<{ id: string; user_id: string; kind: 'short' | 'long'; text: string; created_at: number; project_id: string; file_type: string; date: string | null }>()

  for (const memory of memories || []) {
    await indexOne('Memory', memory)
  }

  // 结构化表：learnings
  const { results: learnings } = await c.env.DB.prepare(
    'SELECT id, user_id, title, content, scope, project_id, created_at FROM learnings WHERE archived = 0 ORDER BY created_at DESC'
  ).all<{ id: string; user_id: string; title: string; content: string; scope: string; project_id: string; created_at: number }>()

  for (const l of learnings || []) {
    await indexOne('Learning', {
      id: l.id,
      user_id: l.user_id,
      kind: 'long',
      text: `${l.title}\n${l.content}`,
      created_at: l.created_at,
      project_id: l.project_id,
      file_type: l.scope || 'learning',
      source_table: 'learnings',
    })
  }

  // 结构化表：instructions
  const { results: instructions } = await c.env.DB.prepare(
    'SELECT id, user_id, title, content, scope, project_id, created_at FROM instructions WHERE archived = 0 ORDER BY created_at DESC'
  ).all<{ id: string; user_id: string; title: string; content: string; scope: string; project_id: string; created_at: number }>()

  for (const it of instructions || []) {
    await indexOne('Instruction', {
      id: it.id,
      user_id: it.user_id,
      kind: 'long',
      text: `${it.title}\n${it.content}`,
      created_at: it.created_at,
      project_id: it.project_id,
      file_type: it.scope || 'instruction',
      source_table: 'instructions',
    })
  }

  // 结构化表：dailies
  const { results: dailies } = await c.env.DB.prepare(
    'SELECT id, user_id, content, project_id, date, created_at FROM dailies WHERE archived = 0 ORDER BY created_at DESC'
  ).all<{ id: string; user_id: string; content: string; project_id: string; date: string; created_at: number }>()

  for (const d of dailies || []) {
    await indexOne('Daily', {
      id: d.id,
      user_id: d.user_id,
      kind: 'long',
      text: d.content,
      created_at: d.created_at,
      project_id: d.project_id,
      file_type: d.date || 'daily',
      source_table: 'dailies',
    })
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

export async function buildContext(env: Env, userId: string, projectId: string): Promise<string> {
  const queries = [
    env.DB.prepare(
      `SELECT title, content, created_at FROM instructions WHERE user_id = ? AND type = 'identity' AND archived = 0 ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).all<{ title: string; content: string; created_at: number }>(),

    env.DB.prepare(
      `SELECT title, content, created_at FROM learnings WHERE user_id = ? AND type = 'preference' AND archived = 0 ORDER BY created_at DESC LIMIT 1`
    ).bind(userId).all<{ title: string; content: string; created_at: number }>(),

    env.DB.prepare(
      `SELECT title, content, created_at FROM learnings WHERE user_id = ? AND type = 'knowledge' AND archived = 0 AND (project_id = ? OR ? = '') ORDER BY created_at DESC LIMIT 10`
    ).bind(userId, projectId, projectId).all<{ title: string; content: string; created_at: number }>(),
  ]

  const [identityRows, preferenceRows, knowledgeRows] = await Promise.all(queries)

  const fmt = (title: string, items: { title?: string; content: string; created_at: number }[]): string => {
    if (!items || items.length === 0) return ''
    const content = items.map(r => {
      const date = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)
      return `<!-- ${date} -->\n${r.content}`
    }).join('\n\n')
    return `## ${title}\n\n${content}`
  }

  const sections = [
    fmt('IDENTITY.md', identityRows.results || []),
    fmt('USER.md', preferenceRows.results || []),
    fmt('Project Knowledge', knowledgeRows.results || []),
  ].filter(Boolean)

  return sections.join('\n\n---\n\n')
}

export async function getStatsRaw(env: Env, userId: string, projectId?: string): Promise<{
  instructionCount: number; learningCount: number; dailyCount: number
}> {
  const projectFilter = projectId ? ' AND project_id = ?' : ''
  const bindings = projectId ? [userId, projectId] : [userId]

  const [instRow, learnRow, dailyRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as count FROM instructions WHERE user_id = ? AND archived = 0${projectFilter}`).bind(...bindings).first<{ count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM learnings WHERE user_id = ? AND archived = 0${projectFilter}`).bind(...bindings).first<{ count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM dailies WHERE user_id = ? AND archived = 0${projectFilter}`).bind(...bindings).first<{ count: number }>(),
  ])

  return {
    instructionCount: instRow?.count ?? 0,
    learningCount: learnRow?.count ?? 0,
    dailyCount: dailyRow?.count ?? 0,
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
