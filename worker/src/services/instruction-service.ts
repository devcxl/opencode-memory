import type { Env, Instruction, InstructionType, MemoryScope } from '../types'
import { upsertMemoryVector, type IndexableMemory } from '../search/indexing'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'

const SOURCE_TABLE = 'instructions'

export interface CreateInstructionOptions {
  type: InstructionType
  title: string
  content: string
  scope?: MemoryScope
  project_id?: string
  path_pattern?: string
  priority?: number
  tags?: string[]
}

export interface ListInstructionOptions {
  type?: InstructionType
  scope?: MemoryScope
  project_id?: string
  limit?: number
  offset?: number
}

export async function createInstruction(
  env: Env,
  userId: string,
  options: CreateInstructionOptions,
): Promise<{ id: string }> {
  const {
    type,
    title,
    content,
    scope = 'global',
    project_id = '',
    path_pattern,
    priority = 0,
    tags = [],
  } = options

  const id = crypto.randomUUID()
  const now = Date.now()

  await env.DB.prepare(
    `INSERT INTO instructions (id, user_id, type, title, content, scope, project_id, path_pattern, priority, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, type, title, content, scope, project_id, path_pattern ?? null, priority, JSON.stringify(tags), now)
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

  await upsertProjectStats(env, userId, project_id, 'instruction', 1)

  return { id }
}

export async function listInstructions(
  env: Env,
  userId: string,
  options: ListInstructionOptions = {},
): Promise<Instruction[]> {
  const { type, scope, project_id, limit = 50, offset = 0 } = options

  const conditions: string[] = ['user_id = ?', 'archived = 0']
  const bindings: unknown[] = [userId]

  if (type) {
    conditions.push('type = ?')
    bindings.push(type)
  }
  if (scope) {
    conditions.push('scope = ?')
    bindings.push(scope)
  }
  if (project_id) {
    conditions.push('(project_id = ? OR ? = \'\')')
    bindings.push(project_id, project_id)
  }

  const sql = `SELECT * FROM instructions WHERE ${conditions.join(' AND ')} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`
  bindings.push(limit, offset)

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<Instruction>()
  return results || []
}

export async function getInstruction(
  env: Env,
  userId: string,
  id: string,
): Promise<Instruction | null> {
  const result = await env.DB.prepare(
    'SELECT * FROM instructions WHERE id = ? AND user_id = ? AND archived = 0',
  ).bind(id, userId).first<Instruction>()
  return result ?? null
}

export async function deleteInstruction(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  const instruction = await getInstruction(env, userId, id)
  if (!instruction) throw new Error('Instruction not found')

  await env.DB.prepare(
    'UPDATE instructions SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?',
  ).bind(Date.now(), id, userId).run()

  await upsertProjectStats(env, userId, instruction.project_id, 'instruction', -1)
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
