import { redactFields } from '../log'

/** Stable short codes (`read-only`, `token-missing`, `ER_LOCK_DEADLOCK`) are not secrets even though the log redacts a field named `code`. */
const STABLE_CODE = /^(?:[a-z][a-z_-]{0,39}|[A-Z][A-Z0-9_]{0,39})$/
const CODE_FIELDS = ['code', 'errorCode'] as const

/**
 * Redaction of audit fields for every sink (SPEC/29 FR-AAU-011): the logger's rules (secret-named fields, `Bearer`
 * credentials, URL query values) plus a pass-through for short code fields. Returns a new object; undefined values stay out.
 */
export function redactAuditFields(fields: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if ((CODE_FIELDS as readonly string[]).includes(k) && typeof v === 'string' && STABLE_CODE.test(v)) kept[k] = v
    else rest[k] = v
  }
  return { ...redactFields(rest), ...kept }
}
