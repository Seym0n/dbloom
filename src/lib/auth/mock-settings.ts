/**
 * Mock of the settings functions (SPEC/32). Built from the real registry (`AUTH_SETTINGS`, `SETTING_META`) with no `.env`:
 * the effective value is the stored one, else the built-in default. Stored values live in this tab's session storage.
 * Flags (`dbloom.authMock.flags`): `settings-locked` (locks `sessionsPerUser`), `maintenance-forced` (`.env` forces
 * maintenance on), `settings-audit-fail` (every write answers `settings_audit_unavailable`), `settings-stranded`
 * (narrowing `mfaFactors` or `primaryCredentials` would strand two users).
 */
import { AUTH_SETTINGS, MFA_SCOPES, type MaintenanceView, type SettingDescription, type SettingSourceLabel, type SettingSpec, type SettingValue } from '~/server/auth/types'
import { SETTING_META } from '~/server/auth/setting-meta'
import { isGuardedKey } from '~/server/settings-guard'
import type { PreviewAnswer, SettingsAnswer, SettingsRefusal } from '~/server/settings-service'
import type { AuthApi } from './api'

const STORE_KEY = 'dbloom.authMock.settings'
type Row = { value: SettingValue; updatedAt: number; updatedBy: string }
type Rows = Record<string, Row>

const read = (): Rows => {
  try {
    return JSON.parse(window.sessionStorage.getItem(STORE_KEY) ?? '{}') as Rows
  } catch {
    return {}
  }
}
const write = (rows: Rows) => {
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(rows))
  } catch {
    /* in-memory only */
  }
}

const SPECS = AUTH_SETTINGS as Record<string, SettingSpec<unknown>>
const refusal = (code: SettingsRefusal['code'], detail?: string, count?: number): { ok: false; error: SettingsRefusal } => ({
  ok: false,
  error: { code, ...(detail ? { detail } : {}), ...(count !== undefined ? { count } : {}) },
})
const rank = (scope: unknown) => MFA_SCOPES.indexOf(scope as (typeof MFA_SCOPES)[number])

type Deps = { flag: (name: string) => boolean; wait: <T>(v: T) => Promise<T>; needStepUp: () => void; who: () => string }

export type MockSite = { notice: string; banner: string; maintenance: MaintenanceView }

export function createMockSettings(d: Deps): { api: Pick<AuthApi, 'getSettings' | 'previewSetting' | 'setSetting' | 'resetSetting' | 'confirmPending' | 'cancelPending'>; site: () => MockSite } {
  const lockedKey = (key: string) => d.flag('settings-locked') && key === 'sessionsPerUser'
  const forcedKey = (key: string) => d.flag('maintenance-forced') && key === 'maintenanceOn'

  function describeAll(): SettingDescription[] {
    const rows = read()
    const out: SettingDescription[] = []
    for (const key of Object.keys(SPECS) as (keyof typeof AUTH_SETTINGS)[]) {
      const spec = SPECS[key]!
      if (spec.source === 'ui') continue
      const meta = SETTING_META[key]
      const row = rows[key]
      const parsed = row && spec.source !== 'env' && spec.schema.safeParse(row.value).success
      const locked = lockedKey(key)
      const forced = forcedKey(key)
      let effective = (parsed && !locked ? row!.value : spec.default) as SettingValue
      if (forced) effective = true
      let source: SettingSourceLabel
      if (forced) source = parsed && row!.value !== true ? 'limit' : 'env_default'
      else if (locked || !parsed || spec.source === 'env' || spec.source === 'wizard') source = 'built_in'
      else source = JSON.stringify(row!.value) === JSON.stringify(effective) ? 'ui_override' : 'limit'
      const limits: SettingDescription['limits'] = {}
      if (typeof spec.floor === 'number') limits.floor = spec.floor
      if (typeof spec.ceiling === 'number') limits.ceiling = spec.ceiling
      if (key === 'mfaScope') {
        limits.floor = 'none'
        limits.ceiling = 'all'
      }
      if (key === 'mfaFactors' || key === 'primaryCredentials') limits.envelope = spec.default as SettingValue[]
      out.push({
        key,
        st: spec.st,
        group: meta.group,
        kind: meta.kind,
        unit: meta.unit,
        factor: meta.factor,
        ...('choices' in meta && meta.choices ? { choices: meta.choices } : {}),
        stored: parsed ? row!.value : null,
        storedIgnored: !!row && !parsed && spec.source !== 'env',
        effective,
        source,
        limits,
        locked,
        guarded: isGuardedKey(key),
        pending: null,
        forced,
        editable: spec.source === 'ui_within_env' && !locked && !forced,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      })
    }
    return out
  }

  const find = (key: string) => describeAll().find((x) => x.key === key)

  /** Validated value, or the refusal. */
  function validate(desc: SettingDescription, value: unknown): { ok: true; value: SettingValue } | { ok: false; error: SettingsRefusal } {
    const { floor, ceiling, envelope } = desc.limits
    if (desc.kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      if (typeof floor === 'number' && value < floor) return refusal('settings_invalid', 'below_floor')
      if (typeof ceiling === 'number' && value > ceiling) return refusal('settings_invalid', 'above_ceiling')
    }
    const parsed = SPECS[desc.key]!.schema.safeParse(value)
    if (!parsed.success) return refusal('settings_invalid', 'type')
    if (desc.key === 'mfaScope' && rank(parsed.data) < rank(floor)) return refusal('settings_invalid', 'below_floor')
    if (Array.isArray(parsed.data) && envelope && parsed.data.some((x) => !envelope.includes(x as SettingValue))) return refusal('settings_invalid', 'outside_envelope')
    return { ok: true, value: parsed.data as SettingValue }
  }

  const narrows = (desc: SettingDescription, value: SettingValue) =>
    (desc.key === 'mfaFactors' || desc.key === 'primaryCredentials') && Array.isArray(value) && Array.isArray(desc.effective) && value.length < desc.effective.length
  const stranded = (desc: SettingDescription, value: SettingValue) => (d.flag('settings-stranded') && narrows(desc, value) ? 2 : 0)

  const site = (): MockSite => {
    const all = describeAll()
    const eff = (key: string) => all.find((x) => x.key === key)?.effective
    const on = eff('maintenanceOn') === true
    const ends = Number(eff('maintenanceEndsAt') ?? 0)
    const forced = d.flag('maintenance-forced')
    const active = forced || (on && (ends === 0 || ends > Date.now()))
    return {
      notice: String(eff('loginNotice') ?? ''),
      banner: String(eff('infoBanner') ?? ''),
      maintenance: { active, endsAt: active && !forced && ends > 0 ? ends : null },
    }
  }

  function change(key: string, value: unknown, basedOn: number | null, reset: boolean): SettingsAnswer {
    d.needStepUp()
    const desc = find(key)
    if (!desc) return refusal('settings_unknown')
    if (desc.locked || desc.forced || !desc.editable) return refusal('settings_locked', desc.locked ? 'locked' : desc.forced ? 'forced' : 'not_editable')
    if (basedOn !== desc.updatedAt) return refusal('settings_conflict')
    const rows = read()
    if (reset) {
      if (desc.updatedAt === null) return { ok: true, changed: false, updatedAt: null }
      if (d.flag('settings-audit-fail')) return refusal('settings_audit_unavailable')
      delete rows[key]
      write(rows)
      return { ok: true, changed: true, updatedAt: null }
    }
    const v = validate(desc, value)
    if (!v.ok) return v
    const count = stranded(desc, v.value)
    if (count > 0) return refusal('settings_strands_users', undefined, count)
    if (desc.stored !== null && JSON.stringify(desc.stored) === JSON.stringify(v.value)) return { ok: true, changed: false, updatedAt: desc.updatedAt }
    if (d.flag('settings-audit-fail')) return refusal('settings_audit_unavailable')
    const updatedAt = Math.max(Date.now(), (desc.updatedAt ?? 0) + 1)
    rows[key] = { value: v.value, updatedAt, updatedBy: d.who() }
    write(rows)
    return { ok: true, changed: true, updatedAt }
  }

  return {
    site,
    api: {
      getSettings: async () => d.wait({ settings: describeAll() }),
      previewSetting: async (key, value): Promise<PreviewAnswer> => {
        const desc = find(key)
        if (!desc) return d.wait(refusal('settings_unknown'))
        const v = validate(desc, value)
        return d.wait(v.ok ? { ok: true as const, strandedUsers: stranded(desc, v.value) } : v)
      },
      setSetting: async (key, value, basedOn) => d.wait(change(key, value, basedOn, false)),
      resetSetting: async (key, basedOn) => d.wait(change(key, undefined, basedOn, true)),
      // The mock never keeps a pending change yet (task 5 of SPEC/33 adds it): nothing to confirm or cancel.
      confirmPending: async () => d.wait(refusal('settings_no_pending')),
      cancelPending: async () => d.wait(refusal('settings_no_pending')),
    },
  }
}
