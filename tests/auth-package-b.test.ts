/** Package B: account store, user/settings/throttle services and account sessions (SPEC/26 tasks 3 and 4). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SessionManager } from '~/server/sessions'
import { createUserService } from '~/server/auth/users'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { BackoffThrottle } from '~/server/auth/throttle'
import { ARGON2_LOGIN_DEFAULT, AuthError, type AuthUser, type LinkTokenRecord, type User } from '~/server/auth/types'

let dir: string
let store: SqliteStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-authb-'))
  store = openSqliteStore(join(dir, 'store.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const fakeHash = async (pw: string) => `$phc$${pw}`
const admin: AuthUser = { id: 'setup-admin', username: 'root', displayName: 'Root', role: 'admin', securityVersion: 0 }
const newUser = (name: string, role: 'admin' | 'user' = 'user') => ({
  username: name,
  displayName: name,
  role,
  password: 'correct horse battery',
})

describe('account store', () => {
  it('migration 5 keeps direct sessions working with default columns', () => {
    store.createSession({ idHash: 'h1', targetKey: 'db:3306', userName: 'root', createdAt: 1, lastSeenAt: 1, expiresAt: 9 })
    const row = store.accounts.getAccountSession('h1')
    expect(row).toMatchObject({ kind: 'direct', userId: null, state: 'full', securityVersion: 0 })
  })

  it('maps token rows to the LinkTokenRecord shape', () => {
    const users = createUserService(store.accounts, fakeHash)
    return users.create(newUser('carol'), 'setup').then((user: User) => {
      const record: LinkTokenRecord = {
        id: 't1', kind: 'recovery', tokenHash: 'ab'.repeat(32), userId: user.id, role: null,
        createdBy: 'setup', createdAt: 10, expiresAt: 100, usedAt: null, revokedAt: null,
      }
      store.accounts.addToken(record)
      expect(store.accounts.getTokenByHash(record.tokenHash)).toEqual(record)
      store.accounts.addToken({ ...record, id: 't2', kind: 'invite', tokenHash: 'cd'.repeat(32), userId: null, role: 'user' })
      expect(store.accounts.listOpenInvites(50)).toEqual([
        { ...record, id: 't2', kind: 'invite', tokenHash: 'cd'.repeat(32), userId: null, role: 'user' },
      ])
    })
  })

  it('redeems a token only once and not after expiry', () => {
    store.accounts.addToken({
      id: 't1', kind: 'invite', tokenHash: 'ab'.repeat(32), userId: null, role: 'user',
      createdBy: 'x', createdAt: 1, expiresAt: 100, usedAt: null, revokedAt: null,
    })
    expect(store.accounts.markTokenUsed('t1', 200)).toBe(false)
    expect(store.accounts.markTokenUsed('t1', 50)).toBe(true)
    expect(store.accounts.markTokenUsed('t1', 60)).toBe(false)
  })

  it('advances the TOTP step only forward', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser('dan'), 'setup')
    store.accounts.setTotp({ userId: user.id, sealed: 's', lastStep: 5, createdAt: 1 })
    expect(store.accounts.advanceTotpStep(user.id, 5)).toBe(false)
    expect(store.accounts.advanceTotpStep(user.id, 6)).toBe(true)
    expect(store.accounts.advanceTotpStep(user.id, 6)).toBe(false)
  })

  it('consumes a recovery code once', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser('eve'), 'setup')
    store.accounts.replaceRecoveryCodes(user.id, ['m1', 'm2'], 1)
    expect(store.accounts.consumeRecoveryCode(user.id, 'm1')).toBe(true)
    expect(store.accounts.consumeRecoveryCode(user.id, 'm1')).toBe(false)
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(1)
  })

  it('cascades a deleted user to its credentials and sessions', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser('fay'), 'setup')
    store.accounts.replaceRecoveryCodes(user.id, ['m1'], 1)
    store.createSession({ idHash: 's1', targetKey: '', userName: '', createdAt: 1, lastSeenAt: 1, expiresAt: 9 })
    store.accounts.createAccountSession({
      idHash: 's1', targetKey: '', userName: '', createdAt: 1, lastSeenAt: 1, expiresAt: 9, kind: 'account',
      userId: user.id, state: 'full', mfaAt: null, stepupAt: null, securityVersion: 0, clientHint: '', address: '',
    })
    store.accounts.deleteUser(user.id)
    expect(store.accounts.getPassword(user.id)).toBeUndefined()
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(0)
    expect(store.accounts.getAccountSession('s1')).toBeUndefined()
  })
})

describe('user service', () => {
  it('stores a unique, case-folded, NFKC-normalised user name', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create({ ...newUser('Walther'), username: 'Walther' }, 'setup')
    expect(user.usernameKey).toBe('walther')
    await expect(users.create(newUser('WALTHER'), admin)).rejects.toMatchObject({ code: 'auth_failed' })
  })

  it('rejects an invalid user name', async () => {
    const users = createUserService(store.accounts, fakeHash)
    await expect(users.create(newUser('no spaces allowed'), 'setup')).rejects.toBeInstanceOf(AuthError)
  })

  it('leaves no user behind when hashing fails', async () => {
    const failing = createUserService(store.accounts, async () => {
      throw new AuthError('auth_throttled')
    })
    await expect(failing.create(newUser('gil'), 'setup')).rejects.toMatchObject({ code: 'auth_throttled' })
    expect(store.accounts.listUsers()).toEqual([])
  })

  it('stores a real hash, never an empty one', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser('hal'), 'setup')
    expect(store.accounts.getPassword(user.id)?.phc).toBe('$phc$correct horse battery')
  })

  it('never removes, disables or demotes the last active admin', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const only = await users.create(newUser('boss', 'admin'), 'setup')
    expect(() => users.setStatus(only.id, 'disabled', admin)).toThrow(AuthError)
    expect(() => users.setRole(only.id, 'user', admin)).toThrow(AuthError)
    expect(() => users.delete(only.id, admin)).toThrow(AuthError)
    const second = await users.create(newUser('deputy', 'admin'), 'setup')
    users.setRole(second.id, 'user', admin)
    expect(store.accounts.countActiveAdmins()).toBe(1)
  })

  it('may delete a disabled admin while another admin is active', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const a = await users.create(newUser('adm-a', 'admin'), 'setup')
    const b = await users.create(newUser('adm-b', 'admin'), 'setup')
    users.setStatus(b.id, 'disabled', admin)
    expect(() => users.delete(b.id, admin)).not.toThrow()
    expect(store.accounts.getUser(a.id)).toBeDefined()
  })

  it('bumps the security version and ends other sessions', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser('ivo'), 'setup')
    for (const id of ['s1', 's2']) {
      store.createSession({ idHash: id, targetKey: '', userName: '', createdAt: 1, lastSeenAt: 1, expiresAt: 9 })
      store.accounts.createAccountSession({
        idHash: id, targetKey: '', userName: '', createdAt: 1, lastSeenAt: 1, expiresAt: 9, kind: 'account',
        userId: user.id, state: 'full', mfaAt: null, stepupAt: null, securityVersion: 0, clientHint: '', address: '',
      })
    }
    users.bumpSecurityVersion(user.id, 's1')
    expect(store.accounts.getUser(user.id)?.securityVersion).toBe(1)
    expect(store.accounts.getAccountSession('s1')).toBeDefined()
    expect(store.accounts.getAccountSession('s2')).toBeUndefined()
  })
})

describe('settings resolver', () => {
  it('returns the defaults without env or saved values', () => {
    const settings = createAuthSettingsResolver(store.accounts, {}).resolve()
    expect(settings.argon2Login).toEqual(ARGON2_LOGIN_DEFAULT)
    expect(settings.breachedCheck).toBe(false)
    expect(settings.setupNetworks).toEqual([])
    expect(settings.publicOrigin).toBeNull()
  })

  it('reads a public origin and derives the relying party id', () => {
    const settings = createAuthSettingsResolver(store.accounts, {
      DBLOOM_PUBLIC_ORIGIN: 'https://dbloom.example.org:8443',
      DBLOOM_SETUP_NETWORKS: '10.0.0.0/8, 192.168.0.0/16',
    }).resolve()
    expect(settings.rpId).toBe('dbloom.example.org')
    expect(settings.setupNetworks).toEqual(['10.0.0.0/8', '192.168.0.0/16'])
  })

  it('clamps a numeric setting to its floor and ceiling', () => {
    const low = createAuthSettingsResolver(store.accounts, { DBLOOM_SESSIONS_PER_USER: '0' }).resolve()
    expect(low.sessionsPerUser).toBe(1)
    const high = createAuthSettingsResolver(store.accounts, { DBLOOM_SESSIONS_PER_USER: '9999' }).resolve()
    expect(high.sessionsPerUser).toBe(20)
  })

  it('ignores a saved value for an env-only setting', () => {
    const resolver = createAuthSettingsResolver(store.accounts, {})
    store.accounts.setSetting({
      key: 'argon2Login', value: JSON.stringify({ memoryKiB: 1024, passes: 1, parallelism: 1 }), updatedAt: 1, updatedBy: 'x',
    })
    expect(resolver.resolve().argon2Login).toEqual(ARGON2_LOGIN_DEFAULT)
  })
})

describe('throttle', () => {
  it('lets the first failures through, then backs off up to the cap', () => {
    let now = 1_000_000
    const throttle = new BackoffThrottle(3, 60_000, 8_000, () => now)
    const key = 'user:walther' as never
    throttle.fail(key)
    throttle.fail(key)
    expect(throttle.delayMs(key)).toBe(0)
    throttle.fail(key)
    expect(throttle.delayMs(key)).toBe(1000)
    throttle.fail(key)
    expect(throttle.delayMs(key)).toBe(2000)
    for (let i = 0; i < 20; i += 1) throttle.fail(key)
    expect(throttle.delayMs(key)).toBe(8000)
    now += 3000
    expect(throttle.delayMs(key)).toBe(5000)
  })

  it('forgets a key after the window and on reset', () => {
    let now = 0
    const throttle = new BackoffThrottle(1, 1000, 8_000, () => now)
    const key = 'ip:1.2.3.4' as never
    throttle.fail(key)
    expect(throttle.delayMs(key)).toBeGreaterThan(0)
    now += 1001
    expect(throttle.delayMs(key)).toBe(0)
    throttle.fail(key)
    throttle.reset(key)
    expect(throttle.delayMs(key)).toBe(0)
  })

  it('does not grow without bound under many distinct keys', () => {
    let now = 0
    const throttle = new BackoffThrottle(5, 1000, 8_000, () => now)
    for (let i = 0; i < 20_000; i += 1) {
      now += 1
      throttle.fail(`ip:${i}` as never)
    }
    expect(throttle.size()).toBeLessThanOrEqual(10_001)
  })
})

describe('account sessions', () => {
  const config = { sessionIdleMs: 1000 * 60 * 30, sessionAbsoluteMs: 1000 * 60 * 60 * 8 }
  const meta = { clientHint: 'Firefox', address: '127.0.0.1' }
  const setup = async (role: 'admin' | 'user' = 'user') => {
    let now = 1_000_000
    const sessions = new SessionManager(store, config, () => now)
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser(role === 'admin' ? 'sess-admin' : 'sess-user', role), 'setup')
    return { sessions, user, tick: (ms: number) => (now += ms) }
  }

  it('creates a session that resolves with its owner key and csrf', async () => {
    const { sessions, user } = await setup()
    const { token, csrf } = sessions.createAccount(user, 'full', meta)
    const context = sessions.resolveAccount(token, { background: false })
    expect(context).toMatchObject({ kind: 'account', ownerKey: `u:${user.id}`, csrf, state: 'full' })
    expect(sessions.resolveAccount('nope', { background: false })).toBeUndefined()
    expect(sessions.resolveAccount(undefined, { background: false })).toBeUndefined()
  })

  it('refuses a session after the security version changed or the user is disabled', async () => {
    const { sessions, user } = await setup()
    const first = sessions.createAccount(user, 'full', meta)
    store.accounts.updateUser(user.id, { securityVersion: 1 })
    expect(sessions.resolveAccount(first.token, { background: false })).toBeUndefined()

    const fresh = sessions.createAccount(store.accounts.getUser(user.id)!, 'full', meta)
    expect(sessions.resolveAccount(fresh.token, { background: false })).toBeDefined()
    store.accounts.updateUser(user.id, { status: 'disabled' })
    expect(sessions.resolveAccount(fresh.token, { background: false })).toBeUndefined()
  })

  it('expires on idle time, and a background request does not extend it', async () => {
    const { sessions, user, tick } = await setup()
    const { token } = sessions.createAccount(user, 'full', meta)
    tick(config.sessionIdleMs - 1000)
    expect(sessions.resolveAccount(token, { background: true })).toBeDefined()
    tick(2000)
    expect(sessions.resolveAccount(token, { background: false })).toBeUndefined()
  })

  it('rotates the token on a state transition and drops the old one', async () => {
    const { sessions, user } = await setup()
    const { token } = sessions.createAccount(user, 'pending_mfa', meta)
    const next = sessions.transition(token, { state: 'full', mfaAt: 5 })
    expect(next.token).not.toBe(token)
    expect(sessions.resolveAccount(token, { background: false })).toBeUndefined()
    expect(sessions.resolveAccount(next.token, { background: false })).toMatchObject({ state: 'full', mfaAt: 5 })
  })

  it('a session that leaves pending_mfa counts against the limit and evicts the oldest full one (FR-AUT-017)', async () => {
    const { sessions, user, tick } = await setup('admin') // admin limit is 2
    const a = sessions.createAccount(user, 'full', meta)
    tick(1000)
    const b = sessions.createAccount(user, 'full', meta)
    tick(1000)
    // A password-only session does not count and evicts nobody ...
    const pending = sessions.createAccount(user, 'pending_mfa', meta)
    expect(pending.evicted).toEqual([])
    expect(sessions.resolveAccount(a.token, { background: true })).toBeDefined() // a background read keeps its place in the order
    // ... until the second factor makes it a full one: now the oldest full session goes.
    tick(1000)
    const next = sessions.transition(pending.token, { state: 'full', mfaAt: 1 })
    expect(next.evicted).toEqual([createHash('sha256').update(a.token).digest('hex')])
    expect(sessions.resolveAccount(a.token, { background: false })).toBeUndefined()
    expect(sessions.resolveAccount(b.token, { background: false })).toBeDefined()
    expect(sessions.resolveAccount(next.token, { background: false })).toMatchObject({ state: 'full' })
    // A step-up transition of a full session evicts nobody.
    expect(sessions.transition(next.token, { stepupAt: 9 }).evicted).toEqual([])
  })

  it('evicts the least recently used session of a user over the limit, and only that one', async () => {
    const { sessions, user, tick } = await setup('admin') // admin limit is 2
    const first = sessions.createAccount(user, 'full', meta)
    tick(1000)
    const second = sessions.createAccount(user, 'full', meta)
    tick(1000)
    const third = sessions.createAccount(user, 'full', meta)
    expect(third.evicted).toEqual([createHash('sha256').update(first.token).digest('hex')])
    expect(sessions.resolveAccount(first.token, { background: false })).toBeUndefined()
    // The kept session still has its live runtime: a lost csrf would mean it was dropped from memory.
    expect(sessions.resolveAccount(second.token, { background: false })?.csrf).toBe(second.csrf)
    expect(sessions.resolveAccount(third.token, { background: false })?.csrf).toBe(third.csrf)
  })

  it('caps pending_mfa sessions separately and never lets them evict full ones', async () => {
    const { sessions, user, tick } = await setup('admin') // admin limit is 2
    const full = [sessions.createAccount(user, 'full', meta), sessions.createAccount(user, 'full', meta)]
    const pendings: string[] = []
    for (let i = 0; i < 7; i += 1) {
      tick(1000)
      const p = sessions.createAccount(user, 'pending_mfa', meta)
      pendings.push(p.token)
      if (i < 5) expect(p.evicted).toEqual([])
    }
    for (const f of full) expect(sessions.resolveAccount(f.token, { background: true })).toBeDefined()
    expect(sessions.resolveAccount(pendings[0], { background: true })).toBeUndefined()
    expect(sessions.resolveAccount(pendings[1], { background: true })).toBeUndefined()
    expect(sessions.resolveAccount(pendings[6], { background: true })).toBeDefined()
    // A real sign-in evicts the oldest real session, not a pending one.
    tick(1000)
    expect(sessions.createAccount(user, 'full', meta).evicted).toHaveLength(1)
    expect(sessions.resolveAccount(pendings[6], { background: true })).toBeDefined()
  })

  it('peekVaultKey does not extend the vault; getVaultKey does', async () => {
    const { sessions, user, tick } = await setup()
    const { token } = sessions.createAccount(user, 'full', meta)
    const idHash = createHash('sha256').update(token).digest('hex')
    sessions.setVaultKey(idHash, Buffer.alloc(32, 1))
    const lockAt = sessions.vaultLockAt(idHash)!
    tick(1000)
    const at = 1_001_000
    expect(sessions.peekVaultKey(idHash, at)).toBeDefined()
    expect(sessions.vaultLockAt(idHash)).toBe(lockAt)
    sessions.getVaultKey(idHash, at)
    expect(sessions.vaultLockAt(idHash)).toBeGreaterThan(lockAt)
  })

  it('store transactions nest as savepoints: inner failure rolls back only itself', async () => {
    const users = createUserService(store.accounts, fakeHash)
    const user = await users.create(newUser('nest'), 'setup')
    store.accounts.transaction(() => {
      store.accounts.replaceRecoveryCodes(user.id, ['m1'], 1)
      expect(() => store.accounts.transaction(() => { store.accounts.replaceRecoveryCodes(user.id, ['m2'], 2); throw new Error('x') })).toThrow('x')
    })
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(1)
    expect(store.accounts.consumeRecoveryCode(user.id, 'm1')).toBe(true)
  })

  it('does not touch the sessions of another user when evicting', async () => {
    const { sessions, user, tick } = await setup('admin')
    const users = createUserService(store.accounts, fakeHash)
    const other = await users.create(newUser('bystander'), 'setup')
    const bystander = sessions.createAccount(other, 'full', meta)
    for (let i = 0; i < 4; i += 1) {
      tick(1000)
      sessions.createAccount(user, 'full', meta)
    }
    expect(sessions.resolveAccount(bystander.token, { background: false })).toBeDefined()
  })

  it('closes connection pools and zeroes the vault key when the session ends', async () => {
    const { sessions, user } = await setup()
    const { token } = sessions.createAccount(user, 'full', meta)
    const context = sessions.resolveAccount(token, { background: false })!
    let ended = 0
    const pool = { end: async () => void (ended += 1) } as never
    sessions.addConnection(context.idHash, {
      connectionId: 'c1', target: { host: 'db', port: 3306, username: 'u' }, pool, readOnly: false,
    } as never)
    const key = Buffer.alloc(32, 7)
    sessions.setVaultKey(context.idHash, key)
    await sessions.destroy(token)
    expect(ended).toBe(1)
    expect(key.equals(Buffer.alloc(32))).toBe(true)
    expect(sessions.listConnections(context.idHash)).toEqual([])
  })
})
