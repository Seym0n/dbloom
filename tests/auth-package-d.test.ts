/** Package D: connections, vault, profiles (SPEC/26 task 8). Pools are fakes; integration against MySQL/MariaDB is separate. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SessionManager } from '~/server/sessions'
import { createUserService } from '~/server/auth/users'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { BackoffThrottle } from '~/server/auth/throttle'
import { LoginFailedError } from '~/server/auth'
import { createAccountServices, createTargetConnectRules, type AccountServices } from '~/server/auth/connections'
import { clampTls } from '~/server/auth/profiles'
import { AuthError, MAX_PROFILES_PER_USER, saveProfileInput, type AccountContext, type AccountLiveSession, type AuthErrorCode, type ResolvedAuthSettings, type SaveProfileInput } from '~/server/auth/types'
import type { Config } from '~/server/config'
import type { TargetKey } from '~/server/target'

let dir: string
let store: SqliteStore
let sessions: SessionManager
let throttle: BackoffThrottle
let svc: AccountServices
let ctx: AccountContext
let opens: Array<{ target: TargetKey; password: string; extras: Record<string, unknown> }>
let failHosts: Set<string>
let sqlLog: string[]
let overrides: Partial<ResolvedAuthSettings>
let version: string
let knownCollations: Set<string>

const config = { tls: 'verify', sessionIdleMs: 3_600_000, sessionAbsoluteMs: 86_400_000, connectTimeoutMs: 1000, allowedTargets: [], readOnly: false } as unknown as Config
const PASS = 'a long vault passphrase 1'

function fakePool(host: string) {
  const conn = { destroy: () => undefined, release: () => undefined, query: async (sql: string) => { sqlLog.push(`${host}|${sql}`); return [[], []] } }
  return {
    ended: false,
    async end() { this.ended = true },
    on() { return this },
    async getConnection() { return conn },
    async query(sql: string, values?: unknown[]) {
      sqlLog.push(`${host}|${sql}`)
      if (/SHOW COLLATION/.test(sql)) return [knownCollations.has(String(values?.[0])) ? [{ Collation: values![0] }] : [], []]
      if (/SCHEMATA/.test(sql)) return [values?.[0] === 'app' ? [{ 1: 1 }] : [], []]
      if (/VERSION/.test(sql)) return [[{ v: version }], []]
      return [[], []]
    },
  }
}

const body = (error: unknown) => (error as AuthError).code as AuthErrorCode | undefined
async function code(p: Promise<unknown> | (() => unknown)): Promise<AuthErrorCode | string> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (error) {
    return body(error) ?? (error as Error).name
  }
  return 'no error'
}

const profileInput = (patch: Partial<SaveProfileInput> = {}, creds: Partial<NonNullable<SaveProfileInput['credentials']>> = {}): SaveProfileInput =>
  saveProfileInput.parse({ name: 'prod', host: 'db.example.com', credentials: { user: 'app', password: 'secret-pw', ...creds }, ...patch })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-authd-'))
  store = openSqliteStore(join(dir, 'store.db'))
  sessions = new SessionManager(store, config)
  throttle = new BackoffThrottle(5, 900_000, 900_000)
  opens = []
  failHosts = new Set()
  sqlLog = []
  overrides = {}
  version = '8.4.0'
  knownCollations = new Set(['utf8mb4_bin'])
  const resolver = createAuthSettingsResolver(store.accounts)
  const users = createUserService(store.accounts, async (p) => `$phc$${p}`)
  const user = await users.create({ username: 'alice', displayName: 'Alice', role: 'user', password: 'x' }, 'setup')
  const created = sessions.createAccount(user, 'full', { clientHint: 'test', address: '127.0.0.1' })
  ctx = sessions.resolveAccount(created.token, { background: false })!
  svc = createAccountServices({
    store: store.accounts,
    sessions,
    config,
    throttle,
    settings: () => ({ ...resolver.resolve(), argon2Vault: { memoryKiB: 1024, passes: 1, parallelism: 1 }, vaultPassphraseMin: 12, ...overrides }),
    resolveAddress: async () => '127.0.0.1',
    openPool: (async (target: TargetKey, _a: string, password: string, _c: Config, extras: Record<string, unknown> = {}) => {
      opens.push({ target, password, extras })
      if (failHosts.has(target.host)) throw new Error('ECONNREFUSED')
      return fakePool(target.host)
    }) as never,
  })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('vault', () => {
  it('creates, locks, unlocks and reports status', async () => {
    expect(svc.vault.status(ctx)).toMatchObject({ exists: false, unlocked: false, enabled: true })
    const { recoveryKey } = await svc.vault.create(ctx, PASS)
    expect(recoveryKey).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$|^[0-9A-Z -]{32,}$/)
    expect(svc.vault.status(ctx)).toMatchObject({ exists: true, unlocked: true })
    svc.vault.lock(ctx)
    expect(svc.vault.status(ctx).unlocked).toBe(false)
    await svc.vault.unlock(ctx, PASS)
    expect(svc.vault.status(ctx).unlocked).toBe(true)
  })

  it('refuses short passphrases, a second vault, and a disabled feature', async () => {
    expect(await code(svc.vault.create(ctx, 'short'))).toBe('password_rejected')
    overrides = { personalProfiles: false }
    expect(await code(svc.vault.create(ctx, PASS))).toBe('vault_absent')
    overrides = {}
    await svc.vault.create(ctx, PASS)
    expect(await code(svc.vault.create(ctx, PASS))).toBe('auth_failed')
  })

  it('wrong passphrase gives vault_locked, counts on the account throttle and then throttles', async () => {
    await svc.vault.create(ctx, PASS)
    svc.vault.lock(ctx)
    for (let i = 0; i < 5; i++) expect(await code(svc.vault.unlock(ctx, 'wrong passphrase!!'))).toBe('vault_locked')
    expect(throttle.delayMs('acct:alice')).toBeGreaterThan(0)
    expect(await code(svc.vault.unlock(ctx, PASS))).toBe('auth_throttled')
  })

  it('unlock without a vault gives vault_absent', async () => {
    expect(await code(svc.vault.unlock(ctx, PASS))).toBe('vault_absent')
  })

  it('changes the passphrase and keeps profiles readable', async () => {
    await svc.vault.create(ctx, PASS)
    await svc.profiles.save(ctx, profileInput())
    await svc.vault.changePassphrase(ctx, PASS, 'another long passphrase 2')
    svc.vault.lock(ctx)
    expect(await code(svc.vault.unlock(ctx, PASS))).toBe('vault_locked')
    await svc.vault.unlock(ctx, 'another long passphrase 2')
    expect(svc.profiles.list(ctx)[0]).toMatchObject({ name: 'prod', targetUser: 'app' })
  })

  it('wrong current passphrase leaves the vault unchanged', async () => {
    await svc.vault.create(ctx, PASS)
    expect(await code(svc.vault.changePassphrase(ctx, 'not the passphrase', 'another long passphrase 2'))).toBe('vault_locked')
    svc.vault.lock(ctx)
    await svc.vault.unlock(ctx, PASS)
  })

  it('recovery key unlocks, forces a new passphrase and a new recovery key', async () => {
    const { recoveryKey } = await svc.vault.create(ctx, PASS)
    await svc.profiles.save(ctx, profileInput())
    svc.vault.lock(ctx)
    const next = await svc.vault.useRecoveryKey(ctx, recoveryKey, 'brand new long passphrase')
    expect(next.recoveryKey).not.toBe(recoveryKey)
    expect(svc.profiles.list(ctx)[0]?.targetUser).toBe('app')
    svc.vault.lock(ctx)
    expect(await code(svc.vault.unlock(ctx, PASS))).toBe('vault_locked')
    expect(await code(svc.vault.useRecoveryKey(ctx, recoveryKey, 'yet another long passphrase'))).toBe('vault_locked')
    await svc.vault.unlock(ctx, 'brand new long passphrase')
  })

  it('regenerating the recovery key invalidates the old one', async () => {
    const first = await svc.vault.create(ctx, PASS)
    const second = svc.vault.regenerateRecoveryKey(ctx)
    expect(second.recoveryKey).not.toBe(first.recoveryKey)
    svc.vault.lock(ctx)
    expect(await code(svc.vault.useRecoveryKey(ctx, first.recoveryKey, 'brand new long passphrase'))).toBe('vault_locked')
    await svc.vault.useRecoveryKey(ctx, second.recoveryKey, 'brand new long passphrase')
  })

  it('regenerate needs an unlocked vault', async () => {
    await svc.vault.create(ctx, PASS)
    svc.vault.lock(ctx)
    expect(await code(() => svc.vault.regenerateRecoveryKey(ctx))).toBe('vault_locked')
  })

  it('rotating the key re-encrypts every profile and issues a new recovery key', async () => {
    const first = await svc.vault.create(ctx, PASS)
    await svc.profiles.save(ctx, profileInput({ name: 'a' }))
    await svc.profiles.save(ctx, profileInput({ name: 'b' }, { user: 'other' }))
    const before = store.accounts.listProfiles(ctx.user!.id).map((p) => p.sealed)
    const rotated = await svc.vault.rotateKey(ctx, PASS)
    expect(rotated.recoveryKey).not.toBe(first.recoveryKey)
    expect(store.accounts.listProfiles(ctx.user!.id).map((p) => p.sealed)).not.toEqual(before)
    svc.vault.lock(ctx)
    await svc.vault.unlock(ctx, PASS)
    expect(svc.profiles.list(ctx).map((p) => p.targetUser).sort()).toEqual(['app', 'other'])
    expect(await code(svc.vault.rotateKey(ctx, 'wrong passphrase!!'))).toBe('vault_locked')
  })

  it('every function needs a full account session', async () => {
    expect(await code(svc.vault.create({ ...ctx, state: 'must_change' }, PASS))).toBe('auth_failed')
    expect(await code(svc.vault.create({ ...ctx, user: null }, PASS))).toBe('auth_failed')
  })
})

describe('profiles', () => {
  it('needs an unlocked vault to save, and says which problem', async () => {
    expect(await code(svc.profiles.save(ctx, profileInput()))).toBe('vault_absent')
    await svc.vault.create(ctx, PASS)
    svc.vault.lock(ctx)
    expect(await code(svc.profiles.save(ctx, profileInput()))).toBe('vault_locked')
  })

  it('seals the secret, lists metadata while locked and the user name only while unlocked', async () => {
    await svc.vault.create(ctx, PASS)
    const saved = await svc.profiles.save(ctx, profileInput())
    expect(saved.test).toBe('ok')
    const row = store.accounts.listProfiles(ctx.user!.id)[0]!
    expect(row.sealed).not.toContain('secret-pw')
    expect(JSON.stringify(row)).not.toContain('secret-pw')
    expect(JSON.stringify(saved)).not.toContain('secret-pw')
    svc.vault.lock(ctx)
    const locked = svc.profiles.list(ctx)[0]!
    expect(locked).toMatchObject({ name: 'prod', host: 'db.example.com', port: 3306, tls: 'verify' })
    expect(locked.targetUser).toBeUndefined()
    expect('sealed' in locked || 'userId' in locked).toBe(false)
  })

  it('refuses a failing test with the generic message, saves it with saveAnyway', async () => {
    await svc.vault.create(ctx, PASS)
    failHosts.add('down.example.com')
    const err = await svc.profiles.save(ctx, profileInput({ host: 'down.example.com' })).catch((e: AuthError) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).code).toBe('profile_test_failed')
    expect((err as AuthError).detail.targetMessage).toMatch(/Sign-in failed/)
    expect(store.accounts.countProfiles(ctx.user!.id)).toBe(0)
    const saved = await svc.profiles.save(ctx, profileInput({ host: 'down.example.com', saveAnyway: true }))
    expect(saved.test).toBe('failed')
    expect(store.accounts.countProfiles(ctx.user!.id)).toBe(1)
  })

  it('test() reports ok, a failed connect and a policy refusal without saving', async () => {
    await svc.vault.create(ctx, PASS)
    expect(await svc.profiles.test(ctx, profileInput())).toEqual({ ok: true })
    failHosts.add('down.example.com')
    expect(await svc.profiles.test(ctx, profileInput({ host: 'down.example.com' }))).toMatchObject({ ok: false, error: { code: 'profile_test_failed' } })
    expect(await svc.profiles.test(ctx, profileInput({}, { password: '' }))).toMatchObject({ ok: false, error: { code: 'target_policy', reason: 'empty_password' } })
    expect(store.accounts.countProfiles(ctx.user!.id)).toBe(0)
  })

  it('policy refusals cannot be bypassed with saveAnyway', async () => {
    await svc.vault.create(ctx, PASS)
    overrides = { denyRootTarget: true }
    const err = await svc.profiles.save(ctx, profileInput({ saveAnyway: true }, { user: 'root' })).catch((e: AuthError) => e)
    expect((err as AuthError).detail.reason).toBe('root_denied')
    expect(opens).toHaveLength(0)
  })

  it('rejects duplicate names (case-insensitive) and the 51st profile', async () => {
    await svc.vault.create(ctx, PASS)
    await svc.profiles.save(ctx, profileInput({ name: 'Prod' }))
    expect(await code(svc.profiles.save(ctx, profileInput({ name: 'prod' })))).toBe('profile_name_taken')
    for (let i = 1; i < MAX_PROFILES_PER_USER; i++) await svc.profiles.save(ctx, profileInput({ name: `p${i}` }))
    expect(await code(svc.profiles.save(ctx, profileInput({ name: 'one too many' })))).toBe('profile_limit')
  })

  it('editing without credentials keeps user and password, and skips the test when nothing about the connection changed', async () => {
    await svc.vault.create(ctx, PASS)
    const { profile } = await svc.profiles.save(ctx, profileInput())
    opens.length = 0
    const renamed = await svc.profiles.save(ctx, saveProfileInput.parse({ id: profile.id, name: 'renamed', host: 'db.example.com' }))
    expect(renamed.test).toBe('skipped')
    expect(opens).toHaveLength(0)
    expect(renamed.profile.targetUser).toBe('app')
    const moved = await svc.profiles.save(ctx, saveProfileInput.parse({ id: profile.id, name: 'renamed', host: 'other.example.com' }))
    expect(moved.test).toBe('ok')
    expect(opens[0]?.password).toBe('secret-pw')
    // new user name, password unchanged
    await svc.profiles.save(ctx, saveProfileInput.parse({ id: profile.id, name: 'renamed', host: 'other.example.com', credentials: { user: 'bob' } }))
    expect(opens[1]?.password).toBe('secret-pw')
    expect(opens[1]?.target.username).toBe('bob')
  })

  it('validates PEM text and client certificate/key pairing', async () => {
    await svc.vault.create(ctx, PASS)
    const bad = profileInput({ options: { compress: false, database: null, collation: null, activateRoles: false, caPem: 'not pem', clientCertPem: null } })
    expect(await code(svc.profiles.save(ctx, bad))).toBe('profile_test_failed')
    const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'
    const lonely = profileInput({ options: { compress: false, database: null, collation: null, activateRoles: false, caPem: pem, clientCertPem: pem } })
    expect(await code(svc.profiles.save(ctx, lonely))).toBe('profile_test_failed')
    const ok = profileInput({ options: { compress: true, database: null, collation: null, activateRoles: false, caPem: pem, clientCertPem: pem } }, { clientKeyPem: '-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----' })
    const saved = await svc.profiles.save(ctx, ok)
    expect(saved.profile.hasClientKey).toBe(true)
    expect(opens.at(-1)?.extras).toMatchObject({ compress: true, ca: pem, cert: pem })
    expect(JSON.stringify(store.accounts.listProfiles(ctx.user!.id))).not.toContain('PRIVATE KEY')
  })

  it('tls never goes below the .env mode', () => {
    expect(clampTls('off', 'verify')).toBe('verify')
    expect(clampTls('skip-verify', 'verify')).toBe('verify')
    expect(clampTls('verify', 'off')).toBe('verify')
    expect(clampTls('off', 'skip-verify')).toBe('skip-verify')
    expect(clampTls('skip-verify', 'off')).toBe('skip-verify')
  })

  it('delete works while locked and unknown ids are refused', async () => {
    await svc.vault.create(ctx, PASS)
    const { profile } = await svc.profiles.save(ctx, profileInput())
    svc.vault.lock(ctx)
    svc.profiles.delete(ctx, profile.id)
    expect(store.accounts.countProfiles(ctx.user!.id)).toBe(0)
    expect(await code(() => svc.profiles.delete(ctx, profile.id))).toBe('connection_unknown')
  })

  it('profiles of another user are invisible', async () => {
    await svc.vault.create(ctx, PASS)
    const { profile } = await svc.profiles.save(ctx, profileInput())
    const other: AccountContext = { ...ctx, user: { ...ctx.user!, id: 'someone-else' } }
    expect(svc.profiles.list(other)).toEqual([])
    expect(await code(() => svc.profiles.delete(other, profile.id))).toBe('connection_unknown')
  })
})

describe('connect rules', () => {
  const rules = createTargetConnectRules()
  const target = (username: string): TargetKey => ({ host: 'h', port: 3306, username })
  it('refuses root and empty passwords per setting, each with its own reason', () => {
    const on = { denyRootTarget: true, allowEmptyTargetPassword: false }
    expect(() => rules.checkPolicy(target('root'), 'pw', on)).toThrow(AuthError)
    try { rules.checkPolicy(target('Root'), 'pw', on) } catch (e) { expect((e as AuthError).detail.reason).toBe('root_denied') }
    try { rules.checkPolicy(target('app'), '', on) } catch (e) { expect((e as AuthError).detail.reason).toBe('empty_password') }
    expect(() => rules.checkPolicy(target('root'), '', { denyRootTarget: false, allowEmptyTargetPassword: true })).not.toThrow()
  })

  it('applies a known collation and an existing database, and skips unknown ones', async () => {
    const pool = fakePool('h')
    const r = await rules.afterConnect(pool as never, { collation: 'utf8mb4_bin', database: 'app' })
    expect(r).toMatchObject({ collation: 'utf8mb4_bin', database: 'app', roles: 'off' })
    expect(sqlLog.some((l) => l.includes('SET collation_connection'))).toBe(true)
    expect(sqlLog.some((l) => l.includes('USE `app`'))).toBe(true)
    sqlLog.length = 0
    const none = await rules.afterConnect(fakePool('h') as never, { collation: 'nope_ci', database: 'missing' })
    expect(none).toMatchObject({ collation: null, database: null })
    expect(sqlLog.some((l) => l.includes('SET ') || l.includes('USE'))).toBe(false)
  })

  it('SET ROLE ALL on MySQL; skipped without error on MariaDB', async () => {
    const mysql = await rules.afterConnect(fakePool('h') as never, { activateRoles: true })
    expect(mysql.roles).toBe('applied')
    expect(sqlLog.some((l) => l.includes('SET ROLE ALL'))).toBe(true)
    sqlLog.length = 0
    version = '10.11.19-MariaDB'
    const maria = await rules.afterConnect(fakePool('h') as never, { activateRoles: true })
    expect(maria.roles).toBe('skipped_mariadb')
    expect(sqlLog.some((l) => l.includes('SET ROLE'))).toBe(false)
  })
})

describe('connections', () => {
  const typed = (host = 'a.example.com', patch: Record<string, unknown> = {}) =>
    ({ source: 'typed' as const, host, username: 'app', password: 'pw1', ...patch })

  it('opens a typed connection and lists it without credentials', async () => {
    const info = await svc.connections.open(ctx, typed(), { address: '127.0.0.1' })
    expect(info).toMatchObject({ host: 'a.example.com', port: 3306, targetUser: 'app', source: 'typed', readOnly: false })
    expect(info.connectionId).toHaveLength(22)
    expect(JSON.stringify(svc.connections.list(ctx))).not.toContain('pw1')
    expect(opens[0]?.extras).toMatchObject({ tls: 'verify', compress: false })
  })

  it('refuses the sixth connection', async () => {
    for (let i = 0; i < 5; i++) await svc.connections.open(ctx, typed(`h${i}.example.com`), { address: 'x' })
    expect(await code(svc.connections.open(ctx, typed('h6.example.com'), { address: 'x' }))).toBe('connection_limit')
  })

  it('policy refusals happen before any network contact, in account mode', async () => {
    overrides = { denyRootTarget: true }
    const root = await svc.connections.open(ctx, typed('a.example.com', { username: 'root' }), { address: 'x' }).catch((e: AuthError) => e)
    expect((root as AuthError).detail).toMatchObject({ reason: 'root_denied' })
    const empty = await svc.connections.open(ctx, typed('a.example.com', { password: '' }), { address: 'x' }).catch((e: AuthError) => e)
    expect((empty as AuthError).detail).toMatchObject({ reason: 'empty_password' })
    expect(opens).toHaveLength(0)
    overrides = { allowEmptyTargetPassword: true }
    await svc.connections.open(ctx, typed('a.example.com', { password: '' }), { address: 'x' })
  })

  it('every other failure is the one generic message, and it affects only that connection', async () => {
    await svc.connections.open(ctx, typed('good.example.com'), { address: 'x' })
    failHosts.add('down.example.com')
    expect(await code(svc.connections.open(ctx, typed('down.example.com'), { address: 'x' }))).toBe(LoginFailedError.name)
    expect(await code(svc.connections.open(ctx, typed('bad host!'), { address: 'x' }))).toBe(LoginFailedError.name)
    expect(svc.connections.list(ctx)).toHaveLength(1)
  })

  it('throttles repeated failures per target and user', async () => {
    failHosts.add('down.example.com')
    for (let i = 0; i < 5; i++) await code(svc.connections.open(ctx, typed('down.example.com'), { address: 'x' }))
    expect(await code(svc.connections.open(ctx, typed('down.example.com'), { address: 'x' }))).toBe('auth_throttled')
    expect(await code(svc.connections.open(ctx, typed('other.example.com'), { address: 'x' }))).toBe('no error')
  })

  it('opens from a profile, needs the vault, and uses the profile secrets and options', async () => {
    await svc.vault.create(ctx, PASS)
    const { profile } = await svc.profiles.save(ctx, profileInput({ options: { compress: true, database: 'app', collation: 'utf8mb4_bin', activateRoles: false, caPem: null, clientCertPem: null } }))
    opens.length = 0
    svc.vault.lock(ctx)
    expect(await code(svc.connections.open(ctx, { source: 'profile', profileId: profile.id }, { address: 'x' }))).toBe('vault_locked')
    expect(opens).toHaveLength(0)
    await svc.vault.unlock(ctx, PASS)
    const info = await svc.connections.open(ctx, { source: 'profile', profileId: profile.id }, { address: 'x' })
    expect(info).toMatchObject({ source: 'profile', profileId: profile.id, label: 'prod', targetUser: 'app' })
    expect(opens[0]).toMatchObject({ password: 'secret-pw', extras: { compress: true } })
    expect(sqlLog.some((l) => l.includes('USE `app`'))).toBe(true)
    expect(store.accounts.getProfile(ctx.user!.id, profile.id)?.lastUsedAt).not.toBeNull()
  })

  it('profile of another user or unknown id is connection_unknown', async () => {
    await svc.vault.create(ctx, PASS)
    expect(await code(svc.connections.open(ctx, { source: 'profile', profileId: crypto.randomUUID() }, { address: 'x' }))).toBe('connection_unknown')
  })

  it('close ends the pool and a foreign or closed id is refused', async () => {
    const info = await svc.connections.open(ctx, typed(), { address: 'x' })
    const entry = sessions.getConnection(ctx.idHash, info.connectionId)!
    await svc.connections.close(ctx, info.connectionId)
    expect((entry.pool as unknown as { ended: boolean }).ended).toBe(true)
    expect(svc.connections.list(ctx)).toHaveLength(0)
    expect(await code(svc.connections.close(ctx, info.connectionId))).toBe('connection_unknown')
  })

  it('reconnect reopens with the held typed credential; updateHeldCredential replaces it', async () => {
    const info = await svc.connections.open(ctx, typed(), { address: 'x' })
    const entry = sessions.getConnection(ctx.idHash, info.connectionId)!
    const old = entry.pool
    const live = { ...ctx, connectionId: info.connectionId, scopeKey: `${ctx.idHash}/${info.connectionId}` } as unknown as AccountLiveSession
    opens.length = 0
    const [p1, p2] = await Promise.all([svc.connections.reconnect(live), svc.connections.reconnect(live)])
    expect(p1).toBe(p2)
    expect(opens).toHaveLength(1)
    expect(opens[0]?.password).toBe('pw1')
    expect(entry.pool).toBe(p1)
    expect((old as unknown as { ended: boolean }).ended).toBe(true)
    expect(svc.connections.updateHeldCredential(live.scopeKey, 'pw2')).toEqual({ profileUpdateOffered: false })
    await svc.connections.reconnect(live)
    expect(opens[1]?.password).toBe('pw2')
    expect(svc.connections.updateHeldCredential('nope', 'x')).toEqual({ profileUpdateOffered: false })
  })

  it('profile reconnect needs the unlocked vault; update offers the profile update while unlocked', async () => {
    await svc.vault.create(ctx, PASS)
    const { profile } = await svc.profiles.save(ctx, profileInput())
    const info = await svc.connections.open(ctx, { source: 'profile', profileId: profile.id }, { address: 'x' })
    const scopeKey = `${ctx.idHash}/${info.connectionId}`
    const live = { ...ctx, connectionId: info.connectionId, scopeKey } as unknown as AccountLiveSession
    expect(svc.connections.updateHeldCredential(scopeKey, 'new')).toEqual({ profileUpdateOffered: true })
    svc.vault.lock(ctx)
    expect(svc.connections.updateHeldCredential(scopeKey, 'new')).toEqual({ profileUpdateOffered: false })
    expect(await code(svc.connections.reconnect(live))).toBe('vault_locked')
    await svc.vault.unlock(ctx, PASS)
    await svc.connections.reconnect(live)
  })

  it('a connection id of another session is not visible', async () => {
    const info = await svc.connections.open(ctx, typed(), { address: 'x' })
    expect(sessions.getConnection('other-session', info.connectionId)).toBeUndefined()
  })
})
