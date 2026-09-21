import type { Env } from '../types'

/**
 * API Token：明文 `opm_<32字节 base64url>`，仅创建时返回一次；
 * 库中只存 SHA-256 哈希，校验走唯一索引查询。
 */

const TOKEN_PREFIX = 'opm_'

export function generateApiToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const body = base64urlEncode(bytes)
  return `${TOKEN_PREFIX}${body}`
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 12)
}

export interface TokenAuthResult {
  userId: string
  tokenId: string
}

/** 校验 Bearer Token，成功返回归属用户；无效/吊销返回 null */
export async function verifyApiToken(env: Env, token: string): Promise<TokenAuthResult | null> {
  const tokenHash = await hashToken(token)
  const row = await env.DB.prepare(
    'SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL',
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string }>()
  if (!row) return null
  return { userId: row.user_id, tokenId: row.id }
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
