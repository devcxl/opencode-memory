import type { Env, Learning, LearningType, MemoryScope, LearningSource } from '../types'
import { deleteMemoryIndex, upsertMemoryVector, type IndexableMemory } from '../search/indexing'
import { segmentForIndex } from '../search/tokenizer'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'

const SOURCE_TABLE = 'learnings'

export interface CreateLearningOptions {
  type: LearningType
  title: string
  content: string
  scope?: MemoryScope
  project_id?: string
  source?: LearningSource
  source_ids?: string[]
  confidence?: number
  tags?: string[]
}

export interface ListLearningOptions {
  type?: LearningType
  source?: LearningSource
  scope?: MemoryScope
  project_id?: string
  limit?: number
  offset?: number
}

export async function createLearning(
  env: Env,
  userId: string,
  options: CreateLearningOptions,
): Promise<{ id: string }> {
  const {
    type,
    title,
    content,
    scope = 'global',
    project_id = '',
    source = 'manual',
    source_ids,
    confidence = 1.0,
    tags = [],
  } = options

  const id = crypto.randomUUID()
  const now = Date.now()
  const contentFts = segmentForIndex(`${title} ${content}`)

  await env.DB.prepare(
    `INSERT INTO learnings (id, user_id, type, title, content, content_fts, scope, project_id, source, source_ids, confidence, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, type, title, content, contentFts, scope, project_id, source, source_ids ? JSON.stringify(source_ids) : null, confidence, JSON.stringify(tags), now)
    .run()

  try {
    const indexable: IndexableMemory = {
      id,
      user_id: userId,
      kind: 'long',
      text: `${title}\n${content}`,
      created_at: now,
      project_id,
      file_type: type,
      date: null,
      source_table: SOURCE_TABLE,
    }
    await upsertMemoryVector(
      { env, runAIWithTimeout, withRetry },
      indexable,
    )
  } catch {}

  await upsertProjectStats(env, userId, project_id, 'learning', 1)

  return { id }
}

export async function listLearnings(
  env: Env,
  userId: string,
  options: ListLearningOptions = {},
): Promise<Learning[]> {
  const { type, source, scope, project_id, limit = 50, offset = 0 } = options

  const conditions: string[] = ['user_id = ?', 'archived = 0']
  const bindings: unknown[] = [userId]

  if (type) {
    conditions.push('type = ?')
    bindings.push(type)
  }
  if (source) {
    conditions.push('source = ?')
    bindings.push(source)
  }
  if (scope) {
    conditions.push('scope = ?')
    bindings.push(scope)
  }
  if (project_id) {
    conditions.push('(project_id = ? OR ? = \'\')')
    bindings.push(project_id, project_id)
  }

  const sql = `SELECT * FROM learnings WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  bindings.push(limit, offset)

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<Learning>()
  return results || []
}

export async function getLearning(
  env: Env,
  userId: string,
  id: string,
): Promise<Learning | null> {
  const result = await env.DB.prepare(
    'SELECT * FROM learnings WHERE id = ? AND user_id = ? AND archived = 0',
  ).bind(id, userId).first<Learning>()
  return result ?? null
}

export async function deleteLearning(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  const learning = await getLearning(env, userId, id)
  if (!learning) throw new Error('Learning not found')

  await env.DB.prepare(
    'UPDATE learnings SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?',
  ).bind(Date.now(), id, userId).run()

  await deleteMemoryIndex(env, id)
  await upsertProjectStats(env, userId, learning.project_id, 'learning', -1)
}

export async function bumpRecallStats(
  env: Env,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const now = Date.now()
  const placeholders = ids.map(() => '?').join(',')

  await env.DB.prepare(
    `UPDATE learnings SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id IN (${placeholders})`,
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
