/**
 * 用户本地时区的日期计算。
 * Workers 运行时固定 UTC，"昨天"等日期边界必须按用户时区偏移换算。
 */

/** 用户时区偏移小时数（默认东八区） */
export function tzOffsetHours(env: { TZ_OFFSET_HOURS?: string }): number {
  const parsed = parseInt(env.TZ_OFFSET_HOURS || '8')
  return Number.isNaN(parsed) ? 8 : parsed
}

/** 时间戳 → 用户本地日期（YYYY-MM-DD） */
export function userLocalDate(ts: number, offsetHours: number): string {
  return new Date(ts + offsetHours * 3600 * 1000).toISOString().slice(0, 10)
}

/** 用户本地时区下"昨天"的日期（YYYY-MM-DD） */
export function userYesterday(offsetHours: number, now = Date.now()): string {
  return userLocalDate(now - 24 * 60 * 60 * 1000, offsetHours)
}
