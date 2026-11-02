/**
 * One error transport for every auth server function (SPEC/26 section 5.9): the `Error` message is the JSON of
 * `AuthErrorBody` ({ code, reason?, retryAfterSeconds?, targetMessage? }); the HTTP status is fixed per class
 * (429 + Retry-After, 403 stepup_required, 401 everything else) so the client never learns more from the status.
 */
import { setResponseHeader, setResponseStatus } from '@tanstack/react-start/server'
import { audit } from '../audit'
import { AuthError, type AuthErrorBody, type AuthErrorCode } from './types'

/** Pure part: body and status of an error; `undefined` for a non-`AuthError` without fallback. */
export function authErrorResponse(error: unknown, fallback?: AuthErrorCode): { body: AuthErrorBody; status: 401 | 403 | 429 } | undefined {
  if (!(error instanceof AuthError) && !fallback) return undefined
  const body: AuthErrorBody = error instanceof AuthError ? { code: error.code, ...error.detail } : { code: fallback! }
  if (body.code === 'auth_throttled') body.retryAfterSeconds ??= 1
  const status = body.code === 'auth_throttled' ? 429 : body.code === 'stepup_required' ? 403 : 401
  return { body, status }
}

/** Sets status and `Retry-After`, then throws `Error(JSON.stringify(body))`. Other errors without fallback pass unchanged. */
export function throwAuthError(error: unknown, fallback?: AuthErrorCode): never {
  const response = authErrorResponse(error, fallback)
  if (!response) throw error
  if (!(error instanceof AuthError)) audit('auth.error', { reason: error instanceof Error ? error.name : 'unknown' })
  setResponseStatus(response.status)
  if (response.status === 429) setResponseHeader('Retry-After', String(response.body.retryAfterSeconds))
  throw new Error(JSON.stringify(response.body))
}
