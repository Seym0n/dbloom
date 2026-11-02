/** Package B review fixes: 2FA requirement, settings-driven limits, Argon2 floors, vault key TTL (SPEC/26 FR-AUT-012, 017, 021, 029). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SessionManager, type SessionSettings } from '~/server/sessions'
import { createUserService, type UserServiceSettings } from '~/server/auth/users'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { ARGON2_LOGIN_DEFAULT, ARGON2_LOGIN_MIN, ARGON2_VAULT_MIN, type User } from '~/server/auth/types'

let dir: string
let store: SqliteStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-authb2-'))
  store = openSqliteStore(join(dir, 'store.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const fakeHash = async (pw: string) => `$phc$${pw}`
const newUser = (name: string, role: 'admin' | 'user' = 'user') => ({ username: name, displayName: name, role, password: 'correct horse battery' })
const save = (key: 'mfaScope' | 'mfaRoles' | 'mfaGraceMs', value: unknown, at = 1) =>
  store.accounts.setSetting({ key, value: JSON.stringify(value), updatedAt: at, updatedBy: 'test' })

describe('2FA requirement (ST-054, ST-055, FR-AUT-012)', () => {
  const withEnv = (env: NodeJS.ProcessEnv, now: () => number = Date.now) =>
    createUserService(store.accounts, fakeHash, now, () => createAuthSettingsResolver(store.accounts, env).resolve())

  it('requires administrators always and nobody else by default', async () => {
    const users = withEnv({})
    const a = await users.create(newUser('mfa-admin', 'admin'), 'setup')
    const u = await users.create(newUser('mfa-user'), 'setup')
    expect(users.mfaRequirement(a, Date.now())).toEqual({ required: true, graceEnded: true })
    expect(users.mfaRequirement(u, Date.now())).toEqual({ required: false, graceEnded: true })
  })

  it('follows the stored scope: roles, then all', async () => {
    const users = withEnv({})
    const u = await users.create(newUser('mfa-user2'), 'setup')
    save('mfaScope', 'roles')
    expect(users.mfaRequirement(u, Date.now()).required).toBe(false)
    save('mfaRoles', ['admin', 'user'])
    expect(users.mfaRequirement(u, Date.now()).required).toBe(true)
    save('mfaScope', 'all')
    save('mfaRoles', ['admin'])
    expect(users.mfaRequirement(u, Date.now()).required).toBe(true)
  })

  it('treats the .env scope as a floor the stored value cannot lower', async () => {
    const users = withEnv({ DBLOOM_MFA_SCOPE: 'all' })
    const u = await users.create(newUser('mfa-user3'), 'setup')
    save('mfaScope', 'none')
    expect(users.mfaRequirement(u, Date.now()).required).toBe(true)
  })

  it('ends the grace period after the configured time, counted from the later of creation and policy change', async () => {
    const now = 1_000_000
    const users = withEnv({}, () => now)
    const u = await users.create(newUser('mfa-user4'), 'setup')
    save('mfaScope', 'all', now)
    save('mfaGraceMs', 3 * DAY)
    expect(users.mfaRequirement(u, now)).toEqual({ required: true, graceEnded: false })
    expect(users.mfaRequirement(u, now + 3 * DAY - 1).graceEnded).toBe(false)
    expect(users.mfaRequirement(u, now + 3 * DAY).graceEnded).toBe(true)
  })

  it('caps the stored grace at the .env grace and gives administrators none', async () => {
    const users = withEnv({ DBLOOM_MFA_GRACE_DAYS: '1' })
    const u = await users.create(newUser('mfa-user5'), 'setup')
    const a = await users.create(newUser('mfa-admin2', 'admin'), 'setup')
    save('mfaScope', 'all', 5)
    save('mfaGraceMs', 7 * DAY)
    expect(users.mfaRequirement(u, u.createdAt + DAY - 1).graceEnded).toBe(false)
    expect(users.mfaRequirement(u, u.createdAt + DAY).graceEnded).toBe(true)
    expect(users.mfaRequirement(a, 0).graceEnded).toBe(true)
  })
})

describe('settings resolver: units, Argon2 floors, defaults', () => {
  it('converts duration variables from their unit to milliseconds', () => {
    const s = createAuthSettingsResolver(store.accounts, {
      DBLOOM_TEMP_PASSWORD_HOURS: '48',
      DBLOOM_ADMIN_SESSION_IDLE_MINUTES: '10',
      DBLOOM_ADMIN_SESSION_ABSOLUTE_HOURS: '2',
      DBLOOM_MFA_GRACE_DAYS: '2',
    }).resolve()
    expect(s.tempPasswordMs).toBe(48 * 3_600_000)
    expect(s.adminSessionIdleMs).toBe(10 * 60_000)
    expect(s.adminSessionAbsoluteMs).toBe(2 * 3_600_000)
    expect(s.mfaGraceMs).toBe(2 * DAY)
  })

  it('reads the Argon2 env names and keeps values above the minimum', () => {
    const s = createAuthSettingsResolver(store.accounts, {
      DBLOOM_ARGON2_MEMORY_MIB: '96', DBLOOM_ARGON2_PASSES: '4', DBLOOM_ARGON2_PARALLELISM: '2',
      DBLOOM_VAULT_ARGON2_MEMORY_MIB: '256',
    }).resolve()
    expect(s.argon2Login).toEqual({ memoryKiB: 96 * 1024, passes: 4, parallelism: 2 })
    expect(s.argon2Vault).toEqual({ memoryKiB: 256 * 1024, passes: 3, parallelism: 1 })
  })

  it('raises Argon2 values below the code minimum, field by field', () => {
    const s = createAuthSettingsResolver(store.accounts, {
      DBLOOM_ARGON2_MEMORY_MIB: '4', DBLOOM_ARGON2_PASSES: '1', DBLOOM_ARGON2_PARALLELISM: '99',
      DBLOOM_VAULT_ARGON2_MEMORY_MIB: '8', DBLOOM_VAULT_ARGON2_PASSES: '1',
    }).resolve()
    expect(s.argon2Login).toEqual({ memoryKiB: ARGON2_LOGIN_MIN.memoryKiB, passes: ARGON2_LOGIN_MIN.passes, parallelism: 16 })
    expect(s.argon2Vault).toEqual(ARGON2_VAULT_MIN)
  })

  it('ignores unusable Argon2 env values', () => {
    const s = createAuthSettingsResolver(store.accounts, { DBLOOM_ARGON2_MEMORY_MIB: 'lots', DBLOOM_ARGON2_PASSES: '-3' }).resolve()
    expect(s.argon2Login).toEqual(ARGON2_LOGIN_DEFAULT)
  })

  it('has defaults matching the former hard-coded values', () => {
    const s = createAuthSettingsResolver(store.accounts, {}).resolve()
    expect([s.sessionsPerAdmin, s.sessionsPerUser]).toEqual([2, 5])
    expect(s.tempPasswordMs).toBe(7 * DAY)
    expect([s.adminSessionIdleMs, s.adminSessionAbsoluteMs]).toEqual([15 * 60_000, 4 * 3_600_000])
  })

  it('ignores a stored value that no longer parses', () => {
    store.accounts.setSetting({ key: 'mfaScope', value: '"everyone"', updatedAt: 1, updatedBy: 'x' })
    expect(createAuthSettingsResolver(store.accounts, {}).resolve().mfaScope).toBe('none')
  })
})

describe('settings-driven users and sessions', () => {
  const meta = { clientHint: 'Firefox', address: '127.0.0.1' }
  const config = { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 12 * 3_600_000 }
  const sessionSettings = (over: Partial<SessionSettings> = {}): SessionSettings => ({
    sessionsPerUser: 5, sessionsPerAdmin: 2, adminSessionIdleMs: 15 * 60_000, adminSessionAbsoluteMs: 4 * 3_600_000,
    vaultAutoLockMs: 15 * 60_000, ...over,
  })

  it('sets the temporary password expiry from the setting', async () => {
    const fixed: UserServiceSettings = { mfaScope: 'none', mfaRoles: [], mfaGraceMs: 0, tempPasswordMs: 3_600_000 }
    const users = createUserService(store.accounts, fakeHash, () => 1000, () => fixed)
    const user = await users.create(newUser('temp-user'), 'setup', { temporary: true })
    expect(user.tempPasswordExpiresAt).toBe(1000 + 3_600_000)
  })

  it('takes the session limit per role from the settings', async () => {
    let now = 1_000_000
    const sessions = new SessionManager(store, config, () => now, () => sessionSettings({ sessionsPerUser: 2, sessionsPerAdmin: 3 }))
    const users = createUserService(store.accounts, fakeHash)
    const u = await users.create(newUser('lim-user'), 'setup')
    const a = await users.create(newUser('lim-admin', 'admin'), 'setup')
    const evictedFor = (user: User, count: number) => {
      let last: string[] = []
      for (let i = 0; i < count; i += 1) {
        now += 1000
        last = sessions.createAccount(user, 'full', meta).evicted
      }
      return last
    }
    expect(evictedFor(u, 3)).toHaveLength(1)
    expect(evictedFor(a, 3)).toHaveLength(0)
    expect(evictedFor(a, 1)).toHaveLength(1)
  })

  it('applies the administrator idle and absolute times, not the Config ones', async () => {
    let now = 1_000_000
    const sessions = new SessionManager(store, config, () => now, () => sessionSettings({ adminSessionIdleMs: 60_000, adminSessionAbsoluteMs: 5 * 60_000 }))
    const users = createUserService(store.accounts, fakeHash)
    const a = await users.create(newUser('idle-admin', 'admin'), 'setup')
    const u = await users.create(newUser('idle-user'), 'setup')
    const admin = sessions.createAccount(a, 'full', meta)
    const user = sessions.createAccount(u, 'full', meta)
    now += 61_000
    expect(sessions.resolveAccount(admin.token, { background: false })).toBeUndefined()
    expect(sessions.resolveAccount(user.token, { background: false })).toBeDefined()
    const again = sessions.createAccount(a, 'full', meta)
    for (let i = 0; i < 5; i += 1) {
      now += 50_000
      expect(sessions.resolveAccount(again.token, { background: false })).toBeDefined()
    }
    now += 50_000
    expect(sessions.resolveAccount(again.token, { background: false })).toBeUndefined()
  })

  it('drops the vault key after the auto-lock time and counts reads as activity', async () => {
    let now = 1_000_000
    const sessions = new SessionManager(store, config, () => now, () => sessionSettings({ vaultAutoLockMs: 60_000 }))
    const users = createUserService(store.accounts, fakeHash)
    const u = await users.create(newUser('vault-user'), 'setup')
    const { token } = sessions.createAccount(u, 'full', meta)
    const { idHash } = sessions.resolveAccount(token, { background: false })!
    const key = Buffer.alloc(32, 9)
    sessions.setVaultKey(idHash, key)
    now += 59_000
    expect(sessions.getVaultKey(idHash, now)).toBe(key)
    now += 59_000
    expect(sessions.getVaultKey(idHash, now)).toBe(key)
    now += 60_000
    expect(sessions.getVaultKey(idHash, now)).toBeUndefined()
    expect(key.equals(Buffer.alloc(32))).toBe(true)
    expect(sessions.getVaultKey(idHash, now)).toBeUndefined()
  })

  it('never keeps the vault key longer than the session idle limit', async () => {
    let now = 1_000_000
    const sessions = new SessionManager(store, { sessionIdleMs: 120_000, sessionAbsoluteMs: 3_600_000 }, () => now, () => sessionSettings({ vaultAutoLockMs: 3_600_000 }))
    const users = createUserService(store.accounts, fakeHash)
    const u = await users.create(newUser('vault-user2'), 'setup')
    const { token } = sessions.createAccount(u, 'full', meta)
    const { idHash } = sessions.resolveAccount(token, { background: true })!
    sessions.setVaultKey(idHash, Buffer.alloc(32, 1))
    now += 121_000
    expect(sessions.getVaultKey(idHash, now)).toBeUndefined()
  })
})
