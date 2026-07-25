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
  /** 项目标识（owner/repo），为空表示全局记忆 */
  project_id: string
  /** 文件类型：memory | identity | user | daily */
  file_type: string
  /** 日期（YYYY-MM-DD），用于 daily 日志查询 */
  date?: string | null
}

// ============================================================
// 结构化记忆类型（0007_migration）
// ============================================================

export type InstructionType = 'identity' | 'rule' | 'workflow'
export type LearningType = 'preference' | 'episodic' | 'knowledge'
export type MemoryScope = 'global' | 'project' | 'user' | 'local'
export type LearningSource = 'manual' | 'extracted' | 'imported'

export interface Instruction {
  id: string
  user_id: string
  type: InstructionType
  title: string
  content: string
  scope: MemoryScope
  project_id: string
  path_pattern?: string | null
  priority: number
  tags: string
  created_at: number
  updated_at?: number | null
  archived: number
}

export interface Learning {
  id: string
  user_id: string
  type: LearningType
  title: string
  content: string
  content_fts?: string | null
  scope: MemoryScope
  project_id: string
  source: LearningSource
  source_ids?: string | null
  confidence: number
  tags: string
  recall_count: number
  last_recalled_at?: number | null
  created_at: number
  updated_at?: number | null
  archived: number
}

export interface Daily {
  id: string
  user_id: string
  content: string
  content_fts?: string | null
  project_id: string
  date: string
  extracted: number
  extracted_at?: number | null
  tags: string
  created_at: number
  archived: number
}

export interface Project {
  id: string
  user_id: string
  name?: string | null
  instruction_count: number
  learning_count: number
  daily_count: number
  last_active_at?: number | null
  created_at: number
}

export interface ExtractionLog {
  id: string
  user_id: string
  started_at: number
  completed_at?: number | null
  daily_count: number
  extracted_count: number
  status: 'running' | 'completed' | 'failed'
  error?: string | null
  created_at: number
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
