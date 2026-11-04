/**
 * Per-conversation token map (SPEC/34 FR-AST-007, FR-AST-010). A PII value becomes `<label:epoch:n>`; the same value in
 * the same label group always gets the same token. The map lives in memory only and is never stored or logged. The random
 * `epoch` of a map means a token of an earlier map can never be mistaken for a token of this one.
 */
import { randomBytes } from 'node:crypto'
import { tokenize } from '~/lib/sql/lexer'
import type { Cell } from '~/server/db/rows'

export const TOKEN_PATTERN = /<([a-z][a-z0-9_]{0,31}):([a-z0-9]{4}):(\d{1,6})>/g
const TOKEN_ONE = /^<([a-z][a-z0-9_]{0,31}):([a-z0-9]{4}):(\d{1,6})>$/

export type DetokenizeResult =
  | { ok: true; sql: string; substituted: number }
  | {
      ok: false
      reason: 'token-unknown' | 'token-embedded' | 'token-value-unsafe' | 'unterminated'
      token?: string
    }

export type TokenMap = {
  readonly epoch: string
  /** Token for a non-null cell value of a PII column group. */
  tokenFor(label: string, cell: Exclude<Cell, null>): string
  isIssued(token: string): boolean
  valueOf(token: string): string | undefined
  /** Replaces the tokens of this map inside string literals of `sql` (whole literal only) with their values. */
  detokenizeSql(sql: string): DetokenizeResult
  /** Replaces issued tokens in model text with their values, for the screen only. */
  revealText(text: string): string
}

/** Column name to a token label: lower case letters, digits, underscore; starts with a letter. */
export function labelOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (s === '') return 'pii'
  const withLetter = /^[a-z]/.test(s) ? s : `c_${s}`
  return withLetter.slice(0, 32).replace(/_+$/g, '') || 'pii'
}

/** What a cell stands for as one string; two cells with the same string get the same token. */
export function cellKey(cell: Exclude<Cell, null>): string {
  if (typeof cell === 'string') return cell
  if ('cut' in cell) return `${cell.cut}\u0000cut:${cell.length}`
  return `\u0000binary:${cell.size}:${cell.binary}`
}

/** The text of a cell as the user's own value; used for substitution and the screen. */
export function cellText(cell: Exclude<Cell, null>): string {
  if (typeof cell === 'string') return cell
  if ('cut' in cell) return cell.cut
  return cell.binary
}

/** Characters that need escaping beyond quote doubling; such values are never put into SQL text. */
const UNSAFE_VALUE = /[\\\u0000\n\r\u001a]/

export function createTokenMap(epoch = randomBytes(3).toString('hex').slice(0, 4)): TokenMap {
  const byKey = new Map<string, string>()
  const values = new Map<string, string>()
  const counters = new Map<string, number>()

  const tokenFor: TokenMap['tokenFor'] = (label, cell) => {
    const key = `${label}\u0001${cellKey(cell)}`
    const known = byKey.get(key)
    if (known) return known
    const n = (counters.get(label) ?? 0) + 1
    counters.set(label, n)
    const token = `<${label}:${epoch}:${n}>`
    byKey.set(key, token)
    values.set(token, cellText(cell))
    return token
  }

  const detokenizeSql: TokenMap['detokenizeSql'] = (sql) => {
    const { tokens, errors } = tokenize(sql)
    if (errors.length > 0) return { ok: false, reason: 'unterminated' }
    let out = ''
    let substituted = 0
    for (const t of tokens) {
      const text = sql.slice(t.start, t.end)
      if (t.type !== 'string') {
        const hit = t.type === 'quotedIdent' ? text.match(TOKEN_PATTERN) : null
        if (hit) return { ok: false, reason: 'token-embedded', token: hit[0] }
        out += text
        continue
      }
      const quote = text[0]!
      const inner = text.slice(1, -1)
      const matches = inner.match(TOKEN_PATTERN)
      if (!matches) {
        out += text
        continue
      }
      if (!TOKEN_ONE.test(inner)) return { ok: false, reason: 'token-embedded', token: matches[0] }
      const value = values.get(inner)
      if (value === undefined) return { ok: false, reason: 'token-unknown', token: inner }
      if (UNSAFE_VALUE.test(value)) return { ok: false, reason: 'token-value-unsafe', token: inner }
      out += `${quote}${value.split(quote).join(quote + quote)}${quote}`
      substituted++
    }
    return { ok: true, sql: out, substituted }
  }

  return {
    epoch,
    tokenFor,
    isIssued: (token) => values.has(token),
    valueOf: (token) => values.get(token),
    detokenizeSql,
    revealText: (text) => text.replace(TOKEN_PATTERN, (m) => values.get(m) ?? m),
  }
}
