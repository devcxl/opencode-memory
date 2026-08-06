import { runAIWithTimeout } from '../utils/ai'
import { withRetry } from '../utils/retry'
import { deleteMemoryIndex, replaceMemoryIndex } from '../search/indexing'
import { segmentForIndex } from '../search/tokenizer'
import type { Env } from '../types'

export async function consolidateMemories(env: Env) {
  const now = Date.now()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterdayStart = today.getTime() - 24 * 60 * 60 * 1000
  const yesterdayEnd = today.getTime()

  const { results: users } = await env.DB.prepare(
    'SELECT DISTINCT user_id FROM memories WHERE kind = ? AND created_at >= ? AND created_at < ?'
  ).bind('short', yesterdayStart, yesterdayEnd).all()

  if (!users?.length) return

  for (const user of users as any[]) {
    const userId = user.user_id
    await consolidateUserMemories(userId, yesterdayStart, yesterdayEnd, env)
  }
}

async function consolidateUserMemories(
  userId: string,
  start: number,
  end: number,
  env: Env
) {
  const { results: memories } = await env.DB.prepare(
    'SELECT * FROM memories WHERE user_id = ? AND kind = ? AND created_at >= ? AND created_at < ? AND consolidated_at IS NULL'
  ).bind(userId, 'short', start, end).all()

  if (!memories?.length) return

  const memoriesList = (memories as any[]).map(m => ({
    id: m.id,
    text: m.text,
    tags: (() => {
      try {
        return m.tags ? JSON.parse(m.tags) : []
      } catch {
        return []
      }
    })()
  }))

  if (!env.AI) return

  const messages = [
    {
      role: 'system',
      content: `你是一个记忆分类助手。分析用户昨天的短期记忆，判断哪些应该晋升为长期记忆。

指令:
1. 对每条记忆，评估是否包含值得长期保存的重要信息
2. 考虑以下因素：
   - 这个信息将来可能会用到吗？
   - 这是一个有意义的事件、事实或见解吗？
   - 这是用户会想要记住的内容吗？
3. 只返回应该晋升为长期记忆的记忆 ID
4. 为每个晋升的记忆提供简洁的摘要和标签

输出 JSON 格式:
{
  "to_promote": [
    {
      "id": "memory-uuid",
      "should_promote": true,
      "summary": "简洁摘要（如果与原文不同）",
      "tags": ["标签1", "标签2"]
    }
  ]
}

只返回有效的 JSON，不要额外文字。
/no_think`,
    },
    {
      role: 'user',
      content: `输入记忆 (JSON 数组):\n${JSON.stringify(memoriesList, null, 2)}`,
    },
  ]

  try {
    const response = await env.AI.run('@cf/qwen/qwen3-30b-a3b-fp8', {
      messages,
      max_tokens: 4096,
      temperature: 0.3,
    }) as any

    let result
    const text = response.response || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        result = JSON.parse(jsonMatch[0])
      } catch (e) {
        console.error('Failed to parse AI response as JSON:', e)
        return
      }
    }

    if (!result?.to_promote?.length) return

    for (const item of result.to_promote) {
      if (item.should_promote) {
        const originalMemory = (memories as any[]).find(m => m.id === item.id)
        if (originalMemory) {
          const summary = item.summary || originalMemory.text
          const tags = item.tags?.length ? item.tags : (() => {
            try {
              return originalMemory.tags ? JSON.parse(originalMemory.tags) : []
            } catch {
              return []
            }
          })()

          await env.DB.prepare(
            'UPDATE memories SET kind = ?, expires_at = NULL, text = ?, text_fts = ?, tags = ?, consolidated_at = ? WHERE id = ? AND user_id = ?'
          ).bind('long', summary, segmentForIndex(summary), JSON.stringify(tags), Date.now(), item.id, userId).run()

          await replaceMemoryIndex(
            { env, runAIWithTimeout, withRetry },
            {
              id: item.id,
              user_id: userId,
              kind: 'long',
              text: summary,
              created_at: originalMemory.created_at,
            }
          )
        }
      }
    }

    const processedIds = result.to_promote.map((item: any) => item.id)
    const unprocessedIds = (memories as any[])
      .filter(m => !processedIds.includes(m.id))
      .map(m => m.id)

    for (const id of unprocessedIds) {
      await env.DB.prepare(
        'UPDATE memories SET consolidated_at = ? WHERE id = ?'
      ).bind(Date.now(), id).run()
    }
  } catch (e) {
    console.error('Consolidation failed:', e)
  }
}

export async function cleanupExpiredMemories(env: Env) {
  const now = Date.now()

  const { results: expired } = await env.DB.prepare(
    'SELECT id, user_id FROM memories WHERE kind = ? AND expires_at < ? AND archived = 0'
  ).bind('short', now).all<{ id: string; user_id: string }>()

  if (!expired?.length) return

  const ids = expired.map(e => e.id)
  const placeholders = ids.map(() => '?').join(',')

  await env.DB.prepare(
    `DELETE FROM memories WHERE id IN (${placeholders})`
  ).bind(...ids).run()

  for (const memory of expired) {
    await deleteMemoryIndex(env, memory.id)
  }
}
