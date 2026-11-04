/**
 * Mock of the settings functions (SPEC/32). Built from the real registry (`AUTH_SETTINGS`, `SETTING_META`) with no `.env`:
 * the effective value is the stored one, else the built-in default. Stored values live in this tab's session storage.
 * Flags (`dbloom.authMock.flags`): `settings-locked` (locks `sessionsPerUser`), `maintenance-forced` (`.env` forces
 * maintenance on), `settings-audit-fail` (every write answers `settings_audit_unavailable`), `settings-stranded`
 * (narrowing `mfaFactors` or `primaryCredentials` would strand two users). A change to a guarded key (SPEC/33) applies at
 * once and reverts after the deadline (`dbloom.authMock.revertMs`, default 5 minutes) unless confirmed by a session that
 * signed in after the change.
 */
import { AUTH_SETTINGS, MFA_SCOPES, type MaintenanceView, type SettingDescription, type SettingSourceLabel, type SettingSpec, type SettingValue } from '~/server/auth/types'
import { SETTING_META } from '~/server/auth/setting-meta'
import { isGuardedKey } from '~/server/settings-guard'
import type { PreviewAnswer, SettingsAnswer, SettingsRefusal } from '~/server/settings-service'
import type { AuthApi } from './api'

const STORE_KEY = 'dbloom.authMock.settings'
type Row = { value: SettingValue; updatedAt: number; updatedBy: string }
type Rows = Record<string, Row>
const PENDING_KEY = 'dbloom.authMock.pending'
type Pending = { revertTo: Row | null; newValue: SettingValue; newUpdatedAt: number | null; createdAt: number; deadlineAt: number; actor: string }
type PendingRows = Record<string, Pending>
const readPending = (): PendingRows => {
  try {
    return JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? '{}') as PendingRows
  } catch {
    return {}
  }
}
const writePending = (rows: PendingRows) => {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(rows))
  } catch {
    /* in-memory only */
  }
}
const revertMs = () => {
  try {
    return Number(window.sessionStorage.getItem('dbloom.authMock.revertMs')) || 5 * 60_000
  } catch {
    return 5 * 60_000
  }
}

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

type Deps = { flag: (name: string) => boolean; wait: <T>(v: T) => Promise<T>; needStepUp: () => void; who: () => string; sessionStart: () => number }

export type MockSite = { notice: string; banner: string; maintenance: MaintenanceView }

export function createMockSettings(d: Deps): { api: Pick<AuthApi, 'getSettings' | 'previewSetting' | 'setSetting' | 'resetSetting' | 'confirmPending' | 'cancelPending'>; site: () => MockSite } {
  const lockedKey = (key: string) => d.flag('settings-locked') && key === 'sessionsPerUser'
  const forcedKey = (key: string) => d.flag('maintenance-forced') && key === 'maintenanceOn'

  /** Puts a pending change back (or drops it when another write came after it). */
  function settle(key: string, p: Pending) {
    const rows = read()
    if ((rows[key]?.updatedAt ?? null) === p.newUpdatedAt) {
      if (p.revertTo) rows[key] = p.revertTo
      else delete rows[key]
      write(rows)
    }
    const pending = readPending()
    delete pending[key]
    writePending(pending)
  }
  function sweep() {
    for (const [key, p] of Object.entries(readPending())) if (p.deadlineAt <= Date.now()) settle(key, p)
  }

  function describeAll(): SettingDescription[] {
    sweep()
    const rows = read()
    const pendingRows = readPending()
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
        pending: pendingRows[key] ? { newValue: pendingRows[key]!.newValue, deadlineAt: pendingRows[key]!.deadlineAt, actor: pendingRows[key]!.actor } : null,
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
    const arm = (newValue: SettingValue, newUpdatedAt: number | null, before: Row | null) => {
      if (!desc.guarded) return
      const pending = readPending()
      const kept = pending[key]
      pending[key] = { revertTo: kept ? kept.revertTo : before, newValue, newUpdatedAt, createdAt: kept ? kept.createdAt : Date.now(), deadlineAt: Date.now() + revertMs(), actor: d.who() }
      writePending(pending)
    }
    if (reset) {
      if (desc.updatedAt === null) return { ok: true, changed: false, updatedAt: null }
      if (d.flag('settings-audit-fail')) return refusal('settings_audit_unavailable')
      const before = rows[key] ?? null
      delete rows[key]
      write(rows)
      arm(SPECS[key]!.default as SettingValue, null, before)
      return { ok: true, changed: true, updatedAt: null }
    }
    const v = validate(desc, value)
    if (!v.ok) return v
    const count = stranded(desc, v.value)
    if (count > 0) return refusal('settings_strands_users', undefined, count)
    if (desc.stored !== null && JSON.stringify(desc.stored) === JSON.stringify(v.value)) return { ok: true, changed: false, updatedAt: desc.updatedAt }
    if (d.flag('settings-audit-fail')) return refusal('settings_audit_unavailable')
    const updatedAt = Math.max(Date.now(), (desc.updatedAt ?? 0) + 1)
    const before = rows[key] ?? null
    rows[key] = { value: v.value, updatedAt, updatedBy: d.who() }
    write(rows)
    arm(v.value, updatedAt, before)
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
      confirmPending: async (key) => {
        d.needStepUp()
        sweep()
        const p = readPending()[key]
        if (!p) return d.wait(refusal('settings_no_pending'))
        if (d.sessionStart() < p.createdAt) return d.wait(refusal('settings_confirm_session'))
        const pending = readPending()
        delete pending[key]
        writePending(pending)
        return d.wait({ ok: true as const })
      },
      cancelPending: async (key) => {
        sweep()
        const p = readPending()[key]
        if (!p) return d.wait(refusal('settings_no_pending'))
        settle(key, p)
        return d.wait({ ok: true as const })
      },
    },
  }
}
