import { z } from 'zod'
import {
  PREFS_ANY_TARGET,
  PREFS_EXPORT_VERSION,
  PREFS_IMPORT_MAX_BYTES,
  prefsExportFile,
  type AuthUser,
  type importPrefsInput,
  type PrefDefinition,
  type PrefImportProblem,
  type PrefImportResult,
  type PrefsExportFile,
  type PrefsRegistry,
  type PrefsService,
} from '../types'
import type { PrefRow, PrefsBackend } from './backend'

/** Largest JSON text of one value, as in rows and io. */
export const PREF_VALUE_MAX_CHARS = 8192
/** Distinct target keys one owner may hold registry values for (bounds storage per account). */
export const PREFS_MAX_TARGETS = 200

export type PrefsErrorCode =
  | 'unknown-key'
  | 'invalid-value'
  | 'target-required'
  | 'target-forbidden'
  | 'too-many-targets'
  | 'save-failed'

/** Thrown by the preferences service; `code` is stable, `message` is neutral (never the stored value). */
export class PrefsServiceError extends Error {
  constructor(
    public readonly code: PrefsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PrefsServiceError'
  }
}

/** Reason tokens of `PrefImportProblem.reason` (the UI maps them to text). */
export const PREF_IMPORT_REASONS = [
  'invalid_file',
  'file_too_large',
  'unknown_key',
  'wrong_section',
  'invalid_value',
  'too_large',
  'too_many_targets',
] as const

export type PrefsServiceExt = Omit<PrefsService, 'export'> & {
  /** `user` is optional: the file carries no identity. */
  export(ownerKey: string, user?: AuthUser | null): PrefsExportFile
  /** Latest `updated_at` over the owner's registry values, or null (FR-CFG-095). */
  lastSavedAt(ownerKey: string): number | null
  /** Removes all rows of the owner, e.g. when the user is deleted. */
  deleteOwner(ownerKey: string): void
}

type Slot = { targetKey: string; scope: string; key: string }

export function createPrefsService(
  backend: PrefsBackend,
  registry: PrefsRegistry,
  now: () => number = Date.now,
): PrefsServiceExt {
  const slotOf = (d: PrefDefinition, targetKey: string | undefined): Slot | undefined => {
    const target = d.scope === 'user' ? PREFS_ANY_TARGET : targetKey
    if (target === undefined) return undefined
    return { targetKey: target, scope: d.storedAs?.scope ?? 'prefs', key: d.storedAs?.key ?? d.key }
  }


  /** Maps a stored row to its definition; user+target keys never match the user-wide target key and vice versa. */
  const byStored = () => {
    const m = new Map<string, PrefDefinition>()
    for (const d of registry.all()) {
      const s = slotOf(d, '')
      if (s) m.set(`${s.scope}\u0000${s.key}`, d)
    }
    return (r: PrefRow): PrefDefinition | undefined => {
      const d = m.get(`${r.scope}\u0000${r.key}`)
      if (!d) return undefined
      return (d.scope === 'user') === (r.targetKey === PREFS_ANY_TARGET) ? d : undefined
    }
  }

  /** Stored value that still passes the schema; a damaged or outdated value counts as absent (FR-UPD-004). */
  const valid = (d: PrefDefinition, r: PrefRow): { ok: true; value: unknown } | { ok: false } => {
    let json: unknown
    try {
      json = JSON.parse(r.value)
    } catch {
      return { ok: false }
    }
    const p = d.schema.safeParse(json)
    return p.success ? { ok: true, value: p.data } : { ok: false }
  }

  const check = (d: PrefDefinition, value: unknown): unknown => {
    const p = d.schema.safeParse(value)
    if (!p.success) throw new PrefsServiceError('invalid-value', 'Invalid value')
    if (JSON.stringify(p.data).length > PREF_VALUE_MAX_CHARS) throw new PrefsServiceError('invalid-value', 'Value too large')
    return p.data
  }

  const targetsOf = (rows: PrefRow[], lookup: (r: PrefRow) => PrefDefinition | undefined): Set<string> =>
    new Set(rows.filter((r) => r.targetKey !== PREFS_ANY_TARGET && lookup(r)).map((r) => r.targetKey))

  const stored = (ownerKey: string) => {
    const lookup = byStored()
    const out: { def: PrefDefinition; row: PrefRow; value: unknown }[] = []
    for (const row of backend.rows(ownerKey)) {
      const d = lookup(row)
      if (!d) continue
      const v = valid(d, row)
      if (v.ok) out.push({ def: d, row, value: v.value })
    }
    return out
  }

  return {
    get(ownerKey, targetKey) {
      const out: Record<string, unknown> = {}
      for (const d of registry.all()) if (d.scope === 'user' || targetKey !== undefined) out[d.key] = d.default
      for (const { def, row, value } of stored(ownerKey)) {
        if (def.scope === 'user' || row.targetKey === targetKey) out[def.key] = value
      }
      return out
    },

    set(ownerKey, key, value, targetKey) {
      const d = registry.get(key)
      if (!d) throw new PrefsServiceError('unknown-key', 'Unknown preference')
      if (d.scope === 'user' && targetKey !== undefined) throw new PrefsServiceError('target-forbidden', 'This preference is not per target')
      if (d.scope === 'user+target' && targetKey === undefined) throw new PrefsServiceError('target-required', 'This preference belongs to one target')
      const parsed = check(d, value)
      const slot = slotOf(d, targetKey)!
      try {
        backend.transaction(() => {
          if (slot.targetKey !== PREFS_ANY_TARGET) {
            const rows = backend.rows(ownerKey)
            const targets = targetsOf(rows, byStored())
            if (!targets.has(slot.targetKey) && targets.size >= PREFS_MAX_TARGETS) {
              throw new PrefsServiceError('too-many-targets', 'Too many targets')
            }
          }
          backend.put(ownerKey, { ...slot, value: JSON.stringify(parsed), updatedAt: now() })
        })
      } catch (error) {
        if (error instanceof PrefsServiceError) throw error
        throw new PrefsServiceError('save-failed', 'Preferences could not be saved')
      }
    },

    // The file never carries identity, secrets or factors, so the interface's `user` argument is unused.
    export(ownerKey): PrefsExportFile {
      const user: Record<string, unknown> = {}
      const targets: Record<string, Record<string, unknown>> = {}
      for (const { def, row, value } of stored(ownerKey)) {
        if (def.scope === 'user') user[def.key] = value
        else (targets[row.targetKey] ??= {})[def.key] = value
      }
      return { dbloomPreferences: PREFS_EXPORT_VERSION, exportedAt: new Date(now()).toISOString(), user, targets }
    },

    import(ownerKey, input: z.infer<typeof importPrefsInput>): PrefImportResult {
      const fail = (reason: (typeof PREF_IMPORT_REASONS)[number]): PrefImportResult => ({
        written: 0,
        skipped: 0,
        problems: [{ key: '', reason }],
      })
      if (Buffer.byteLength(input.json, 'utf8') > PREFS_IMPORT_MAX_BYTES) return fail('file_too_large')
      let raw: unknown
      try {
        raw = JSON.parse(input.json)
      } catch {
        return fail('invalid_file')
      }
      const file = prefsExportFile.safeParse(raw)
      if (!file.success) return fail('invalid_file')

      const problems: PrefImportProblem[] = []
      const good: { def: PrefDefinition; targetKey: string | undefined; value: unknown }[] = []
      let total = 0
      const consider = (key: string, value: unknown, targetKey: string | undefined) => {
        total++
        const problem = (reason: (typeof PREF_IMPORT_REASONS)[number]) =>
          problems.push(targetKey === undefined ? { key, reason } : { key, target: targetKey, reason })
        const d = registry.get(key)
        if (!d) return problem('unknown_key')
        if ((d.scope === 'user') !== (targetKey === undefined)) return problem('wrong_section')
        const p = d.schema.safeParse(value)
        if (!p.success) return problem('invalid_value')
        if (JSON.stringify(p.data).length > PREF_VALUE_MAX_CHARS) return problem('too_large')
        good.push({ def: d, targetKey, value: p.data })
      }
      for (const [k, v] of Object.entries(file.data.user)) consider(k, v, undefined)
      const lookup = byStored()
      const existing = input.mode === 'replace' ? new Set<string>() : targetsOf(backend.rows(ownerKey), lookup)
      for (const [target, values] of Object.entries(file.data.targets)) {
        if (!existing.has(target) && existing.size >= PREFS_MAX_TARGETS) {
          for (const k of Object.keys(values)) {
            total++
            problems.push({ key: k, target, reason: 'too_many_targets' })
          }
          continue
        }
        existing.add(target)
        for (const [k, v] of Object.entries(values)) consider(k, v, target)
      }

      if (problems.length > 0 && !input.validOnly) return { written: 0, skipped: total, problems }
      try {
        backend.transaction(() => {
          if (input.mode === 'replace') {
            for (const row of backend.rows(ownerKey)) {
              if (lookup(row)) backend.remove(ownerKey, row.targetKey, row.scope, row.key)
            }
          }
          const at = now()
          for (const g of good) {
            const slot = slotOf(g.def, g.targetKey)!
            backend.put(ownerKey, { ...slot, value: JSON.stringify(g.value), updatedAt: at })
          }
        })
      } catch {
        throw new PrefsServiceError('save-failed', 'Preferences could not be saved')
      }
      return { written: good.length, skipped: total - good.length, problems }
    },

    reset(ownerKey) {
      try {
        backend.removeOwner(ownerKey)
      } catch {
        throw new PrefsServiceError('save-failed', 'Preferences could not be saved')
      }
    },

    lastSavedAt(ownerKey) {
      const times = stored(ownerKey).map((s) => s.row.updatedAt)
      return times.length ? Math.max(...times) : null
    },

    deleteOwner(ownerKey) {
      backend.removeOwner(ownerKey)
    },
  }
}
