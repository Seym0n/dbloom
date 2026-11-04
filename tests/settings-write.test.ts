/** SPEC/32 task 2: validated set/reset, audit first, conflict, locks, preview, invalidation, wizard path unchanged. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createSettingsWriter, SettingsError, type SettingsAuditEvent, type SettingsWriter } from '~/server/auth/settings-write'
import { createUserService } from '~/server/auth/users'
import { isAuditEvent } from '~/server/audit/events'
import { onSettingsChanged } from '~/server/settings-runtime'
import type { AuthSettingKey } from '~/server/auth/types'

let dir: string
let store: SqliteStore
let events: { event: SettingsAuditEvent; fields: Record<string, unknown>; storedAtAudit: string | undefined }[]
let failAudit = false
let clock = 1_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-setwrite-'))
  store = openSqliteStore(join(dir, 'store.db'))
  events = []
  failAudit = false
  clock = 1_000
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const storedValue = (key: AuthSettingKey) => store.accounts.getSettings().find((s) => s.key === key)?.value
const writer = (env: NodeJS.ProcessEnv = {}, changed?: () => void): SettingsWriter =>
  createSettingsWriter({
    store: store.accounts,
    env,
    now: () => clock,
    ...(changed ? { changed } : {}),
    audit: (event, fields) => {
      if (failAudit) throw new Error('Audit log unavailable: test')
      if (event === 'settings.pending') return // guarded keys also write this row; tests/protect-pending.test.ts covers it
      events.push({ event, fields, storedAtAudit: storedValue(fields.setting as AuthSettingKey) })
    },
  })
const refusal = (fn: () => unknown): SettingsError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SettingsError)
    return e as SettingsError
  }
  throw new Error('expected a refusal')
}

describe('set', () => {
  it('stores the value, stamps the row and writes the audit row with old and new first', () => {
    const w = writer()
    const r = w.set('loginFailures', 7, null, 'u1')
    expect(r).toMatchObject({ changed: true, old: 5, new: 7, updatedAt: 1_000 })
    expect(JSON.parse(storedValue('loginFailures')!)).toBe(7)
    expect(store.accounts.getSettings()[0]).toMatchObject({ updatedBy: 'u1', updatedAt: 1_000 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'settings.change', fields: { setting: 'loginFailures', old: '5', new: '7', actor: 'u1', stored: false } })
    expect(events[0]!.storedAtAudit).toBeUndefined() // audit came before the store write
    expect(isAuditEvent('settings.change')).toBe(true)
    expect(createAuthSettingsResolver(store.accounts, {}).resolve().loginFailures).toBe(7)
  })

  it('a failing audit write aborts: nothing stored, nothing invalidated', () => {
    let invalidated = 0
    const w = writer({}, () => void invalidated++)
    failAudit = true
    expect(() => w.set('loginFailures', 7, null, 'u1')).toThrow(/Audit log unavailable/)
    expect(storedValue('loginFailures')).toBeUndefined()
    expect(invalidated).toBe(0)
  })

  it('refuses out-of-range numbers at both edges and accepts the edges', () => {
    const w = writer()
    expect(refusal(() => w.set('loginFailures', 2, null, 'u')).detail).toBe('below_floor')
    expect(refusal(() => w.set('loginFailures', 11, null, 'u')).detail).toBe('above_ceiling')
    expect(refusal(() => w.set('loginFailures', 5.5, null, 'u')).code).toBe('settings_invalid')
    expect(refusal(() => w.set('loginFailures', '5', null, 'u')).code).toBe('settings_invalid')
    expect(w.set('loginFailures', 3, null, 'u').changed).toBe(true)
    expect(w.set('loginFailures', 10, 1_000, 'u').changed).toBe(true)
    expect(events).toHaveLength(2)
    expect(JSON.parse(storedValue('loginFailures')!)).toBe(10)
  })

  it('the stored value is never clamped: a refusal leaves the store untouched', () => {
    const w = writer()
    refusal(() => w.set('auditRetentionDays', 30, null, 'u'))
    refusal(() => w.set('auditRetentionDays', 5000, null, 'u'))
    expect(storedValue('auditRetentionDays')).toBeUndefined()
    expect(events).toHaveLength(0)
    expect(w.set('auditRetentionDays', 90, null, 'u').changed).toBe(true)
  })

  it('.env limits: grace ceiling, scope floor, role floor, list envelope', () => {
    const w = writer({ DBLOOM_MFA_GRACE_DAYS: '2', DBLOOM_MFA_SCOPE: 'roles', DBLOOM_MFA_ROLES: 'admin', DBLOOM_MFA_FACTORS: 'totp' })
    const day = 86_400_000
    expect(refusal(() => w.set('mfaGraceMs', 3 * day, null, 'u')).detail).toBe('above_ceiling')
    expect(w.set('mfaGraceMs', 2 * day, null, 'u').changed).toBe(true)
    expect(refusal(() => w.set('mfaScope', 'none', null, 'u')).detail).toBe('below_floor')
    expect(w.set('mfaScope', 'all', null, 'u').changed).toBe(true)
    expect(refusal(() => w.set('mfaRoles', ['user'], null, 'u')).detail).toBe('below_floor')
    expect(w.set('mfaRoles', ['admin', 'user'], null, 'u').changed).toBe(true)
    expect(refusal(() => w.set('mfaFactors', ['passkey', 'totp'], null, 'u')).detail).toBe('outside_envelope')
    expect(refusal(() => w.set('mfaFactors', [], null, 'u')).code).toBe('settings_invalid')
    expect(w.set('mfaFactors', ['totp'], null, 'u').changed).toBe(true)
  })

  it('refuses unknown, env-only, wizard, locked and forced keys', () => {
    const w = writer({ DBLOOM_SETTINGS_LOCK: 'sessionsPerUser', DBLOOM_MAINTENANCE: 'true' })
    expect(refusal(() => w.set('nope', 1, null, 'u')).code).toBe('settings_unknown')
    expect(refusal(() => w.set('__proto__', 1, null, 'u')).code).toBe('settings_unknown')
    expect(refusal(() => w.set('loginAutofocus', true, null, 'u')).code).toBe('settings_unknown')
    for (const key of ['totpWindow', 'loginMode', 'stepUpWindowMs', 'argon2Login']) expect(refusal(() => w.set(key, 1, null, 'u')).code, key).toBe('settings_locked')
    expect(refusal(() => w.set('sessionsPerUser', 3, null, 'u'))).toMatchObject({ code: 'settings_locked', detail: 'locked' })
    expect(refusal(() => w.set('maintenanceOn', false, null, 'u'))).toMatchObject({ code: 'settings_locked', detail: 'forced' })
    expect(store.accounts.getSettings()).toEqual([])
    expect(events).toHaveLength(0)
  })

  it('a conflict: stale or missing basedOn is refused, the current one is accepted', () => {
    const w = writer()
    w.set('loginFailures', 6, null, 'a') // stamped 1000
    expect(refusal(() => w.set('loginFailures', 7, null, 'b')).code).toBe('settings_conflict')
    expect(refusal(() => w.set('loginFailures', 7, 999, 'b')).code).toBe('settings_conflict')
    expect(w.set('loginFailures', 7, 1_000, 'b').updatedAt).toBe(1_001) // strictly later even within the same millisecond
    expect(refusal(() => w.set('loginFailures', 8, 1_000, 'c')).code).toBe('settings_conflict')
  })

  it('an unchanged value is a no-op without audit', () => {
    const w = writer()
    w.set('loginFailures', 6, null, 'a')
    const r = w.set('loginFailures', 6, 1_000, 'a')
    expect(r.changed).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('text keys: length, control characters, banner newlines', () => {
    const w = writer()
    expect(w.set('loginNotice', 'Planned work on Friday', null, 'u').changed).toBe(true)
    expect(refusal(() => w.set('loginNotice', 'x'.repeat(301), 1_000, 'u')).code).toBe('settings_invalid')
    expect(refusal(() => w.set('loginNotice', 'a\nb', 1_000, 'u')).code).toBe('settings_invalid')
    expect(w.set('infoBanner', 'one\ntwo', null, 'u').changed).toBe(true)
    expect(events.at(-1)!.fields).toMatchObject({ setting: 'infoBanner', old: '""', new: '"one\\ntwo"' })
  })

  it('maintenance: on, with an end time; the audit row carries the effective values', () => {
    const w = writer()
    w.set('maintenanceOn', true, null, 'u')
    w.set('maintenanceEndsAt', 9_999, null, 'u')
    expect(events.map((e) => [e.fields.setting, e.fields.old, e.fields.new])).toEqual([
      ['maintenanceOn', 'false', 'true'],
      ['maintenanceEndsAt', '0', '9999'],
    ])
  })

  it('a locked-then-unlocked key keeps its older stored value usable', () => {
    store.accounts.setSetting({ key: 'loginFailures', value: '4', updatedAt: 5, updatedBy: 'x' })
    expect(createAuthSettingsResolver(store.accounts, { DBLOOM_SETTINGS_LOCK: 'loginFailures' }).resolve().loginFailures).toBe(5)
    expect(createAuthSettingsResolver(store.accounts, {}).resolve().loginFailures).toBe(4)
  })
})

describe('reset', () => {
  it('removes the stored value, audits old and new effective, returns the key to the default', () => {
    const w = writer({ DBLOOM_LOGIN_FAILURES: '6' })
    w.set('loginFailures', 8, null, 'u')
    const r = w.reset('loginFailures', 1_000, 'u')
    expect(r).toMatchObject({ changed: true, old: 8, new: 6, updatedAt: null })
    expect(storedValue('loginFailures')).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ event: 'settings.reset', fields: { setting: 'loginFailures', old: '8', new: '6', actor: 'u' } })
    expect(events.at(-1)!.storedAtAudit).toBe('8') // audit before the delete
    expect(isAuditEvent('settings.reset')).toBe(true)
  })

  it('failing audit leaves the value; conflict and locked refuse; nothing stored is a no-op', () => {
    const w = writer({ DBLOOM_SETTINGS_LOCK: 'sessionsPerAdmin' })
    expect(w.reset('loginFailures', null, 'u').changed).toBe(false)
    expect(events).toHaveLength(0)
    w.set('loginFailures', 8, null, 'u')
    expect(refusal(() => w.reset('loginFailures', null, 'u')).code).toBe('settings_conflict')
    failAudit = true
    expect(() => w.reset('loginFailures', 1_000, 'u')).toThrow(/Audit log unavailable/)
    expect(JSON.parse(storedValue('loginFailures')!)).toBe(8)
    expect(refusal(() => w.reset('sessionsPerAdmin', null, 'u')).code).toBe('settings_locked')
    expect(refusal(() => w.reset('nope', null, 'u')).code).toBe('settings_unknown')
  })
})

describe('invalidation', () => {
  it('a committed change and a committed reset notify registered caches; a refusal does not', () => {
    let n = 0
    const off = onSettingsChanged(() => void n++)
    try {
      const w = writer() // default `changed` = process-wide notification
      w.set('loginFailures', 7, null, 'u')
      expect(n).toBe(1)
      w.reset('loginFailures', 1_000, 'u')
      expect(n).toBe(2)
      refusal(() => w.set('loginFailures', 99, null, 'u'))
      expect(n).toBe(2)
    } finally {
      off()
    }
  })

  it('a throwing listener does not fail the write', () => {
    const off = onSettingsChanged(() => {
      throw new Error('boom')
    })
    try {
      expect(writer().set('loginFailures', 7, null, 'u').changed).toBe(true)
    } finally {
      off()
    }
  })
})

describe('narrowing preview (ST-056, ST-057)', () => {
  const hash = async () => '$phc$x'
  const users = () => createUserService(store.accounts, hash, () => clock, () => createAuthSettingsResolver(store.accounts, {}).resolve())
  const passkey = (userId: string, id: string) =>
    store.accounts.addPasskey({ id, userId, publicKey: new Uint8Array([1]), counter: 0, transports: [], backedUp: false, uvInitial: true, name: 'k', createdAt: 1, lastUsedAt: null })
  const totp = (userId: string) => store.accounts.setTotp({ userId, sealed: 'v1.x', lastStep: 0, createdAt: 1 })
  async function make(name: string, factors: ('passkey' | 'totp')[], status: 'active' | 'disabled' = 'active') {
    const u = await users().create({ username: name, displayName: name, role: 'user', password: 'correct horse battery staple' }, 'setup')
    if (factors.includes('passkey')) passkey(u.id, `pk-${name}`)
    if (factors.includes('totp')) totp(u.id)
    if (status === 'disabled') store.accounts.updateUser(u.id, { status: 'disabled' })
    return u
  }

  it('counts users who would be left with no allowed second factor and refuses the write', async () => {
    await make('only-totp', ['totp'])
    await make('only-passkey', ['passkey'])
    await make('both', ['passkey', 'totp'])
    await make('none', [])
    await make('off', ['passkey'], 'disabled')
    const w = writer()
    expect(w.preview('mfaFactors', ['totp'])).toEqual({ strandedUsers: 1 })
    expect(w.preview('mfaFactors', ['passkey'])).toEqual({ strandedUsers: 1 })
    expect(w.preview('mfaFactors', ['passkey', 'totp'])).toEqual({ strandedUsers: 0 })
    const e = refusal(() => w.set('mfaFactors', ['totp'], null, 'u'))
    expect(e).toMatchObject({ code: 'settings_strands_users', count: 1 })
    expect(storedValue('mfaFactors')).toBeUndefined()
    expect(events).toHaveLength(0)
  })

  it('a user who is already stranded does not block a change; widening never does', async () => {
    await make('only-passkey', ['passkey'])
    store.accounts.setSetting({ key: 'mfaFactors', value: JSON.stringify(['totp']), updatedAt: 3, updatedBy: 'x' })
    const w = writer()
    expect(w.preview('mfaFactors', ['totp'])).toEqual({ strandedUsers: 0 })
    expect(w.set('mfaFactors', ['passkey', 'totp'], 3, 'u').changed).toBe(true)
  })

  it('primary credentials: password-only and passkey-only users', async () => {
    const pw = await make('pw', [])
    expect(pw).toBeDefined()
    const pk = await make('pk-user', ['passkey'])
    store.accounts.deletePassword(pk.id)
    const w = writer()
    expect(w.preview('primaryCredentials', ['password'])).toEqual({ strandedUsers: 1 }) // pk-user has no password
    expect(w.preview('primaryCredentials', ['passkey'])).toEqual({ strandedUsers: 1 }) // pw has only a password
    expect(w.preview('primaryCredentials', ['password', 'passkey'])).toEqual({ strandedUsers: 0 })
  })

  it('other keys have no preview count', () => {
    expect(writer().preview('loginFailures', 6)).toEqual({ strandedUsers: 0 })
    expect(refusal(() => writer().preview('loginFailures', 99)).code).toBe('settings_invalid')
  })
})

describe('the wizard path is unchanged', () => {
  it('write() still clamps silently and records the setter', () => {
    const r = createAuthSettingsResolver(store.accounts, {})
    r.write({ sessionsPerUser: 99 }, 'setup')
    expect(JSON.parse(storedValue('sessionsPerUser')!)).toBe(20)
    expect(store.accounts.getSettings()[0]!.updatedBy).toBe('setup')
  })
})
