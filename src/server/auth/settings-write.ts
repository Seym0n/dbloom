/**
 * Admin write path of the settings (SPEC/32 FR-ASE-002, 003, 004, 008, 014): validated `set` and `reset`, audit row first,
 * conflict check, narrowing preview. Role and step-up are the service's job (`settings-service.ts`); the CLI uses the same
 * writer with its own audit function. A value outside its limits is refused here, never clamped (SEC-TGT-142); the
 * wizard's `write()` is a different path and keeps clamping.
 */
import { notifySettingsChanged } from '../settings-runtime'
import { computeSetting, createAuthSettingsResolver } from './settings'
import { AUTH_SETTINGS, MFA_SCOPES, type AccountStore, type AuthSettingKey, type SettingDescription } from './types'

export const SETTINGS_ERROR_CODES = ['settings_unknown', 'settings_locked', 'settings_invalid', 'settings_conflict', 'settings_strands_users', 'settings_audit_unavailable'] as const
export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number]

/** Refusal of a settings write. `detail` is a short reason for the page, never a stored value. `count` is set for `settings_strands_users`. */
export class SettingsError extends Error {
  constructor(
    readonly code: SettingsErrorCode,
    readonly detail?: string,
    readonly count?: number,
  ) {
    super(code)
    this.name = 'SettingsError'
  }
}

type AuditFields = Record<string, string | number | boolean | undefined>
export type SettingsAuditEvent = 'settings.change' | 'settings.reset'

export type SettingsWriterDeps = {
  store: AccountStore
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Required audit write: must throw when the row cannot be committed (then nothing is stored). */
  audit: (event: SettingsAuditEvent, fields: AuditFields) => void
  /** Called after a committed change; defaults to the process-wide cache invalidation. */
  changed?: () => void
}

export type SetResult = { changed: boolean; old: unknown; new: unknown; updatedAt: number | null }

export interface SettingsWriter {
  /** `basedOn` is the `updatedAt` of the row the caller saw (null = none stored). */
  set(key: string, value: unknown, basedOn: number | null, actor: string): SetResult
  reset(key: string, basedOn: number | null, actor: string): SetResult
  /** Active users that the change would newly leave without any allowed second factor or primary credential (0 for other keys). */
  preview(key: string, value: unknown): { strandedUsers: number }
}

const SPECS = AUTH_SETTINGS as Record<string, (typeof AUTH_SETTINGS)[AuthSettingKey]>
const isKey = (key: string): key is AuthSettingKey => Object.hasOwn(AUTH_SETTINGS, key)
const rank = (scope: unknown) => MFA_SCOPES.indexOf(scope as (typeof MFA_SCOPES)[number])
const text = (value: unknown) => JSON.stringify(value)

export function createSettingsWriter(deps: SettingsWriterDeps): SettingsWriter {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const { store } = deps
  const changed = deps.changed ?? notifySettingsChanged

  function describeKey(key: string): SettingDescription {
    if (!isKey(key)) throw new SettingsError('settings_unknown')
    const d = createAuthSettingsResolver(store, env).describe().find((x) => x.key === key)
    if (!d) throw new SettingsError('settings_unknown')
    return d
  }

  function editable(d: SettingDescription): void {
    if (d.locked) throw new SettingsError('settings_locked', 'locked')
    if (d.forced) throw new SettingsError('settings_locked', 'forced')
    if (!d.editable) throw new SettingsError('settings_locked', 'not_editable')
  }

  /** Schema and limits; the parsed value. */
  function validate(d: SettingDescription, value: unknown): unknown {
    const { floor, ceiling, envelope } = d.limits
    // Numbers are checked against the limits first so the page can say which edge was crossed.
    if (d.kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      if (typeof floor === 'number' && value < floor) throw new SettingsError('settings_invalid', 'below_floor')
      if (typeof ceiling === 'number' && value > ceiling) throw new SettingsError('settings_invalid', 'above_ceiling')
    }
    const parsed = SPECS[d.key]!.schema.safeParse(value)
    if (!parsed.success) throw new SettingsError('settings_invalid', 'type')
    const v: unknown = parsed.data
    if (d.key === 'mfaScope') {
      if (rank(v) < rank(floor)) throw new SettingsError('settings_invalid', 'below_floor')
    }
    if (Array.isArray(v)) {
      if (envelope && v.some((x) => !envelope.includes(x))) throw new SettingsError('settings_invalid', 'outside_envelope')
      if (d.key === 'mfaRoles' && Array.isArray(floor) && floor.some((x) => !v.includes(x))) throw new SettingsError('settings_invalid', 'below_floor')
    }
    return v
  }

  function stranded(key: AuthSettingKey, list: unknown, current: unknown): number {
    if (key !== 'mfaFactors' && key !== 'primaryCredentials') return 0
    if (!Array.isArray(list) || !Array.isArray(current)) return 0
    const kinds = (u: ReturnType<AccountStore['listUsers']>[number]): string[] =>
      key === 'mfaFactors'
        ? [...(u.factors.passkeys > 0 ? ['passkey'] : []), ...(u.factors.totp ? ['totp'] : [])]
        : [...(u.hasPassword ? ['password'] : []), ...(u.factors.passkeys > 0 ? ['passkey'] : [])]
    const lost = (u: ReturnType<AccountStore['listUsers']>[number], allowed: unknown[]) => {
      const have = kinds(u)
      return have.length > 0 && !have.some((k) => allowed.includes(k))
    }
    return store.listUsers().filter((u) => u.status === 'active' && lost(u, list) && !lost(u, current)).length
  }

  function preview(key: string, value: unknown) {
    const d = describeKey(key)
    const v = validate(d, value)
    return { strandedUsers: stranded(d.key, v, d.effective) }
  }

  const stamp = (previous: number | null) => Math.max(now(), (previous ?? 0) + 1)

  return {
    preview,

    set(key, value, basedOn, actor) {
      const d = describeKey(key)
      editable(d)
      if (basedOn !== d.updatedAt) throw new SettingsError('settings_conflict')
      const v = validate(d, value)
      const count = stranded(d.key, v, d.effective)
      if (count > 0) throw new SettingsError('settings_strands_users', undefined, count)
      if (d.stored !== null && text(d.stored) === text(v)) return { changed: false, old: d.effective, new: d.effective, updatedAt: d.updatedAt }
      const next = computeSetting(d.key, text(v), env).effective
      deps.audit('settings.change', { setting: d.key, old: text(d.effective), new: text(next), actor, stored: d.stored !== null })
      const row = { key: d.key, value: text(v), updatedAt: stamp(d.updatedAt), updatedBy: actor }
      store.setSetting(row)
      changed()
      return { changed: true, old: d.effective, new: next, updatedAt: row.updatedAt }
    },

    reset(key, basedOn, actor) {
      const d = describeKey(key)
      editable(d)
      if (basedOn !== d.updatedAt) throw new SettingsError('settings_conflict')
      if (d.updatedAt === null) return { changed: false, old: d.effective, new: d.effective, updatedAt: null }
      const next = computeSetting(d.key, undefined, env).effective
      deps.audit('settings.reset', { setting: d.key, old: text(d.effective), new: text(next), actor })
      store.deleteSetting(d.key)
      changed()
      return { changed: true, old: d.effective, new: next, updatedAt: null }
    },
  }
}
