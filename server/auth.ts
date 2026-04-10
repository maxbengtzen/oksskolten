import type { FastifyRequest, FastifyReply } from 'fastify'
import { getDb } from './db.js'
import { validateApiKey } from './db/apiKeys.js'

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: string
    apiKeyScopes?: string
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (process.env.AUTH_DISABLED === '1') {
    request.authUser = 'local'
    return
  }

  // Check for API key authentication (Bearer ok_...)
  const authHeader = request.headers.authorization
  if (authHeader?.startsWith('Bearer ok_')) {
    const key = authHeader.slice(7) // strip "Bearer "
    const result = validateApiKey(key)
    if (!result) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }
    request.authUser = `apikey:${result.id}`
    request.apiKeyScopes = result.scopes
    return
  }

  try {
    await request.jwtVerify()
    const { email, token_version } = request.user as { email: string; token_version: number }

    const db = getDb()
    const user = db.prepare('SELECT token_version FROM users WHERE email = ?').get(email) as
      | { token_version: number }
      | undefined

    if (!user || user.token_version !== token_version) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    request.authUser = email
  } catch {
    reply.status(401).send({ error: 'Unauthorized' })
  }
}

export function getAuthUser(request: FastifyRequest): string | null {
  return request.authUser ?? null
}

/**
 * Pre-handler that blocks API key requests without write scope on mutation methods.
 * JWT users (no apiKeyScopes) pass through unrestricted.
 */
export function requireWriteScope(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (
    request.apiKeyScopes &&
    request.method !== 'GET' &&
    !request.apiKeyScopes.includes('write')
  ) {
    reply.status(403).send({ error: 'API key does not have write scope' })
    return
  }
  done()
}

// --- Request origin helpers ---

type HeadersLike = { headers: Record<string, string | string[] | undefined> }

export function getOrigin(request: HeadersLike): string {
  const origin = request.headers['origin'] as string | undefined
  if (origin) return origin
  const referer = request.headers['referer'] as string | undefined
  if (referer) {
    try { return new URL(referer).origin } catch { /* fall through */ }
  }
  const proto = (request.headers['x-forwarded-proto'] as string) || 'http'
  const host = (request.headers['host'] as string) || 'localhost'
  return `${proto}://${host}`
}

export function getRpID(request: HeadersLike): string {
  const origin = request.headers['origin'] as string | undefined
  if (origin) {
    try { return new URL(origin).hostname } catch { /* fall through */ }
  }
  const referer = request.headers['referer'] as string | undefined
  if (referer) {
    try { return new URL(referer).hostname } catch { /* fall through */ }
  }
  const host = (request.headers['host'] as string) || 'localhost'
  return host.split(':')[0]
}

export function getCredentialCount(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM credentials').get() as { cnt: number }
  return row.cnt
}

export function requireJson(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const ct = request.headers['content-type'] || ''
  if (!ct.startsWith('application/json')) {
    reply.status(415).send({ error: 'Unsupported Media Type' })
    return
  }
  done()
}

/**
 * Resolve the email address for the currently authenticated user.
 * - JWT users: authUser is the email directly.
 * - API key users: authUser is `apikey:<id>`, fall back to the single DB user.
 * - AUTH_DISABLED: authUser is `local`, fall back to the single DB user.
 * Returns null when no user exists in the database.
 */
export function getAuthUserEmail(request: FastifyRequest): string | null {
  const authUser = request.authUser
  if (authUser?.includes('@')) return authUser
  // For API key auth and AUTH_DISABLED, look up the only user in the DB
  const db = getDb()
  const row = db.prepare('SELECT email FROM users LIMIT 1').get() as { email: string } | undefined
  return row?.email ?? null
}
