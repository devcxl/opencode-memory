import type { D1Database, VectorizeIndex } from '@cloudflare/workers-types'
import type {
  MemoryRecord,
  MemoryType,
  MemoryLink,
  MemoryEntity,
  User,
  ApiTokenView,
  JobRun,
  AskResponse,
  RagCitation,
  SearchResult,
  ContextResponse,
  Stats,
  ApiResponse,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchRequest,
} from '@devcxl/opencode-memory-shared'

export type {
  MemoryRecord,
  MemoryType,
  MemoryLink,
  MemoryEntity,
  User,
  ApiTokenView,
  JobRun,
  AskResponse,
  RagCitation,
  SearchResult,
  ContextResponse,
  Stats,
  ApiResponse,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchRequest,
}

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
/** 北京时间 04:00 = UTC 20:00（wrangler cron 按 UTC 触发） */
export const CRON_SCHEDULE = '0 20 * * *'
/** 向量召回候选上限（Vectorize returnMetadata:'all' 时 topK ≤ 50） */
export const MAX_VECTOR_TOP_K = 50
export const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b'
export const LLM_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'

export interface Variables {
  userId?: string
  authKind?: 'token' | 'session'
  requestId?: string
}

/**
 * 后台异步任务上下文：服务层只需要 waitUntil，
 * 不直接依赖 workers-types / Hono 的 ExecutionContext 类型。
 */
export interface WaitContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface Env {
  DB: D1Database
  VEC: VectorizeIndex
  AI: {
    run: (model: string, input: any) => Promise<any>
  }
  /** 会话/状态 JWT 签名密钥 */
  JWT_SECRET: string
  /** GitHub OAuth App 凭据（wrangler secret） */
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** 允许登录的 GitHub 账号（数字 id 或 login，逗号分隔）；未设置时仅允许首个注册用户 */
  OAUTH_ALLOWLIST?: string
  /** 用户时区相对 UTC 的小时偏移（用于"昨天"等本地日期计算），默认 8（东八区） */
  TZ_OFFSET_HOURS?: string
  ALLOWED_ORIGINS?: string
}
