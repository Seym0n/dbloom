/** Pure logic of the account pages (SPEC/26 5.10): preference field metadata, grouping, parsing and small formatters. */
import { parseAuthError } from './errors'
import type { FactorsInfo } from './api'
import type { PrefImportProblem, StepUpMethod } from '~/server/auth/types'

// ---- Preferences ----------------------------------------------------------------------------------------------

export type PrefKind = 'select' | 'boolean' | 'integer' | 'number' | 'text' | 'nullable-text' | 'tags' | 'json'
/** Categories of the Preferences page (FR-CFG-096); `manage` is the export, import and reset block. */
export const PREF_CATEGORIES_SHOWN = ['features', 'navigation', 'sql', 'main', 'export', 'import'] as const
export type PrefCategoryKey = (typeof PREF_CATEGORIES_SHOWN)[number]

export type PrefMeta = { kind: PrefKind; category: PrefCategoryKey; options?: readonly string[]; min?: number; max?: number }

const m = (category: PrefCategoryKey, kind: PrefKind, extra: Omit<PrefMeta, 'kind' | 'category'> = {}): PrefMeta => ({ kind, category, ...extra })

/** Static knowledge of every key in the registry (`src/server/auth/prefs/registry.ts`); the server validates every value again. */
export const PREF_META: Record<string, PrefMeta> = {
  theme: m('features', 'select', { options: ['system', 'light', 'dark'] }),
  language: m('features', 'select', { options: ['en'] }),
  loginLanding: m('features', 'boolean'),
  collation: m('features', 'nullable-text'),
  navWidth: m('navigation', 'integer', { min: 160, max: 800 }),
  hiddenDatabases: m('navigation', 'tags'),
  'rows.pageSize': m('main', 'integer', { min: 1 }),
  'rows.displayChars': m('main', 'integer', { min: 1 }),
  'rows.fullText': m('main', 'boolean'),
  'rows.protectBinary': m('main', 'boolean'),
  'rows.relationMode': m('main', 'text'),
  'rows.fkDisplay': m('main', 'json'),
  'rows.defaultStringOperator': m('main', 'text'),
  'rows.gridEditing': m('main', 'boolean'),
  'rows.insertRows': m('main', 'integer', { min: 1 }),
  'rows.countThreshold': m('main', 'integer', { min: 0 }),
  'io.exportFormat': m('export', 'select', { options: ['sql', 'csv', 'json'] }),
  'io.exportCompression': m('export', 'select', { options: ['none', 'gzip', 'zip'] }),
  'io.importFormat': m('import', 'select', { options: ['sql', 'csv', 'json'] }),
  'io.mode': m('export', 'text'),
  'io.fileName.server': m('export', 'text'),
  'io.fileName.database': m('export', 'text'),
  'io.fileName.table': m('export', 'text'),
  'io.fileName.result': m('export', 'text'),
  'io.options.sql': m('export', 'json'),
  'io.options.csv': m('export', 'json'),
  'io.options.json': m('export', 'json'),
  'io.lastExport': m('export', 'json'),
  'io.lastImport': m('import', 'json'),
  'io.uploadMiB': m('import', 'number', { min: 0 }),
  'io.decompressedMiB': m('import', 'number', { min: 0 }),
  'io.jobSeconds': m('import', 'number', { min: 0 }),
  'io.maxExportMiB': m('export', 'number', { min: 0 }),
  'io.concurrentImports': m('import', 'integer', { min: 1 }),
  'io.formats': m('export', 'tags'),
  'io.compressions': m('export', 'tags'),
  'io.serverFolder': m('import', 'boolean'),
  'io.formulaNeutralisation': m('export', 'boolean'),
  'io.dragDrop': m('import', 'boolean'),
}

/** Keys the registry has today, in display order; the page also shows keys a newer server adds (kind from the value). */
export const PREF_KEYS_KNOWN = Object.keys(PREF_META)

/** Metadata of a key; an unknown key gets a kind from the type of its current value. */
export function prefMeta(key: string, sample: unknown): PrefMeta {
  const known = PREF_META[key]
  if (known) return known
  if (typeof sample === 'boolean') return m('main', 'boolean')
  if (typeof sample === 'number') return m('main', 'number')
  if (typeof sample === 'string') return m('main', 'text')
  if (Array.isArray(sample) && sample.every((x) => typeof x === 'string')) return m('main', 'tags')
  return m('main', 'json')
}

/** The keys of `values` by category, known keys in registry order first, then newer ones by name. */
export function groupPrefs(values: Record<string, unknown>): { category: PrefCategoryKey; keys: string[] }[] {
  const keys = Object.keys(values)
  const order = (k: string) => {
    const i = PREF_KEYS_KNOWN.indexOf(k)
    return i < 0 ? PREF_KEYS_KNOWN.length : i
  }
  keys.sort((a, b) => order(a) - order(b) || a.localeCompare(b))
  return PREF_CATEGORIES_SHOWN.map((category) => ({
    category,
    keys: keys.filter((k) => prefMeta(k, values[k]).category === category),
  })).filter((g) => g.keys.length > 0)
}

/** Key of the target a preference belongs to, as the server derives it from the session (`host:port|user`). */
export const targetKeyOf = (target: { host: string; port: number; user: string }): string => `${target.host.toLowerCase()}:${target.port}|${target.user}`

/** Splits a comma or line separated list, trims, drops empty entries and duplicates. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[\n,]/)) {
    const v = part.trim()
    if (v) seen.add(v)
  }
  return [...seen]
}

export type DraftResult = { ok: true; value: unknown } | { ok: false; reason: 'empty' | 'number' | 'range' | 'json' }

/** Turns the text of an input into the value to save; `reason` is a message of the field, the server checks the rest. */
export function parseDraft(meta: PrefMeta, draft: string): DraftResult {
  switch (meta.kind) {
    case 'integer':
    case 'number': {
      const text = draft.trim()
      if (text === '') return { ok: false, reason: 'empty' }
      const n = Number(text)
      if (!Number.isFinite(n) || (meta.kind === 'integer' && !Number.isInteger(n))) return { ok: false, reason: 'number' }
      if ((meta.min !== undefined && n < meta.min) || (meta.max !== undefined && n > meta.max)) return { ok: false, reason: 'range' }
      return { ok: true, value: n }
    }
    case 'tags':
      return { ok: true, value: parseTags(draft) }
    case 'nullable-text':
      return { ok: true, value: draft.trim() === '' ? null : draft.trim() }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(draft) as unknown }
      } catch {
        return { ok: false, reason: 'json' }
      }
    default:
      return { ok: true, value: draft }
  }
}

/** Text an input starts with for a stored value. */
export function toDraft(meta: PrefMeta, value: unknown): string {
  if (value === null || value === undefined) return ''
  switch (meta.kind) {
    case 'tags':
      return Array.isArray(value) ? value.join(', ') : ''
    case 'json':
      return JSON.stringify(value, null, 2)
    default:
      return String(value)
  }
}

export type SaveProblem = 'invalid' | 'save' | 'ended' | 'other'

/** Prefs server functions throw `<code>: <message>`; session loss is the shared transport marker. */
export function saveProblem(error: unknown): SaveProblem {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (message.startsWith('invalid-value')) return 'invalid'
  if (message.startsWith('save-failed')) return 'save'
  if (parseAuthError(error).code === 'session_ended') return 'ended'
  return 'other'
}

/** Reasons of `PrefImportProblem` (`PREF_IMPORT_REASONS` in the server service) and the message key of each. */
export const IMPORT_REASONS = ['invalid_file', 'file_too_large', 'unknown_key', 'wrong_section', 'invalid_value', 'too_large', 'too_many_targets'] as const
export function importReasonKey(problem: Pick<PrefImportProblem, 'reason'>): string {
  return (IMPORT_REASONS as readonly string[]).includes(problem.reason) ? `account.import.reason.${problem.reason}` : 'account.import.reason.invalid_value'
}

/** Largest preferences file the server reads (`PREFS_IMPORT_MAX_BYTES`, 256 KiB). */
export const IMPORT_MAX_BYTES = 256 * 1024

// ---- Security ---------------------------------------------------------------------------------------------------

export const isStepUpRequired = (error: unknown): boolean => parseAuthError(error).code === 'stepup_required'

/** Step-up methods the user can answer: a registered passkey, TOTP, else the password (FR-AUT-013). */
export function stepUpMethods(factors: Pick<FactorsInfo, 'passkeys' | 'totp'>): StepUpMethod[] {
  const out: StepUpMethod[] = []
  if (factors.passkeys.length > 0) out.push('passkey')
  if (factors.totp) out.push('totp')
  return out.length > 0 ? out : ['password']
}

/** Recovery codes left: a warning at 2 or fewer (FR-AUT-010). */
export const recoveryLevel = (count: number): 'none' | 'low' | 'ok' => (count <= 0 ? 'none' : count <= 2 ? 'low' : 'ok')

/** True when removing this factor leaves the account without any (the server may refuse it). */
export const isLastFactor = (factors: Pick<FactorsInfo, 'passkeys' | 'totp'>): boolean => factors.passkeys.length + (factors.totp ? 1 : 0) <= 1

export type When = { unit: 'now' | 'minute' | 'hour' | 'day' | 'date'; n: number }

/** Age of a timestamp as a unit and a count; anything older than 7 days is a date. */
export function relativeWhen(ts: number, now: number): When {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return { unit: 'now', n: 0 }
  if (minutes < 60) return { unit: 'minute', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hour', n: hours }
  const days = Math.floor(hours / 24)
  if (days < 7) return { unit: 'day', n: days }
  return { unit: 'date', n: ts }
}

/** Short absolute date, ISO form, for rows that are compared. */
export const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/** Registry keys with scope `user` (everything else is per target and needs a connection). */
export const PREF_USER_SCOPED: ReadonlySet<string> = new Set(['theme', 'language', 'loginLanding', 'navWidth'])
export const isUserScoped = (key: string): boolean => PREF_USER_SCOPED.has(key)

export const THEME_STORAGE_KEY = 'dbloom.theme'

/** Applies the theme choice at once; `system` leaves the decision to the media query. */
export function applyTheme(value: unknown, root: { dataset: DOMStringMap } = document.documentElement): void {
  if (value === 'light' || value === 'dark') root.dataset.theme = value
  else delete root.dataset.theme
  // The head script of the root route reads this before the first paint of the next load (per-viewer convenience only).
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_STORAGE_KEY, value === 'light' || value === 'dark' ? value : 'system')
  } catch {
    // storage blocked: the theme is applied again after the session info arrives
  }
}
