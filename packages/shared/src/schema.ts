/**
 * 领域模型 — 与数据库表一一对应
 * 这是数据模型的唯一"真相来源"，SQL DDL 和 TS 类型均应与此保持一致。
 */

export interface Memory {
  /** UUID */
  id: string
  /** 用户标识 */
  user_id: string
  /** 记忆类型：short（短期，自动过期）| long（长期，持久保留） */
  kind: 'short' | 'long'
  /** 记忆内容 */
  text: string
  /** JSON 序列化的标签数组 */
  tags: string
  /** 来源标识（如 mcp, api） */
  source?: string
  /** 创建时间戳（毫秒） */
  created_at: number
  /** 过期时间戳（短期记忆，到期后由 cron 清理） */
  expires_at?: number | null
  /** 合并时间戳（short→long 提升时记录） */
  consolidated_at?: number | null
  /** 是否归档（1=已归档，0=正常） */
  archived: number
  /** FTS 分词后的文本，用于全文检索 */
  text_fts?: string
}

export interface RateLimit {
  /** SQLite 自增主键 */
  id?: number
  /** 用户标识 */
  user_id: string
  /** 限流窗口起始时间（秒级） */
  window_start: number
  /** 当前窗口内的请求计数 */
  count: number
}
