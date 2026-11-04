/** SPEC/32 task 3: role, state, step-up and mode matrix of the settings service; the functions file; the answers. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'
import { createAuthSettingsResolver } from '../src/server/auth/settings'
import { createSettingsWriter, SettingsError } from '../src/server/auth/settings-write'
import { AuthError, type AccountContext } from '../src/server/auth/types'
import { createSettingsService, SETTINGS_STEP_UP_PURPOSE, type SettingsService } from '../src/server/settings-service'
import { previewSettingInput, resetSettingInput, setSettingInput } from '../src/server/settings.functions'

let dir: string
let store: SqliteStore
let rows: { event: string; fields: Record<string, unknown> }[]
let stepUpOk: boolean
let stepUpPurposes: string[]
let mode: 'account' | 'direct' | 'setup' | 'stateless'
let failAudit: boolean

const user = (id: string, role: 'admin' | 'user', status: 'active' | 'disabled' = 'active') =>
  store.accounts.createUser({
    id, username: id, usernameKey: id, displayName: id, role, status, securityVersion: 0, mustChangePassword: false, tempPasswordExpiresAt: null,
    webauthnUserId: `w-${id}`, createdAt: 1, updatedAt: 1, createdBy: 'setup', lastSignInAt: null,
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-setfn-'))
  store = openSqliteStore(join(dir, 'store.db'))
  rows = []
  stepUpOk = true
  stepUpPurposes = []
  mode = 'account'
  failAudit = false
  user('a1', 'admin')
  user('a2', 'admin', 'disabled')
  user('u1', 'user')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function service(env: NodeJS.ProcessEnv = {}): SettingsService {
  const writer = createSettingsWriter({
    store: store.accounts,
    env,
    changed: () => undefined,
    audit: (event, fields) => {
      if (failAudit) throw new SettingsError('settings_audit_unavailable')
      if (event === 'settings.pending') return // guarded keys also write this row; tests/protect-pending.test.ts covers it
      rows.push({ event, fields })
    },
  })
  return createSettingsService({
    store: store.accounts,
    writer,
    describe: () => createAuthSettingsResolver(store.accounts, env).describe(),
    stepUp: {
      requireRecentFactor: (_ctx, purpose) => {
        stepUpPurposes.push(purpose)
        if (!stepUpOk) throw new AuthError('stepup_required')
      },
    },
    mode: () => mode,
  })
}
const ctx = (id: string | null, role: 'admin' | 'user' = 'user', state: AccountContext['state'] = 'full'): AccountContext => ({
  idHash: 'h', csrf: 'c', kind: 'account', state, ownerKey: `u:${id}`, mfaAt: null, stepupAt: null,
  user: id ? { id, username: id, displayName: id, role, securityVersion: 0 } : null,
})
const admin = () => ctx('a1', 'admin')

describe('role, state and mode matrix', () => {
  it('an administrator reads the description of every editable and read-only key', () => {
    const v = service().get(admin())
    expect(v.settings.length).toBeGreaterThan(30)
    expect(v.settings.find((s) => s.key === 'loginFailures')).toMatchObject({ effective: 5, source: 'built_in', editable: true })
    expect(v.settings.find((s) => s.key === 'totpWindow')).toMatchObject({ editable: false })
  })

  it.each([
    ['ordinary user', ctx('u1', 'user')],
    ['no user', ctx(null)],
    ['disabled administrator', ctx('a2', 'admin')],
    ['administrator before MFA', ctx('a1', 'admin', 'pending_mfa')],
    ['role claimed in the session but the row says user', ctx('u1', 'admin')],
    ['unknown user id', ctx('ghost', 'admin')],
  ])('every call refuses: %s', (_n, c) => {
    const s = service()
    expect(() => s.get(c)).toThrow(AuthError)
    expect(() => s.set(c, 'loginFailures', 6, null)).toThrow(AuthError)
    expect(() => s.reset(c, 'loginFailures', null)).toThrow(AuthError)
    expect(() => s.preview(c, 'mfaFactors', ['totp'])).toThrow(AuthError)
    expect(stepUpPurposes).toEqual([]) // refused before step-up is even asked
    expect(store.accounts.getSettings()).toEqual([])
  })

  it.each(['direct', 'stateless', 'setup'] as const)('mode %s has no settings page', (m) => {
    mode = m
    const s = service()
    expect(() => s.get(admin())).toThrow(AuthError)
    expect(() => s.set(admin(), 'loginFailures', 6, null)).toThrow(AuthError)
  })
})

describe('step-up', () => {
  it('set and reset ask for a recent factor with the settings purpose, before touching anything', () => {
    const s = service()
    stepUpOk = false
    expect(() => s.set(admin(), 'loginFailures', 6, null)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(() => s.reset(admin(), 'loginFailures', null)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(stepUpPurposes).toEqual([SETTINGS_STEP_UP_PURPOSE, SETTINGS_STEP_UP_PURPOSE])
    expect(store.accounts.getSettings()).toEqual([])
    expect(rows).toEqual([])
  })

  it('get and preview need the role only', () => {
    stepUpOk = false
    const s = service()
    expect(s.get(admin()).settings.length).toBeGreaterThan(0)
    expect(s.preview(admin(), 'loginFailures', 6)).toEqual({ ok: true, strandedUsers: 0 })
    expect(stepUpPurposes).toEqual([])
  })

  it('an invalid value is not told to an administrator without a recent factor', () => {
    stepUpOk = false
    expect(() => service().set(admin(), 'loginFailures', 999, null)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
  })
})

describe('answers', () => {
  it('a change answers ok with the new row stamp and writes the audit row with the administrator as actor', () => {
    const s = service()
    const r = s.set(admin(), 'loginFailures', 6, null)
    expect(r).toMatchObject({ ok: true, changed: true })
    expect(rows).toEqual([{ event: 'settings.change', fields: expect.objectContaining({ setting: 'loginFailures', old: '5', new: '6', actor: 'a1' }) }])
    const after = s.get(admin()).settings.find((x) => x.key === 'loginFailures')!
    expect(after).toMatchObject({ stored: 6, effective: 6, source: 'ui_override', updatedBy: 'a1' })
    expect(r.ok && r.updatedAt).toBe(after.updatedAt)
  })

  it('refusals are answers, not exceptions, and carry a code and a short reason', () => {
    const s = service({ DBLOOM_SETTINGS_LOCK: 'sessionsPerUser', DBLOOM_MAINTENANCE: 'true' })
    expect(s.set(admin(), 'loginFailures', 99, null)).toEqual({ ok: false, error: { code: 'settings_invalid', detail: 'above_ceiling' } })
    expect(s.set(admin(), 'sessionsPerUser', 3, null)).toEqual({ ok: false, error: { code: 'settings_locked', detail: 'locked' } })
    expect(s.set(admin(), 'maintenanceOn', false, null)).toEqual({ ok: false, error: { code: 'settings_locked', detail: 'forced' } })
    expect(s.set(admin(), 'nope', 1, null)).toEqual({ ok: false, error: { code: 'settings_unknown' } })
    s.set(admin(), 'loginFailures', 6, null)
    expect(s.set(admin(), 'loginFailures', 7, null)).toEqual({ ok: false, error: { code: 'settings_conflict' } })
    expect(s.reset(admin(), 'loginFailures', null)).toEqual({ ok: false, error: { code: 'settings_conflict' } })
  })

  it('a failing audit write is the answer settings_audit_unavailable and nothing is stored', () => {
    const s = service()
    failAudit = true
    expect(s.set(admin(), 'loginFailures', 6, null)).toEqual({ ok: false, error: { code: 'settings_audit_unavailable' } })
    expect(store.accounts.getSettings()).toEqual([])
    s.set(admin(), 'loginFailures', 6, null) // still failing
    failAudit = false
    expect(s.set(admin(), 'loginFailures', 6, null)).toMatchObject({ ok: true, changed: true })
    failAudit = true
    const stamp = store.accounts.getSettings()[0]!.updatedAt
    expect(s.reset(admin(), 'loginFailures', stamp)).toEqual({ ok: false, error: { code: 'settings_audit_unavailable' } })
    expect(store.accounts.getSettings()).toHaveLength(1)
  })

  it('narrowing that would strand users is refused with the count; preview says the same without writing', () => {
    store.accounts.setTotp({ userId: 'u1', sealed: 'v1.x', lastStep: 0, createdAt: 1 })
    const s = service()
    expect(s.preview(admin(), 'mfaFactors', ['passkey'])).toEqual({ ok: true, strandedUsers: 1 })
    expect(s.set(admin(), 'mfaFactors', ['passkey'], null)).toEqual({ ok: false, error: { code: 'settings_strands_users', count: 1 } })
    expect(store.accounts.getSettings()).toEqual([])
  })

  it('reset removes the override and a second reset is a no-op', () => {
    const s = service()
    s.set(admin(), 'loginFailures', 6, null)
    const stamp = store.accounts.getSettings()[0]!.updatedAt
    expect(s.reset(admin(), 'loginFailures', stamp)).toEqual({ ok: true, changed: true, updatedAt: null })
    expect(s.reset(admin(), 'loginFailures', null)).toEqual({ ok: true, changed: false, updatedAt: null })
    expect(rows.map((r) => r.event)).toEqual(['settings.change', 'settings.reset'])
  })

  it('other errors are not turned into answers', () => {
    const s = createSettingsService({
      store: store.accounts,
      writer: { set: () => { throw new Error('boom') }, reset: () => { throw new Error('boom') }, preview: () => { throw new Error('boom') } },
      describe: () => [],
      stepUp: { requireRecentFactor: () => undefined },
      mode: () => 'account',
    })
    expect(() => s.set(admin(), 'loginFailures', 6, null)).toThrow('boom')
  })
})

describe('what an answer may contain', () => {
  it('no secret from the environment reaches the description', () => {
    const SECRET = 'sUpErSeCrEt-key-value-1234567890'
    const env = { DBLOOM_SECRET_KEY: SECRET, DBLOOM_SETUP_TOKEN: 'tok-abcdef-0123456789', DBLOOM_BREACHED_LIST: '/etc/private/list.txt' } as NodeJS.ProcessEnv
    const json = JSON.stringify(service(env).get(admin()))
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('tok-abcdef-0123456789')
    expect(json).not.toContain('/etc/private')
  })
})

describe('input schemas', () => {
  it('accept keys and plain values only, and refuse extra fields', () => {
    expect(setSettingInput.safeParse({ key: 'loginFailures', value: 6, basedOn: null }).success).toBe(true)
    expect(setSettingInput.safeParse({ key: 'mfaFactors', value: ['totp'], basedOn: 12 }).success).toBe(true)
    expect(setSettingInput.safeParse({ key: 'loginNotice', value: 'Hello', basedOn: 0 }).success).toBe(true)
    for (const bad of [
      { key: '', value: 1, basedOn: null },
      { key: 'a b', value: 1, basedOn: null },
      { key: '__proto__', value: 1, basedOn: null },
      { key: 'x'.repeat(65), value: 1, basedOn: null },
      { key: 'loginFailures', value: { a: 1 }, basedOn: null },
      { key: 'loginFailures', value: 'x'.repeat(601), basedOn: null },
      { key: 'loginFailures', value: 6, basedOn: -1 },
      { key: 'loginFailures', value: 6, basedOn: 1.5 },
      { key: 'loginFailures', value: 6 },
      { key: 'loginFailures', value: 6, basedOn: null, extra: 1 },
    ]) expect(setSettingInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(resetSettingInput.safeParse({ key: 'loginFailures', basedOn: null }).success).toBe(true)
    expect(resetSettingInput.safeParse({ key: 'loginFailures', basedOn: null, value: 1 }).success).toBe(false)
    expect(previewSettingInput.safeParse({ key: 'mfaFactors', value: ['totp'] }).success).toBe(true)
    expect(previewSettingInput.safeParse({ key: 'mfaFactors' }).success).toBe(false)
  })
})

describe('client chunk', () => {
  it('settings.functions.ts imports only thin modules (it is loaded in the browser)', () => {
    const src = readFileSync('src/server/settings.functions.ts', 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]!)
    expect(imports.sort()).toEqual(['./auth/error-transport', './middleware', './settings-admin-runtime', '@tanstack/react-start', 'zod'])
  })
  it('exports the six functions and the four input schemas, nothing else', () => {
    const src = readFileSync('src/server/settings.functions.ts', 'utf8')
    expect([...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!).sort()).toEqual([
      'cancelPending', 'confirmPending', 'getSettings', 'pendingSettingInput', 'previewSetting', 'previewSettingInput', 'resetSetting', 'resetSettingInput', 'setSetting', 'setSettingInput',
    ])
  })
})

describe('who changed it', () => {
  it('shows a display name for a user id, setup and cli as they are, and a removed user as such', () => {
    user('a3', 'admin')
    store.accounts.updateUser('a3', { displayName: 'Ada Admin' })
    const set = (key: 'loginFailures' | 'sessionsPerAdmin' | 'loginWindowMs' | 'loginBackoffCapMs', by: string, at: number) =>
      store.accounts.setSetting({ key, value: JSON.stringify(key === 'loginFailures' ? 6 : key === 'sessionsPerAdmin' ? 3 : 600_000), updatedAt: at, updatedBy: by })
    set('loginFailures', 'a3', 1)
    set('sessionsPerAdmin', 'setup', 2)
    set('loginWindowMs', 'cli', 3)
    set('loginBackoffCapMs', 'ghost-id', 4)
    const by = Object.fromEntries(service().get(admin()).settings.filter((s) => s.updatedBy).map((s) => [s.key, s.updatedBy]))
    expect(by).toEqual({ loginFailures: 'Ada Admin', sessionsPerAdmin: 'setup', loginWindowMs: 'cli', loginBackoffCapMs: 'a removed user' })
  })
})
