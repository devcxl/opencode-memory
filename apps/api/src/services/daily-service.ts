import type { Env, Daily } from '../types'
import { deleteMemoryIndex, upsertMemoryVector, type IndexableMemory } from '../search/indexing'
import { segmentForIndex } from '../search/tokenizer'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'

const SOURCE_TABLE = 'dailies'

export interface CreateDailyOptions {
  content: string
  project_id?: string
  date?: string
  tags?: string[]
}

export interface ListDailyOptions {
  project_id?: string
  date?: string
  limit?: number
  offset?: number
}

export async function createDaily(
  env: Env,
  userId: string,
  options: CreateDailyOptions,
): Promise<{ id: string }> {
  const { content, project_id = '', date = '', tags = [] } = options

  const id = crypto.randomUUID()
  const now = Date.now()
  const contentFts = segmentForIndex(content)
  const dateStr = date || new Date().toISOString().slice(0, 10)

  await env.DB.prepare(
    `INSERT INTO dailies (id, user_id, content, content_fts, project_id, date, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, content, contentFts, project_id, dateStr, JSON.stringify(tags), now)
    .run()

  try {
    const indexable: IndexableMemory = {
      id,
      user_id: userId,
      kind: 'long',
      text: content,
      created_at: now,
      project_id,
      file_type: 'daily',
      date: dateStr,
      source_table: SOURCE_TABLE,
    }
    await upsertMemoryVector(
      { env, runAIWithTimeout, withRetry },
      indexable,
    )
  } catch {}

  await upsertProjectStats(env, userId, project_id, 'daily', 1)

  return { id }
}

export async function listDailies(
  env: Env,
  userId: string,
  options: ListDailyOptions = {},
): Promise<Daily[]> {
  const { project_id = '', date = '', limit = 50, offset = 0 } = options

  const conditions: string[] = ['user_id = ?', 'archived = 0']
  const bindings: unknown[] = [userId]

  if (project_id) {
    conditions.push('(project_id = ? OR ? = \'\')')
    bindings.push(project_id, project_id)
  }
  if (date) {
    conditions.push('date = ?')
    bindings.push(date)
  }

  const sql = `SELECT * FROM dailies WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT ? OFFSET ?`
  bindings.push(limit, offset)

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<Daily>()
  return results || []
}

export async function getDaily(
  env: Env,
  userId: string,
  id: string,
): Promise<Daily | null> {
  const result = await env.DB.prepare(
    'SELECT * FROM dailies WHERE id = ? AND user_id = ? AND archived = 0',
  ).bind(id, userId).first<Daily>()
  return result ?? null
}

export async function deleteDaily(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  const daily = await getDaily(env, userId, id)
  if (!daily) throw new Error('Daily not found')

  await env.DB.prepare(
    'UPDATE dailies SET archived = 1 WHERE id = ? AND user_id = ?',
  ).bind(id, userId).run()

  await deleteMemoryIndex(env, id)
  await upsertProjectStats(env, userId, daily.project_id, 'daily', -1)
}

export async function getUnextractedDailies(
  env: Env,
  userId: string,
  beforeDate: string,
  limit = 20,
): Promise<Daily[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM dailies
     WHERE user_id = ? AND extracted = 0 AND date < ? AND archived = 0
     ORDER BY date ASC, created_at ASC
     LIMIT ?`,
  ).bind(userId, beforeDate, limit).all<Daily>()
  return results || []
}

export async function markExtracted(
  env: Env,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const now = Date.now()
  const placeholders = ids.map(() => '?').join(',')

  await env.DB.prepare(
    `UPDATE dailies SET extracted = 1, extracted_at = ? WHERE id IN (${placeholders})`,
  ).bind(now, ...ids).run()
}

async function upsertProjectStats(
  env: Env,
  userId: string,
  projectId: string,
  field: 'instruction' | 'learning' | 'daily',
  delta: number,
): Promise<void> {
  if (!projectId) return

  const column = field === 'instruction' ? 'instruction_count'
    : field === 'learning' ? 'learning_count'
    : 'daily_count'

  const existing = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?',
  ).bind(projectId, userId).first<{ id: string }>()

  if (existing) {
    await env.DB.prepare(
      `UPDATE projects SET ${column} = MAX(0, ${column} + ?), last_active_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(delta, Date.now(), projectId, userId).run()
  } else {
    await env.DB.prepare(
      `INSERT INTO projects (id, user_id, ${column}, last_active_at, created_at) VALUES (?, ?, MAX(0, ?), ?, ?)`,
    ).bind(projectId, userId, delta, Date.now(), Date.now()).run()
  }
}
