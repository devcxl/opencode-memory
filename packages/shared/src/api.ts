import type { Memory } from './schema'

export interface KeywordSearchResult extends Memory {
  /** 匹配上下文片段 */
  snippet: string
  /** 匹配的 token/关键词数量 */
  matchCount: number
  /** RRF 融合后的综合评分 */
  score: number
}

export interface RagCitation {
  /** 来源记忆 ID */
  memoryId: string
  /** 引用文本片段 */
  text: string
  /** 记忆创建时间 */
  createdAt: number
  /** 记忆类型 */
  kind: 'short' | 'long'
  /** 语义相关性评分 */
  score: number
}

export interface AskResponse {
  /** AI 生成的回答 */
  answer: string
  /** 回答引用的记忆来源 */
  citations: RagCitation[]
}

export interface ApiResponse<T> {
  /** 请求是否成功 */
  success: boolean
  /** 响应数据（成功时存在） */
  data?: T
  /** 错误信息（失败时存在） */
  error?: string
}

export interface Stats {
  /** 短期记忆数量 */
  shortCount: number
  /** 长期记忆数量 */
  longCount: number
}
