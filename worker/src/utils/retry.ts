// 重试配置
const MAX_RETRIES = 3
const RETRY_DELAY_BASE = 1000

export async function withRetry<T>(fn: () => Promise<T>, operationName: string): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.error(`Attempt ${attempt}/${MAX_RETRIES} failed for ${operationName}:`, lastError.message)

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw new Error(`${operationName} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`)
}
