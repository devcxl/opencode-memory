import type { Env, ExtractionLog } from '../types'
import { getUnextractedDailies, markExtracted } from './daily-service'
import { createLearning } from './learning-service'
import { runAIWithTimeout } from '../utils/ai'

interface ExtractionResult {
  id: string
  action: 'extract' | 'skip'
  type?: 'preference' | 'episodic' | 'knowledge'
  title?: string
  content?: string
  confidence?: number
}

/**
 * 从 dailies 中批量提取结构化 learning。
 * 每次最多处理 10 条，防止 LLM 上下文溢出。
 */
async function extractBatch(
  env: Env,
  userId: string,
  dailies: Array<{
    id: string
    content: string
    project_id: string
    date: string
  }>,
): Promise<ExtractionResult[]> {
  if (!env.AI) {
    throw new Error('Workers AI not configured')
  }

  if (dailies.length === 0) return []

  const entriesJson = dailies
    .map((d) => `{"id": "${d.id}", "date": "${d.date}", "content": ${JSON.stringify(d.content.slice(0, 500))}}`)
    .join(',\n')

  const prompt = `你是一个记忆提取助手。分析以下日志条目，决定是否需要提取为结构化记忆。

对于每条日志：
- 包含 Bug 修复/解决方案/问题排查 → 提取为 episodic
- 包含用户偏好/习惯/工作风格 → 提取为 preference
- 包含架构决策/技术约定/项目规范 → 提取为 knowledge
- 包含可复用的工作流/流程 → 提取为 knowledge
- 纯日常流水（无结构化信息）→ 跳过

输出 JSON 数组（不要 Markdown 包装）：
[
  {"id": "...", "action": "extract|skip", "type": "episodic|preference|knowledge", "title": "简短标题", "content": "提取后的结构化内容", "confidence": 0.0-1.0},
  ...
]

日志条目：
[${entriesJson}]`

  const result = await runAIWithTimeout(env.AI, '@cf/meta/llama-4-scout-17b-16e-instruct', {
    messages: [
      { role: 'system', content: '你只输出 JSON 数组，不要任何额外文字。' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 2000,
  })

  const text =
    typeof result === 'string'
      ? result
      : (result as { response?: string })?.response ??
        (result as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ??
        ''

  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult[]
    return parsed.filter((r) => r.id)
  } catch {
    return []
  }
}

/**
 * 触发 daily → learning 提取任务。
 * @param beforeDate 只处理此日期之前的 dailies
 * @param limit 最大处理条数
 */
export async function triggerExtraction(
  env: Env,
  userId: string,
  beforeDate: string,
  limit = 20,
): Promise<ExtractionLog> {
  const logId = crypto.randomUUID()
  const now = Date.now()
  const today = beforeDate || new Date().toISOString().slice(0, 10)

  await env.DB.prepare(
    `INSERT INTO extraction_log (id, user_id, started_at, status, created_at)
     VALUES (?, ?, ?, 'running', ?)`,
  ).bind(logId, userId, now, now).run()

  try {
    const dailies = await getUnextractedDailies(env, userId, today, limit)

    if (!dailies || dailies.length === 0) {
      await env.DB.prepare(
        `UPDATE extraction_log SET completed_at = ?, daily_count = 0, extracted_count = 0, status = 'completed' WHERE id = ?`,
      ).bind(Date.now(), logId).run()
      return createLogResult(logId, 0, 0, 'completed')
    }

    // 分批处理（每次 10 条）
    let extractedCount = 0
    const batchSize = 10

    for (let i = 0; i < dailies.length; i += batchSize) {
      const batch = dailies.slice(i, i + batchSize)
      const results = await extractBatch(
        env,
        userId,
        batch.map((d) => ({
          id: d.id,
          content: d.content,
          project_id: d.project_id,
          date: d.date,
        })),
      )

      const extractedIds: string[] = []

      for (const r of results) {
        if (r.action !== 'extract' || !r.type || !r.content) continue

        try {
          const sourceDaily = batch.find((d) => d.id === r.id)
          await createLearning(env, userId, {
            type: r.type,
            title: r.title || '自动提取',
            content: r.content,
            scope: sourceDaily?.project_id ? 'project' : 'global',
            project_id: sourceDaily?.project_id || '',
            source: 'extracted',
            source_ids: [r.id],
            confidence: r.confidence ?? 0.7,
          })
          extractedIds.push(r.id)
          extractedCount++
        } catch {
          // 单条失败不阻塞整体
        }
      }

      if (extractedIds.length > 0) {
        await markExtracted(env, extractedIds)
      }
    }

    await env.DB.prepare(
      `UPDATE extraction_log SET completed_at = ?, daily_count = ?, extracted_count = ?, status = 'completed' WHERE id = ?`,
    ).bind(Date.now(), dailies.length, extractedCount, logId).run()

    return createLogResult(logId, dailies.length, extractedCount, 'completed')
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    await env.DB.prepare(
      `UPDATE extraction_log SET completed_at = ?, status = 'failed', error = ? WHERE id = ?`,
    ).bind(Date.now(), errorMsg, logId).run()

    return createLogResult(logId, 0, 0, 'failed', errorMsg)
  }
}

function createLogResult(
  id: string,
  dailyCount: number,
  extractedCount: number,
  status: 'running' | 'completed' | 'failed',
  error?: string,
): ExtractionLog {
  return {
    id,
    user_id: '',
    started_at: 0,
    completed_at: Date.now(),
    daily_count: dailyCount,
    extracted_count: extractedCount,
    status,
    error: error ?? null,
    created_at: 0,
  }
}

export async function getExtractionStatus(
  env: Env,
  userId: string,
): Promise<ExtractionLog | null> {
  const result = await env.DB.prepare(
    `SELECT * FROM extraction_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId).first<ExtractionLog>()
  return result ?? null
}
