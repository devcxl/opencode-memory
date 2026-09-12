/**
 * v2 迁移脚本：user_id 归属映射 + 全量重建向量索引。
 *
 * 前置条件：
 * 1. 已执行 `pnpm --filter @devcxl/cabbage-memory-api db:migrate`（0010/0011/0012）
 * 2. 已部署新 Worker 并完成一次 GitHub 登录
 * 3. 已在 Web 个人中心生成 API Token
 *
 * 用法：
 *   npx tsx scripts/migrate-v2.ts --url https://<worker> --token opm_xxx \
 *     --old-user-id <旧 JWT sub> [--force-reindex]
 *
 * 步骤：
 *   1. POST /api/admin/remap-user  把旧 user_id 下的数据归属到当前登录用户
 *   2. POST /api/reindex?force=1   按当前分词器与 embedding 模型全量重建向量索引
 *   3. POST /api/digest            可选：手动触发一次昨天的 digest（验证 cron 逻辑）
 */

interface Args {
  url: string
  token: string
  oldUserId?: string
  adminSecret?: string
  forceReindex: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (key: string) => {
    const i = argv.indexOf(`--${key}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const url = get('url')
  const token = get('token')
  if (!url || !token) {
    console.error('用法: npx tsx scripts/migrate-v2.ts --url <worker-url> --token <opm_...> [--old-user-id <旧JWT sub>] [--admin-secret <secret>] [--force-reindex]')
    process.exit(1)
  }
  return {
    url: url.replace(/\/$/, ''),
    token,
    oldUserId: get('old-user-id'),
    adminSecret: get('admin-secret'),
    forceReindex: argv.includes('--force-reindex'),
  }
}

async function post<T>(url: string, token: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await res.json()) as { success: boolean; data?: T; error?: string }
  if (!res.ok || !json.success) {
    throw new Error(`${path} failed (${res.status}): ${json.error || res.statusText}`)
  }
  return json.data as T
}

async function main() {
  const args = parseArgs()

  // 1. user_id 归属映射
  if (args.oldUserId) {
    console.log(`[1/2] remap user_id: ${args.oldUserId} → 当前用户 ...`)
    const extraHeaders: Record<string, string> = {}
    if (args.adminSecret) extraHeaders['X-Admin-Secret'] = args.adminSecret
    const result = await post<{ remapped: Record<string, number> }>(
      args.url,
      args.token,
      '/api/admin/remap-user',
      { old_user_id: args.oldUserId },
      extraHeaders,
    )
    console.log('  remapped:', JSON.stringify(result.remapped))
  } else {
    console.log('[1/2] 未提供 --old-user-id，跳过 user_id 映射')
  }

  // 2. 全量重建向量索引（按批推进，防止 Worker 524 超时）
  console.log(`[2/2] reindex (force=${args.forceReindex}) ...`)
  let offset = 0
  const batchSize = 200
  let totalIndexed = 0
  let totalSkipped = 0
  let totalFailed = 0
  let round = 1

  for (;;) {
    const query = new URLSearchParams({
      limit: String(batchSize),
      offset: String(offset),
    })
    if (args.forceReindex) query.set('force', '1')

    const res = await post<{
      total: number
      indexed: number
      skipped: number
      failed: number
      hasMore: boolean
      nextOffset?: number
    }>(args.url, args.token, `/api/reindex?${query.toString()}`)

    totalIndexed += res.indexed
    totalSkipped += res.skipped
    totalFailed += res.failed
    console.log(
      `  [批次 ${round}] 本批=${res.total} indexed=${res.indexed} skipped=${res.skipped} failed=${res.failed} hasMore=${res.hasMore}`,
    )

    if (!res.hasMore || res.nextOffset === undefined) break
    offset = res.nextOffset
    round++
  }

  console.log(`  reindex 汇总: indexed=${totalIndexed} skipped=${totalSkipped} failed=${totalFailed}`)

  console.log('迁移完成。可执行 POST /api/digest 手动验证一次 digest。')
}

main().catch((error) => {
  console.error('迁移失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
