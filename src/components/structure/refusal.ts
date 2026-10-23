import { t, type MessageKey } from '~/i18n'

/** Codes the server puts in front of a refusal message (`code: message`), mapped to i18n strings. */
const KEYS: Record<string, MessageKey> = {
  stale_plan: 'structure.err.stalePlan',
  plan_expired: 'structure.err.planExpired',
  'read-only': 'structure.err.readOnly',
  'token-missing': 'structure.err.token',
  'token-invalid': 'structure.err.token',
  'token-expired': 'structure.err.tokenExpired',
  'token-used': 'structure.err.tokenUsed',
  system_schema: 'structure.err.systemSchema',
  'system-schema': 'structure.err.systemSchema',
  not_found: 'structure.err.notFound',
  kind_mismatch: 'structure.err.kindMismatch',
  timeout: 'structure.err.timeout',
  'invalid-timeout': 'structure.err.timeout',
}

/** Refusals after which a fresh preview from the current state is the way forward (FR-STR-012). */
const NEW_PREVIEW_CODES = new Set(['stale_plan', 'plan_expired', 'token-expired', 'token-used'])

export type Refusal = {
  code: string | null
  message: string
  offerNewPreview: boolean
  /** Offset into the submitted text, from a `code@offset: message` refusal. */
  at?: number
}

/**
 * Turns an error from the structure server functions into text for people: a known code gets a
 * translated string, any other `code: message` shows the message without the code, and an error
 * without a code shows its own text. The raw `code:` prefix never reaches the screen.
 */
export function describeRefusal(error: unknown): Refusal {
  const raw = error instanceof Error ? error.message : ''
  const match = /^([a-z][a-z_-]*)(?:@(\d+))?: ([\s\S]*)$/.exec(raw)
  if (!match)
    return { code: null, message: raw || t('structure.error.generic'), offerNewPreview: false }
  const [, code = '', atRaw, rest = ''] = match
  const key = KEYS[code]
  return {
    code,
    message: key ? t(key) : rest || t('structure.error.generic'),
    offerNewPreview: NEW_PREVIEW_CODES.has(code),
    ...(atRaw !== undefined ? { at: Number(atRaw) } : {}),
  }
}
