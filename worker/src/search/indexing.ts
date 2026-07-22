import type { Env } from '../types'

interface EmbeddingResponse {
  data: number[][]
}

export interface IndexableMemory {
  id: string
  user_id: string
  kind: 'short' | 'long'
  text: string
  created_at: number
  project_id?: string
  file_type?: string
  date?: string | null
}

export interface IndexingDeps {
  env: Env
  runAIWithTimeout: <T>(ai: Env['AI'], model: string, input: unknown) => Promise<T>
  withRetry: <T>(fn: () => Promise<T>, operationName: string) => Promise<T>
}

export async function upsertMemoryVector(deps: IndexingDeps, memory: IndexableMemory): Promise<void> {
  const { env, runAIWithTimeout, withRetry } = deps
  if (!env.AI || !env.VEC) {
    return
  }

  const embedding = await runAIWithTimeout<EmbeddingResponse>(
    env.AI,
    '@cf/qwen/qwen3-embedding-0.6b',
    { text: memory.text }
  )

  await withRetry(
    () => env.VEC.upsert([{
      id: memory.id,
      values: embedding.data[0],
      metadata: {
        user_id: memory.user_id,
        kind: memory.kind,
        created_at: memory.created_at,
        project_id: memory.project_id || '',
        file_type: memory.file_type || 'memory',
        date: memory.date || '',
      },
    }]),
    'memory vector upsert'
  )
}

export async function indexMemory(deps: IndexingDeps, memory: IndexableMemory): Promise<void> {
  await upsertMemoryVector(deps, memory)
}

export async function replaceMemoryIndex(deps: IndexingDeps, memory: IndexableMemory): Promise<void> {
  // 直接 upsert 即可覆盖旧向量
  await upsertMemoryVector(deps, memory)
}

export async function deleteMemoryIndex(env: Env, memoryId: string): Promise<void> {
  if (env.VEC) {
    await env.VEC.deleteByIds([memoryId])
  }
}
