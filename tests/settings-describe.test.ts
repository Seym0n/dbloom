/** SPEC/32 task 1: registry metadata, describe(), locks, clamp audit, text keys, maintenance forcing, lock config. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { auditSettingClamp, createAuthSettingsResolver, resetClampReports } from '~/server/auth/settings'
import { SETTING_GROUPS, SETTING_META } from '~/server/auth/setting-meta'
import { AUTH_SETTINGS, AUTH_SETTING_KEYS, type AuthSettingKey } from '~/server/auth/types'
import { loadConfig } from '~/server/config'
import { addSink, removeSink } from '~/server/audit/sink'
import { AUDIT_EVENTS } from '~/server/audit/events'
import { SETTINGS_ERROR_CODES } from '~/server/auth/settings-write'
import settingsTexts from '~/i18n/settings.json'

let dir: string
let store: SqliteStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-setdesc-'))
  store = openSqliteStore(join(dir, 'store.db'))
  resetClampReports()
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const save = (key: AuthSettingKey, value: unknown, at = 1) =>
  store.accounts.setSetting({ key, value: JSON.stringify(value), updatedAt: at, updatedBy: 'test' })
const describeOf = (env: NodeJS.ProcessEnv = {}) => createAuthSettingsResolver(store.accounts, env).describe()
const one = (key: AuthSettingKey, env: NodeJS.ProcessEnv = {}) => describeOf(env).find((d) => d.key === key)!

describe('registry metadata', () => {
  it('every key has a group, a kind and a unit, and groups are known', () => {
    for (const key of AUTH_SETTING_KEYS) {
      const meta = SETTING_META[key]
      expect(meta, key).toBeDefined()
      expect(SETTING_GROUPS).toContain(meta.group)
      expect(meta.factor).toBeGreaterThan(0)
      if (meta.kind === 'choice' || meta.kind === 'list') expect(meta.choices?.length, key).toBeGreaterThan(0)
    }
  })

  it('no setting holds a secret: every key is a limit, a switch, a choice, a number or plain text', () => {
    for (const key of AUTH_SETTING_KEYS) expect(['number', 'boolean', 'choice', 'list', 'text', 'object']).toContain(SETTING_META[key].kind)
    for (const key of AUTH_SETTING_KEYS) if (SETTING_META[key].kind === 'text') expect(AUTH_SETTINGS[key].default, key).toBe('')
  })

  it('describes every key except per-user preferences', () => {
    const keys = describeOf().map((d) => d.key)
    expect(keys).not.toContain('loginAutofocus')
    expect(keys.length).toBe(AUTH_SETTING_KEYS.length - 1)
  })

  it('the audit catalog knows the settings events', () => {
    for (const e of ['settings.clamped', 'settings.change', 'settings.reset']) expect(AUDIT_EVENTS).toContain(e)
  })
})

describe('describe(): source, stored, effective, limits', () => {
  it('built-in with nothing stored or set', () => {
    const d = one('loginFailures')
    expect(d).toMatchObject({ stored: null, effective: 5, source: 'built_in', editable: true, locked: false, forced: false, updatedAt: null })
    expect(d.limits).toEqual({ floor: 3, ceiling: 10 })
  })

  it('.env default when the variable is set', () => {
    expect(one('loginFailures', { DBLOOM_LOGIN_FAILURES: '7' })).toMatchObject({ effective: 7, source: 'env_default', stored: null })
  })

  it('UI override when a valid value is stored', () => {
    save('loginFailures', 4, 99)
    expect(one('loginFailures')).toMatchObject({ stored: 4, effective: 4, source: 'ui_override', updatedAt: 99, updatedBy: 'test' })
  })

  it('a stored value above the ceiling shows stored and effective apart, source limit', () => {
    save('loginFailures', 8)
    // tighten the code ceiling through the grace-day style limit: use a key whose limit is the .env value
    save('mfaGraceMs', 5 * 86_400_000)
    const d = one('mfaGraceMs', { DBLOOM_MFA_GRACE_DAYS: '2' })
    expect(d).toMatchObject({ stored: 5 * 86_400_000, effective: 2 * 86_400_000, source: 'limit' })
    expect(d.limits.ceiling).toBe(2 * 86_400_000)
  })

  it('the .env scope is a floor: stored none shows effective all with source limit', () => {
    save('mfaScope', 'none')
    const d = one('mfaScope', { DBLOOM_MFA_SCOPE: 'all' })
    expect(d).toMatchObject({ stored: 'none', effective: 'all', source: 'limit' })
    expect(d.limits).toEqual({ floor: 'all', ceiling: 'all' })
  })

  it('lists carry the envelope; a stored list outside it is narrowed', () => {
    save('mfaFactors', ['passkey', 'totp'])
    const d = one('mfaFactors', { DBLOOM_MFA_FACTORS: 'totp' })
    expect(d).toMatchObject({ effective: ['totp'], source: 'limit' })
    expect(d.limits.envelope).toEqual(['totp'])
  })

  it('a stored value that no longer parses is ignored and flagged', () => {
    store.accounts.setSetting({ key: 'loginFailures', value: '"many"', updatedAt: 1, updatedBy: 'x' })
    expect(one('loginFailures')).toMatchObject({ stored: null, storedIgnored: true, effective: 5, source: 'built_in' })
  })

  it('env-only and wizard keys are not editable; argon2 shows its env state', () => {
    expect(one('totpWindow').editable).toBe(false)
    expect(one('loginMode').editable).toBe(false)
    expect(one('stepUpWindowMs').editable).toBe(false)
    expect(one('argon2Login', { DBLOOM_ARGON2_PASSES: '4' })).toMatchObject({ editable: false, source: 'env_default' })
    expect(one('argon2Login').source).toBe('built_in')
  })

  it('a stored value for an env-only key is not read', () => {
    save('totpWindow', 0)
    expect(one('totpWindow')).toMatchObject({ stored: null, effective: 1 })
  })
})

describe('locks (DBLOOM_SETTINGS_LOCK)', () => {
  it('a locked key ignores the stored value, shows it, and is not editable', () => {
    save('loginFailures', 4)
    const env = { DBLOOM_SETTINGS_LOCK: 'loginFailures, sessionsPerUser', DBLOOM_LOGIN_FAILURES: '6' }
    const d = one('loginFailures', env)
    expect(d).toMatchObject({ locked: true, editable: false, stored: 4, effective: 6, source: 'env_default' })
    expect(createAuthSettingsResolver(store.accounts, env).resolve().loginFailures).toBe(6)
    expect(one('sessionsPerUser', env)).toMatchObject({ locked: true, effective: 5, source: 'built_in' })
    expect(one('sessionsPerAdmin', env).locked).toBe(false)
  })

  it('config refuses an unknown key and accepts known ones', () => {
    expect(loadConfig({ DBLOOM_SETTINGS_LOCK: 'mfaScope,loginFailures' }).settingsLock).toEqual(['mfaScope', 'loginFailures'])
    expect(loadConfig({}).settingsLock).toEqual([])
    expect(() => loadConfig({ DBLOOM_SETTINGS_LOCK: 'mfaScope,nope' })).toThrow(/unknown setting keys: nope/)
  })
})

describe('site settings', () => {
  it('login notice: default empty, .env default, stored override, plain text kept as written', () => {
    expect(one('loginNotice')).toMatchObject({ effective: '', source: 'built_in', kind: 'text', editable: true })
    expect(one('loginNotice', { DBLOOM_LOGIN_NOTICE: '123' })).toMatchObject({ effective: '123', source: 'env_default' })
    expect(one('loginNotice', { DBLOOM_LOGIN_NOTICE: '"quoted" <b>x</b>' }).effective).toBe('"quoted" <b>x</b>')
    save('loginNotice', 'Maintenance on Friday')
    expect(one('loginNotice', { DBLOOM_LOGIN_NOTICE: 'env' })).toMatchObject({ effective: 'Maintenance on Friday', source: 'ui_override' })
  })

  it('text schemas: length and control characters', () => {
    const notice = AUTH_SETTINGS.loginNotice.schema
    const banner = AUTH_SETTINGS.infoBanner.schema
    expect(notice.safeParse('x'.repeat(300)).success).toBe(true)
    expect(notice.safeParse('x'.repeat(301)).success).toBe(false)
    expect(notice.safeParse('a\nb').success).toBe(false)
    expect(notice.safeParse('a\u0007b').success).toBe(false)
    expect(banner.safeParse('x'.repeat(500)).success).toBe(true)
    expect(banner.safeParse('x'.repeat(501)).success).toBe(false)
    expect(banner.safeParse('line one\nline two').success).toBe(true)
    expect(banner.safeParse('a\u0000b').success).toBe(false)
    expect(banner.safeParse('a\r\nb').success).toBe(false)
  })

  it('config refuses a bad notice or maintenance flag at startup', () => {
    expect(() => loadConfig({ DBLOOM_LOGIN_NOTICE: 'x'.repeat(301) })).toThrow(/DBLOOM_LOGIN_NOTICE/)
    expect(() => loadConfig({ DBLOOM_LOGIN_NOTICE: 'a\u0007' })).toThrow(/DBLOOM_LOGIN_NOTICE/)
    expect(() => loadConfig({ DBLOOM_MAINTENANCE: 'maybe' })).toThrow(/DBLOOM_MAINTENANCE/)
    expect(() => loadConfig({ DBLOOM_MAINTENANCE: 'true', DBLOOM_LOGIN_NOTICE: 'ok' })).not.toThrow()
  })

  it('maintenance: off by default, stored on, forced on by .env and not lowered by a stored off', () => {
    expect(one('maintenanceOn')).toMatchObject({ effective: false, forced: false, editable: true })
    save('maintenanceOn', true)
    expect(one('maintenanceOn')).toMatchObject({ effective: true, source: 'ui_override' })
    save('maintenanceOn', false)
    const forced = one('maintenanceOn', { DBLOOM_MAINTENANCE: '1' })
    expect(forced).toMatchObject({ effective: true, forced: true, editable: false, source: 'limit' })
    expect(createAuthSettingsResolver(store.accounts, { DBLOOM_MAINTENANCE: 'true' }).resolve().maintenanceOn).toBe(true)
    expect(one('maintenanceEndsAt')).toMatchObject({ effective: 0, editable: true })
  })
})

describe('clamp audit (FR-ASE-007)', () => {
  const lines: { event: string; fields: Record<string, unknown> }[] = []
  beforeEach(() => {
    lines.length = 0
    addSink({ name: 'test-clamp', write: (e) => void lines.push({ event: e.event, fields: e.fields }) })
  })
  afterEach(() => removeSink('test-clamp'))

  it('reports one settings.clamped per distinct clamp, never on a plain value, never rewrites the store', () => {
    const env = { DBLOOM_MFA_GRACE_DAYS: '2' }
    const r = createAuthSettingsResolver(store.accounts, env, { onClamp: auditSettingClamp })
    save('loginFailures', 4)
    r.resolve()
    expect(lines.filter((l) => l.event === 'settings.clamped')).toHaveLength(0)
    save('mfaGraceMs', 5 * 86_400_000, 5)
    for (let i = 0; i < 4; i++) r.resolve()
    const clamps = lines.filter((l) => l.event === 'settings.clamped')
    expect(clamps).toHaveLength(1)
    expect(clamps[0]!.fields).toMatchObject({ setting: 'mfaGraceMs', stored: String(5 * 86_400_000), effective: String(2 * 86_400_000) })
    // a different stored value is a different clamp
    save('mfaGraceMs', 6 * 86_400_000, 6)
    r.resolve()
    expect(lines.filter((l) => l.event === 'settings.clamped')).toHaveLength(2)
    // the stored row is untouched
    expect(store.accounts.getSettings().find((s) => s.key === 'mfaGraceMs')!.value).toBe(String(6 * 86_400_000))
  })

  it('a locked key is not a clamp, and without onClamp nothing is reported (CLI)', () => {
    save('mfaGraceMs', 5 * 86_400_000)
    createAuthSettingsResolver(store.accounts, { DBLOOM_MFA_GRACE_DAYS: '2' }).resolve()
    createAuthSettingsResolver(store.accounts, { DBLOOM_MFA_GRACE_DAYS: '2', DBLOOM_SETTINGS_LOCK: 'mfaGraceMs' }, { onClamp: auditSettingClamp }).resolve()
    expect(lines.filter((l) => l.event === 'settings.clamped')).toHaveLength(0)
  })

  it('describe() does not report', () => {
    save('mfaGraceMs', 5 * 86_400_000)
    createAuthSettingsResolver(store.accounts, { DBLOOM_MFA_GRACE_DAYS: '2' }, { onClamp: auditSettingClamp }).describe()
    expect(lines.filter((l) => l.event === 'settings.clamped')).toHaveLength(0)
  })
})

describe('texts of the settings page (src/i18n/settings.json)', () => {
  const texts = settingsTexts as Record<string, string>
  it('every listed key has a label, every group a title, every choice a text', () => {
    for (const key of AUTH_SETTING_KEYS) expect(texts[`settings.key.${key}`], `label of ${key}`).toBeTruthy()
    for (const g of SETTING_GROUPS) expect(texts[`settings.group.${g}`], `group ${g}`).toBeTruthy()
    for (const key of AUTH_SETTING_KEYS) for (const c of SETTING_META[key].kind === 'choice' || SETTING_META[key].kind === 'list' ? ((SETTING_META[key] as { choices?: readonly string[] }).choices ?? []) : []) expect(texts[`settings.choice.${c}`], `choice ${c}`).toBeTruthy()
  })
  it('every refusal code and detail the writer can give has a text', () => {
    for (const code of SETTINGS_ERROR_CODES) expect(texts[`settings.error.${code}`], code).toBeTruthy()
    for (const d of ['type', 'below_floor', 'above_ceiling', 'outside_envelope']) expect(texts[`settings.error.settings_invalid.${d}`], d).toBeTruthy()
    for (const d of ['locked', 'forced', 'not_editable']) expect(texts[`settings.error.settings_locked.${d}`], d).toBeTruthy()
  })
})
