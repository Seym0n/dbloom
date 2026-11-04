/** SPEC/33 task 4: service matrix for confirm and cancel, sweep on every call, guarded writes through the service. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { createSettingsWriter } from '~/server/auth/settings-write'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createPendingSettings } from '~/server/settings-pending'
import { createSettingsService, type SettingsService } from '~/server/settings-service'
import { AuthError, MINUTE_MS, type AccountContext, type AuthSettingKey } from '~/server/auth/types'

const FIVE = 5 * MINUTE_MS
let dir: string
let store: SqliteStore
let clock: number
let stepUpOk: boolean
let stepUpPurposes: string[]
let mode: 'account' | 'direct' | 'setup' | 'stateless'
let sessionCreated: Map<string, number>
let service: SettingsService

const user = (id: string, role: 'admin' | 'user', status: 'active' | 'disabled' = 'active') =>
  store.accounts.createUser({
    id, username: id, usernameKey: id, displayName: id, role, status, securityVersion: 0, mustChangePassword: false, tempPasswordExpiresAt: null,
    webauthnUserId: `w-${id}`, createdAt: 1, updatedAt: 1, createdBy: 'setup', lastSignInAt: null,
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-protsvc-'))
  store = openSqliteStore(join(dir, 'store.db'))
  clock = 10_000
  stepUpOk = true
  stepUpPurposes = []
  mode = 'account'
  sessionCreated = new Map([['new', 20_000], ['old', 5_000]])
  user('a1', 'admin')
  user('a2', 'admin', 'disabled')
  user('u1', 'user')
  const pending = createPendingSettings({ store: store.accounts, now: () => clock, timers: { set: () => 0, clear: () => undefined }, audit: () => undefined, auditBestEffort: () => undefined, changed: () => undefined })
  const writer = createSettingsWriter({ store: store.accounts, now: () => clock, changed: () => undefined, armed: () => pending.schedule(), audit: () => undefined })
  service = createSettingsService({
    store: { getUser: (id) => store.accounts.getUser(id), getAccountSession: (h) => (sessionCreated.has(h) ? ({ createdAt: sessionCreated.get(h) } as never) : undefined) },
    writer,
    pending,
    describe: () => createAuthSettingsResolver(store.accounts, {}).describe(),
    stepUp: {
      requireRecentFactor: (_c, purpose) => {
        stepUpPurposes.push(purpose)
        if (!stepUpOk) throw new AuthError('stepup_required')
      },
    },
    mode: () => mode,
  })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const ctx = (id: string | null, role: 'admin' | 'user' = 'admin', state: AccountContext['state'] = 'full', idHash = 'new'): AccountContext => ({
  idHash, csrf: 'c', kind: 'account', state, ownerKey: `u:${id}`, mfaAt: null, stepupAt: null,
  user: id ? { id, username: id, displayName: id, role, securityVersion: 0 } : null,
})
const guarded = () => service.set(ctx('a1'), 'loginFailures', 7, null)
const thrown = (fn: () => unknown): AuthError | undefined => {
  try {
    fn()
  } catch (e) {
    return e as AuthError
  }
}
const effective = (key: AuthSettingKey) => createAuthSettingsResolver(store.accounts, {}).describe().find((d) => d.key === key)!

describe('confirm and cancel: who may', () => {
  it.each([
    ['anonymous', () => ctx(null, 'user')],
    ['an ordinary user', () => ctx('u1', 'user')],
    ['a disabled administrator', () => ctx('a2', 'admin')],
    ['a session not yet fully signed in', () => ctx('a1', 'admin', 'pending_mfa')],
  ])('refuses %s', (_name, c) => {
    guarded()
    expect(thrown(() => service.confirm(c(), 'loginFailures'))?.code).toBe('auth_failed')
    expect(thrown(() => service.cancel(c(), 'loginFailures'))?.code).toBe('auth_failed')
    expect(effective('loginFailures').pending).not.toBeNull()
  })

  it('refuses outside account mode', () => {
    guarded()
    mode = 'direct'
    expect(thrown(() => service.confirm(ctx('a1'), 'loginFailures'))?.code).toBe('auth_failed')
  })

  it('refuses a session that has no row (it cannot prove when it signed in)', () => {
    guarded()
    expect(thrown(() => service.confirm(ctx('a1', 'admin', 'full', 'ghost'), 'loginFailures'))?.code).toBe('auth_failed')
  })
})

describe('confirm', () => {
  it('answers settings_confirm_session for a session older than the change, and keeps it pending', () => {
    clock = 10_000
    sessionCreated.set('old', 5_000)
    guarded()
    expect(service.confirm(ctx('a1', 'admin', 'full', 'old'), 'loginFailures')).toEqual({ ok: false, error: { code: 'settings_confirm_session' } })
    expect(effective('loginFailures').pending).not.toBeNull()
  })

  it('keeps the change for a session that signed in after it, with no step-up', () => {
    guarded()
    stepUpOk = false
    stepUpPurposes = []
    expect(service.confirm(ctx('a1'), 'loginFailures')).toEqual({ ok: true })
    expect(stepUpPurposes).toEqual([])
    expect(effective('loginFailures').pending).toBeNull()
    clock += 10 * FIVE
    service.get(ctx('a1'))
    expect(effective('loginFailures').effective).toBe(7)
  })

  it('answers settings_no_pending when nothing is waiting', () => {
    expect(service.confirm(ctx('a1'), 'loginFailures')).toEqual({ ok: false, error: { code: 'settings_no_pending' } })
  })

  it('an old session stays refused however fresh its step-up is', () => {
    guarded()
    expect(service.confirm({ ...ctx('a1', 'admin', 'full', 'old'), stepupAt: clock + 1_000 }, 'loginFailures')).toMatchObject({ ok: false })
    expect(effective('loginFailures').pending).not.toBeNull()
  })
})

describe('cancel', () => {
  it('reverts at once for an administrator, with no step-up', () => {
    guarded()
    stepUpOk = false
    stepUpPurposes = []
    expect(service.cancel(ctx('a1'), 'loginFailures')).toEqual({ ok: true })
    expect(stepUpPurposes).toEqual([])
    expect(effective('loginFailures').effective).toBe(5)
    expect(effective('loginFailures').pending).toBeNull()
  })

  it('answers settings_no_pending when nothing is waiting', () => {
    expect(service.cancel(ctx('a1'), 'loginFailures')).toEqual({ ok: false, error: { code: 'settings_no_pending' } })
  })

  it('works for an old session too: reverting is always safe', () => {
    guarded()
    expect(service.cancel(ctx('a1', 'admin', 'full', 'old'), 'loginFailures')).toEqual({ ok: true })
  })
})

describe('sweep on every call (FR-APR-010)', () => {
  const calls: [string, () => unknown][] = [
    ['get', () => service.get(ctx('a1'))],
    ['preview', () => service.preview(ctx('a1'), 'loginFailures', 6)],
    ['set', () => service.set(ctx('a1'), 'sessionsPerUser', 6, null)],
    ['reset', () => service.reset(ctx('a1'), 'sessionsPerUser', null)],
    ['confirm', () => service.confirm(ctx('a1'), 'loginFailures')],
  ]
  it.each(calls)('%s reverts an expired change first, without any timer', (_name, call) => {
    guarded()
    clock += FIVE
    call()
    expect(effective('loginFailures').effective).toBe(5)
    expect(effective('loginFailures').pending).toBeNull()
  })

  it('does not revert before the deadline', () => {
    guarded()
    clock += FIVE - 1
    service.get(ctx('a1'))
    expect(effective('loginFailures').effective).toBe(7)
    expect(effective('loginFailures').pending).toMatchObject({ newValue: 7, deadlineAt: 10_000 + FIVE, actor: 'a1' })
  })
})

describe('without a manager', () => {
  it('confirm and cancel answer settings_no_pending', () => {
    const bare = createSettingsService({
      store: { getUser: (id) => store.accounts.getUser(id), getAccountSession: () => ({ createdAt: 1 }) as never },
      writer: createSettingsWriter({ store: store.accounts, audit: () => undefined, changed: () => undefined }),
      describe: () => [],
      stepUp: { requireRecentFactor: () => undefined },
      mode: () => 'account',
    })
    expect(bare.confirm(ctx('a1'), 'loginFailures')).toEqual({ ok: false, error: { code: 'settings_no_pending' } })
    expect(bare.cancel(ctx('a1'), 'loginFailures')).toEqual({ ok: false, error: { code: 'settings_no_pending' } })
  })
})
