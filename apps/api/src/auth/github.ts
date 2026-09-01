import { SignJWT, jwtVerify } from 'jose'
import type { Env, User } from '../types'

/**
 * GitHub OAuth2 登录 + 会话签发。
 * - state 用短期 JWT 写入 httpOnly cookie，防 CSRF
 * - 会话为 7 天 JWT，写入 httpOnly cookie
 * - OAUTH_ALLOWLIST 为空时仅允许首个注册用户（首个登录者认领实例）
 */

export const SESSION_COOKIE = 'opm_session'
export const OAUTH_STATE_COOKIE = 'opm_oauth_state'

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const STATE_TTL_SECONDS = 10 * 60

interface SessionPayload {
  sub: string
  login: string
}

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET)
}

export async function signSession(env: Env, user: Pick<User, 'id' | 'login'>): Promise<string> {
  return new SignJWT({ login: user.login })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey(env))
}

export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env), { algorithms: ['HS256'] })
    if (!payload.sub) return null
    return { sub: payload.sub, login: (payload.login as string) || '' }
  } catch {
    return null
  }
}

async function signState(env: Env): Promise<string> {
  return new SignJWT({ kind: 'oauth-state' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(secretKey(env))
}

async function verifyState(env: Env, state: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(state, secretKey(env), { algorithms: ['HS256'] })
    return payload.kind === 'oauth-state'
  } catch {
    return false
  }
}

// ── GitHub OAuth 流程 ──

export function githubLoginUrl(env: Env, origin: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID || '',
    redirect_uri: `${origin}/auth/github/callback`,
    scope: 'read:user',
  })
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

interface GithubUser {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'opencode-memory',
    },
  })
  if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`)
  return (await res.json()) as GithubUser
}

async function exchangeCode(env: Env, code: string, origin: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/auth/github/callback`,
    }),
  })
  const body = (await res.json()) as { access_token?: string; error?: string }
  if (!body.access_token) throw new Error(`GitHub code exchange failed: ${body.error || res.status}`)
  return body.access_token
}

function parseAllowlist(env: Env): string[] {
  return (env.OAUTH_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** allowlist 校验：配置了名单则严格匹配（id 或 login）；未配置则只允许首个注册用户认领 */
async function isAllowed(env: Env, githubUser: GithubUser): Promise<boolean> {
  const allowlist = parseAllowlist(env)
  if (allowlist.length === 0) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>()
    return (row?.count ?? 0) === 0
  }
  return allowlist.includes(String(githubUser.id)) || allowlist.includes(githubUser.login.toLowerCase())
}

export async function upsertUser(env: Env, githubUser: GithubUser): Promise<User> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, login, name, avatar_url, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET
       login = excluded.login,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       last_login_at = excluded.last_login_at`,
  )
    .bind(
      crypto.randomUUID(),
      githubUser.id,
      githubUser.login,
      githubUser.name,
      githubUser.avatar_url,
      now,
      now,
    )
    .run()

  const user = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?')
    .bind(githubUser.id)
    .first<User>()
  if (!user) throw new Error('User upsert failed')
  return user
}

export interface CallbackResult {
  /** 成功时为 "/"，失败时带 error 查询参数 */
  redirect: string
  setCookie?: string
}

/** OAuth 回调处理：state 校验 → 换 token → 拉取用户 → allowlist → 会话 cookie */
export async function handleGithubCallback(env: Env, code: string, state: string, stateCookie: string, origin: string): Promise<CallbackResult> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return { redirect: '/?error=oauth_not_configured' }
  }
  const stateOk = state && stateCookie && state === stateCookie && (await verifyState(env, state))
  if (!stateOk) {
    return { redirect: '/?error=bad_state' }
  }

  try {
    const accessToken = await exchangeCode(env, code, origin)
    const githubUser = await fetchGithubUser(accessToken)

    if (!(await isAllowed(env, githubUser))) {
      return { redirect: '/?error=not_allowed' }
    }

    const user = await upsertUser(env, githubUser)
    const session = await signSession(env, user)
    return {
      redirect: '/',
      setCookie: `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    }
  } catch (error) {
    console.error('[auth] github callback failed:', error instanceof Error ? error.message : error)
    return { redirect: '/?error=oauth_failed' }
  }
}

export { signState as signOAuthState, OAUTH_STATE_COOKIE as STATE_COOKIE }
