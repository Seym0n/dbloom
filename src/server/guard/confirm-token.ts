import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Statement, TokenClaims } from '../structure/types'
import { WriteGuardError } from './write-guard'

const MAX_CONSUMED = 10_000

/** SHA-256 over the SQL texts, each prefixed by its byte length, so concatenation cannot be ambiguous. */
export function hashStatements(statements: Statement[]): string {
  const h = createHash('sha256')
  const count = Buffer.alloc(4)
  count.writeUInt32BE(statements.length)
  h.update(count)
  for (const s of statements) {
    const bytes = Buffer.from(s.sql, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(bytes.length)
    h.update(len)
    h.update(bytes)
  }
  return h.digest('hex')
}

export type TokenIssuer = {
  issue(claims: TokenClaims): string
  verifyAndConsume(
    token: string | undefined,
    expected: Omit<TokenClaims, 'expiresAt'>,
    now?: number,
  ): void
  /** Number of remembered consumed token ids (for tests and monitoring). */
  consumedCount(): number
}

const b64 = (b: Buffer) => b.toString('base64url')

/** Canonical encoding: JSON array of fixed order and type; the MAC covers exactly these bytes. */
function encode(c: TokenClaims, nonce: string): string {
  return b64(
    Buffer.from(
      JSON.stringify([1, c.sessionId, c.target, c.planId, c.statementsHash, c.expiresAt, nonce]),
      'utf8',
    ),
  )
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Confirmation token for hard statements (SEC-TGT-118): HMAC-SHA256, single use, bound to the plan. */
export function createTokenIssuer(secret: Buffer = randomBytes(32)): TokenIssuer {
  const consumed = new Map<string, number>() // nonce -> expiresAt, insertion ordered
  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest()

  const purge = (now: number) => {
    for (const [nonce, exp] of consumed) if (exp <= now) consumed.delete(nonce)
    while (consumed.size > MAX_CONSUMED) {
      const oldest = consumed.keys().next()
      if (oldest.done) break
      consumed.delete(oldest.value)
    }
  }

  return {
    issue(claims) {
      const payload = encode(claims, b64(randomBytes(16)))
      return `${payload}.${b64(mac(payload))}`
    },

    verifyAndConsume(token, expected, now = Date.now()) {
      if (!token) throw new WriteGuardError('token-missing', 'A confirmation is required.')
      const invalid = () => new WriteGuardError('token-invalid', 'The confirmation is not valid.')
      const parts = token.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid()
      const [payload, sig] = parts as [string, string]
      const given = Buffer.from(sig, 'base64url')
      const want = mac(payload)
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw invalid()

      let f: unknown
      try {
        f = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      } catch {
        throw invalid()
      }
      if (
        !Array.isArray(f) ||
        f.length !== 7 ||
        f[0] !== 1 ||
        typeof f[1] !== 'string' ||
        typeof f[2] !== 'string' ||
        typeof f[3] !== 'string' ||
        typeof f[4] !== 'string' ||
        typeof f[5] !== 'number' ||
        typeof f[6] !== 'string'
      ) {
        throw invalid()
      }
      const [, sessionId, target, planId, statementsHash, expiresAt, nonce] = f as [
        number,
        string,
        string,
        string,
        string,
        number,
        string,
      ]
      if (now >= expiresAt) throw new WriteGuardError('token-expired', 'The confirmation expired.')
      const ok =
        same(sessionId, expected.sessionId) &&
        same(target, expected.target) &&
        same(planId, expected.planId) &&
        same(statementsHash, expected.statementsHash)
      if (!ok) throw invalid()

      purge(now)
      if (consumed.has(nonce)) {
        throw new WriteGuardError('token-used', 'The confirmation was already used.')
      }
      consumed.set(nonce, expiresAt)
      purge(now)
    },

    consumedCount: () => consumed.size,
  }
}
