import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env, Variables } from '../types'
import { SESSION_COOKIE, verifySession } from './github'
import { verifyApiToken } from './tokens'

/**
 * 统一认证：API（Bearer Token）或 Web（会话 Cookie）二选一，
 * 都归一到 userId 注入上下文。
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const auth = c.req.header('Authorization')

  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    const result = await verifyApiToken(c.env, token)
    if (!result) throw new HTTPException(401, { message: 'Invalid or revoked API token' })

    c.set('userId', result.userId)
    c.set('authKind', 'token')
    // last_used_at 异步更新，不阻塞请求
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .bind(Date.now(), result.tokenId)
        .run()
        .catch(() => undefined),
    )
    return next()
  }

  const cookieHeader = c.req.header('Cookie') || ''
  const sessionToken = readCookie(cookieHeader, SESSION_COOKIE)
  if (sessionToken) {
    const session = await verifySession(c.env, sessionToken)
    if (!session) throw new HTTPException(401, { message: 'Session expired' })
    c.set('userId', session.sub)
    c.set('authKind', 'session')
    return next()
  }

  throw new HTTPException(401, { message: 'Unauthorized' })
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}
