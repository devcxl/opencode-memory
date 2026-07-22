import { deleteMemoryIndex, replaceMemoryIndex, upsertMemoryVector, type IndexableMemory } from '../search/indexing'
import { hybridSearch } from '../search/hybrid'
import { segmentForIndex } from '../search/tokenizer'
import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'
import type { Env, KeywordSearchResult, Memory } from '../types'
import { SHORT_TERM_EXPIRY_MS } from '../types'

export interface CreateMemoryOptions {
  text: string
  tags?: string[]
  kind?: 'short' | 'long'
}

export interface ListMemoriesOptions {
  kind?: 'short' | 'long'
  limit?: number
  offset?: number
}

export interface SearchMemoriesOptions {
  query: string
  kind?: 'short' | 'long'
  topK?: number
}

export interface CreateMemoryResult {
  id: string
  indexed: boolean
}

export async function createMemory(
  env: Env,
  userId: string,
  options: CreateMemoryOptions
): Promise<CreateMemoryResult> {
  const { text, tags, kind = 'short' } = options
  const id = crypto.randomUUID()
  const now = Date.now()
  const expiresAt = kind === 'short' ? now + SHORT_TERM_EXPIRY_MS : null
  const textFts = segmentForIndex(text)

  await env.DB.prepare(
    'INSERT INTO memories (id, user_id, kind, text, text_fts, tags, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, kind, text, textFts, JSON.stringify(tags || []), now, expiresAt).run()

  let indexed = true
  try {
    await upsertMemoryVector(
      { env, runAIWithTimeout, withRetry },
      { id, user_id: userId, kind, text, created_at: now }
    )
  } catch {
    indexed = false
  }

  return { id, indexed }
}

export async function listMemories(
  env: Env,
  userId: string,
  options: ListMemoriesOptions
): Promise<Memory[]> {
  const { kind = 'short', limit = 50, offset = 0 } = options

  const { results } = await env.DB.prepare(
    'SELECT * FROM memories WHERE user_id = ? AND kind = ? AND archived = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(userId, kind, limit, offset).all<Memory>()

  return results || []
}

export async function searchMemories(
  env: Env,
  userId: string,
  options: SearchMemoriesOptions
): Promise<KeywordSearchResult[]> {
  const { query, topK = 5, kind } = options
  return hybridSearch(env, runAIWithTimeout, {
    query,
    userId,
    kind,
    topK,
    limit: topK,
  })
}

export async function promoteMemory(
  env: Env,
  userId: string,
  id: string
): Promise<void> {
  await env.DB.prepare(
    'UPDATE memories SET kind = ?, expires_at = NULL WHERE id = ? AND user_id = ?'
  ).bind('long', id, userId).run()

  const memory = await env.DB.prepare(
    'SELECT id, user_id, kind, text, created_at FROM memories WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first<IndexableMemory>()

  if (memory) {
    await replaceMemoryIndex({ env, runAIWithTimeout, withRetry }, memory)
  }
}

export async function deleteMemory(
  env: Env,
  userId: string,
  id: string
): Promise<void> {
  await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(id, userId).run()
  await deleteMemoryIndex(env, id)
}
