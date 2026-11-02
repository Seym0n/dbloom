/**
 * Error transport of the auth server functions. A failure arrives as an `Error` whose message is a JSON body
 * `{code, reason?, retryAfterSeconds?, targetMessage?}`, or (older functions) the bare code, `auth_throttled:<seconds>`,
 * or a bare `Response` (setup functions: 404 gone, 401 no setup session, 409 wrong step). Parsing never throws.
 */
import { AUTH_ERROR_CODES, PASSWORD_REJECT_REASONS, TARGET_POLICY_REASONS, type AuthErrorCode } from '~/server/auth/types'
import { SESSION_ENDED } from '~/lib/csrf'

export type ParsedAuthError = {
  /** A code of the closed list, or a transport class (`session_ended`, `gone`, `setup_session`, `setup_step`, `unknown`). */
  code: AuthErrorCode | 'session_ended' | 'gone' | 'setup_session' | 'setup_step' | 'totp_invalid' | 'unknown'
  reason?: string
  retryAfterSeconds?: number
  targetMessage?: string
}

const CODES = new Set<string>(AUTH_ERROR_CODES)
const REASONS = new Set<string>([...PASSWORD_REJECT_REASONS, ...TARGET_POLICY_REASONS])

const positive = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined

function fromBody(body: unknown): ParsedAuthError | undefined {
  if (!body || typeof body !== 'object') return undefined
  const { code, reason, retryAfterSeconds, targetMessage } = body as Record<string, unknown>
  if (typeof code !== 'string' || !CODES.has(code)) return undefined
  const seconds = positive(retryAfterSeconds)
  return {
    code: code as AuthErrorCode,
    ...(typeof reason === 'string' && REASONS.has(reason) ? { reason } : {}),
    ...(seconds ? { retryAfterSeconds: seconds } : {}),
    ...(typeof targetMessage === 'string' ? { targetMessage } : {}),
  }
}

export function parseAuthError(error: unknown): ParsedAuthError {
  if (typeof Response !== 'undefined' && error instanceof Response) {
    if (error.status === 404) return { code: 'gone' }
    if (error.status === 401) return { code: 'setup_session' }
    if (error.status === 409) return { code: 'setup_step' }
    return { code: 'unknown' }
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!message) return { code: 'unknown' }
  if (message.includes(SESSION_ENDED)) return { code: 'session_ended' }
  const trimmed = message.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = fromBody(JSON.parse(trimmed))
      if (parsed) return parsed
    } catch {
      /* fall through to the plain forms */
    }
  }
  const [head, tail] = trimmed.split(':')
  if (head === 'totp_invalid') return { code: 'totp_invalid' }
  if (head && CODES.has(head)) {
    const seconds = positive(Number(tail))
    return { code: head as AuthErrorCode, ...(seconds ? { retryAfterSeconds: seconds } : {}) }
  }
  return { code: 'unknown' }
}

/** Thrown by the client wrappers whose server function does not exist yet. */
export class AuthApiUnavailable extends Error {
  constructor(public readonly fn: string) {
    super(`unavailable:${fn}`)
    this.name = 'AuthApiUnavailable'
  }
}

/** i18n key of an error, picking the reason-specific text when there is one (password forms, target policy). */
export function authErrorKey(error: ParsedAuthError): string {
  if (error.code === 'password_rejected' && error.reason) return `auth.error.password_rejected.${error.reason}`
  if (error.code === 'target_policy' && error.reason) return `auth.error.target_policy.${error.reason}`
  return `auth.error.${error.code}`
}
