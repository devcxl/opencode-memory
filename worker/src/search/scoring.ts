/**
 * 分数归一化与时间衰减工具
 *
 * 所有进入 RRF 的分数都经过 min-max 归一化到 [0, 1] 区间，
 * 确保不同量纲的分数（向量余弦距离、BM25 分数）可融合。
 */

/** Recency 加权系数：控制时间衰减对最终排序的影响程度 */
export const RECENCY_WEIGHT = 0.1

/** 时间衰减窗口（天）：1 年后衰减到 0 */
export const RECENCY_DECAY_DAYS = 365

/**
 * min-max 归一化：将 items 中的 score 字段映射到 [0, 1]
 *
 * 如果所有 score 相同或只有一个元素，全部返回 1.0
 * 如果数组为空，返回空数组
 */
export function normalizeScores<T extends { score: number }>(items: T[]): T[] {
  if (items.length === 0) return items
  if (items.length === 1) {
    items[0].score = 1.0
    return items
  }

  let min = Infinity
  let max = -Infinity
  for (const item of items) {
    if (item.score < min) min = item.score
    if (item.score > max) max = item.score
  }

  const range = max - min
  if (range === 0) {
    // 所有分数相等
    for (const item of items) {
      item.score = 1.0
    }
    return items
  }

  for (const item of items) {
    item.score = (item.score - min) / range
  }

  return items
}

/**
 * 时间衰减分数（线性衰减）
 *
 * createdAt 距今越久，分数越低。
 * 超过 decayDays 后返回 0，未来时间返回 1。
 */
export function recencyBoost(
  createdAt: number,
  decayDays: number = RECENCY_DECAY_DAYS
): number {
  const ageMs = Date.now() - createdAt
  if (ageMs <= 0) return 1.0

  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  if (ageDays >= decayDays) return 0

  return Math.max(0, 1 - ageDays / decayDays)
}
