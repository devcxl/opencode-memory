#!/usr/bin/env node
/**
 * text_fts 回填脚本
 *
 * 迁移 0005 新增 text_fts 列后，已有记忆的 text_fts 为空。
 * 本脚本逐批读取这些记忆，用 Intl.Segmenter 做中文分词后回填。
 *
 * 使用方法：
 *   1. 确保 wrangler 已登录: npx wrangler whoami
 *   2. npx tsx scripts/backfill-text-fts.ts
 *
 * 流程：
 *   1. 通过 wrangler 查询所有 text_fts 为空的记忆 → dump.json
 *   2. JS 处理每条记忆，生成 UPDATE SQL → backfill.sql
 *   3. 通过 wrangler 执行 backfill.sql
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --------------- 内联分词器 ---------------

const FTS_SPECIAL_CHARS = /[\"\*\(\)\:\^{}\[\]\\]/g
function sanitizeToken(token: string): string {
  return token.replace(FTS_SPECIAL_CHARS, '').trim()
}

function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text)
}

function segmentForIndex(text: string): string {
  if (!text) return ''
  if (!hasCJK(text)) return text.toLowerCase()

  const words: string[] = []
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const segments = segmenter.segment(text)

  for (const { segment, isWordLike } of segments) {
    const cleaned = sanitizeToken(segment.toLowerCase())
    if (!cleaned) continue
    if (/[\u4e00-\u9fff]/.test(cleaned)) {
      words.push(cleaned)
    } else if (cleaned.length >= 2) {
      words.push(cleaned)
    }
  }

  return words.join(' ')
}

// --------------- 工具函数 ---------------

function escapeSql(s: string): string {
  return s.replace(/'/g, "''")
}

function runWrangler(args: string): string {
  return execSync(`npx wrangler ${args} 2>/dev/null`, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  })
}

// --------------- 主流程 ---------------

async function main() {
  console.log('🔍 检查 wrangler 登录状态...')
  try {
    execSync('npx wrangler whoami 2>/dev/null', { encoding: 'utf-8' })
  } catch {
    console.error('❌ wrangler 未登录，请先运行: npx wrangler login')
    process.exit(1)
  }

  // 1. 查询需要回填的记忆
  console.log('📦 查询需要回填的记忆...')
  const sql = "SELECT id, text FROM memories WHERE text_fts = '' OR text_fts IS NULL"
  const dumpFile = join(tmpdir(), 'memory-backfill-dump.json')
  runWrangler(`d1 execute memory-db --remote --command="${sql}" --json > "${dumpFile}"`)

  if (!existsSync(dumpFile)) {
    console.error('❌ 查询失败，无法获取数据')
    process.exit(1)
  }

  const raw = readFileSync(dumpFile, 'utf-8').trim()
  const lines = raw.split('\n').filter(Boolean)
  let rows: any[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.results) {
        rows = parsed.results
        break
      }
    } catch {}
  }

  if (rows.length === 0) {
    console.log('✅ 没有需要回填的记忆')
    unlinkSync(dumpFile)
    return
  }

  console.log(`📝 待处理 ${rows.length} 条记忆`)

  // 2. 生成 SQL 文件（分批更新，避免单条执行开销）
  const sqlFile = join(tmpdir(), 'memory-backfill.sql')
  const batchSize = 200
  let updatedCount = 0

  const chunks: string[][] = []
  for (let i = 0; i < rows.length; i += batchSize) {
    chunks.push(rows.slice(i, i + batchSize))
  }

  for (const chunk of chunks) {
    const statements = chunk.map((row) => {
      const textFts = segmentForIndex(row.text ?? '')
      return `UPDATE memories SET text_fts = '${escapeSql(textFts)}' WHERE id = '${row.id}';`
    })
    writeFileSync(sqlFile, statements.join('\n'), 'utf-8')
    const label = `  批次 ${chunks.indexOf(chunk) + 1}/${chunks.length}`
    process.stdout.write(`  ⏳ ${label}\r`)
    runWrangler(`d1 execute memory-db --remote --file="${sqlFile}"`)
    updatedCount += chunk.length
  }

  // 清理临时文件
  try {
    unlinkSync(dumpFile)
    unlinkSync(sqlFile)
  } catch {}

  console.log(`\n✅ 回填完成：更新 ${updatedCount} 条记忆`)
}

main().catch((e) => {
  console.error('❌ 脚本异常退出:', e)
  process.exit(1)
})
