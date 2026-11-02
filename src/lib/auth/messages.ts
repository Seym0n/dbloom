/** Turns anything a server function or the WebAuthn ceremony throws into one localised message (FR-AUT-027). */
import { t, tDynamic } from '~/i18n'
import { parseAuthError, authErrorKey, type ParsedAuthError } from './errors'
import { PasskeyError } from './webauthn'

export type ShownError = { message: string; parsed: ParsedAuthError }

export function describeError(error: unknown): ShownError {
  if (error instanceof PasskeyError) {
    const key = error.kind === 'cancelled' ? 'auth.passkey.cancelled' : error.kind === 'unsupported' ? 'auth.passkey.unsupported' : 'auth.passkey.failed'
    return { message: t(key), parsed: { code: 'mfa_failed' } }
  }
  const parsed = parseAuthError(error)
  const values = { seconds: parsed.retryAfterSeconds ?? 0 }
  return { message: tDynamic(authErrorKey(parsed), 'auth.error.unknown', values), parsed }
}
