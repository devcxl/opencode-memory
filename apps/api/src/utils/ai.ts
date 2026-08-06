import type { Env } from '../types'

// AI 请求超时时间 (30 秒)
export const AI_TIMEOUT = 30 * 1000

export async function runAIWithTimeout<T>(ai: Env['AI'], model: string, input: unknown): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT)

  try {
    const result = await ai.run(model, input)
    clearTimeout(timeout)
    return result as T
  } catch (error) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`AI request timed out after ${AI_TIMEOUT}ms`)
    }
    throw error
  }
}
