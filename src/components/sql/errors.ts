import { describeRefusal } from '~/components/structure/refusal'
import { t, type MessageKey } from '~/i18n'
import { isSessionEnded } from '~/lib/session-state'

const KEYS: Record<string, MessageKey> = {
  busy: 'sql.err.busy',
  sql_disabled: 'sql.err.disabled',
  'sql-disabled': 'sql.err.disabled',
  'unterminated-string': 'sql.err.unterminatedString',
  'unterminated-comment': 'sql.err.unterminatedComment',
  'multi-statement': 'sql.err.multi',
  'text-too-large': 'sql.err.tooLarge',
  'too-many-statements': 'sql.err.tooMany',
  bookmark_exists: 'sql.err.bookmarkExists',
  bookmark_limit: 'sql.err.bookmarkLimit',
  not_implemented: 'sql.err.notImplemented',
}

export type SqlRefusal = {
  code: string | null
  message: string
  /** Offset into the submitted text when the server named one (lexical errors). */
  at?: number
  sessionEnded: boolean
  /** A fresh run is the way forward (plan expired, token used). */
  retry: boolean
}

/**
 * Errors that are not a statement's own result: refusals (`code: message`), lexical errors before anything
 * ran, busy, disabled. A session that ended is reported as such so the caller hands it to session-state.
 */
export function describeSqlError(error: unknown): SqlRefusal {
  const sessionEnded = isSessionEnded(error)
  const base = describeRefusal(error)
  const key = base.code ? KEYS[base.code] : undefined
  const at = base.at
  return {
    code: base.code,
    message: key ? t(key) : base.message,
    ...(at !== undefined ? { at } : {}),
    sessionEnded,
    retry: base.offerNewPreview,
  }
}

/** True when the refusal says the connection or session is read-only. */
export const isReadOnlyCode = (code: string | null) => code === 'read-only'
