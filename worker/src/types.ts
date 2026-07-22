import type { D1Database, VectorizeIndex } from '@cloudflare/workers-types'
import type { Memory, AskResponse, RagCitation, KeywordSearchResult } from '@cfmem/shared'

// Re-export shared types so consumers can import from '../types'
export type { Memory, AskResponse, RagCitation, KeywordSearchResult }

export const SHORT_TERM_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100
export const CRON_SCHEDULE = '0 4 * * *'
export const REINDEX_BATCH_SIZE = 100

export interface Variables {
  userId?: string
  userRole?: string
  requestId?: string
}

export interface Env {
  DB: D1Database
  VEC: VectorizeIndex
  AI: {
    run: (model: string, input: any) => Promise<any>
  }
  JWT_SECRET: string
  ALLOWED_ORIGINS?: string
  RATE_LIMIT?: string
}
