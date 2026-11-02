/** Task 11 wiring: session context, owner and scope keys, session info, hooks, shared stateless prefs, direct connect rules. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTION_HEADER as CLIENT_CONNECTION_HEADER, CSRF_HEADER, setCsrfToken, withConnectionParam, withSessionHeaders } from '~/lib/csrf'
import { DirectAuth, LoginFailedError } from '~/server/auth'
import { createTargetConnectRules } from '~/server/auth/connections'
import { createSqlitePrefsBackend } from '~/server/auth/prefs/backend'
import { createPrefsService } from '~/server/auth/prefs/service'
import { prefsRegistry } from '~/server/auth/prefs/runtime'
import { buildLinkServices } from '~/server/auth/link-services'
import { createUserService } from '~/server/auth/users'
import { AuthError, CONNECTION_HEADER, STATE_ALLOWED_FUNCTIONS, type AccountLiveSession } from '~/server/auth/types'
import { assertSetupDone, loginModeOf, poolIsClosed, resolveTargetSession, stateGate } from '~/server/session-context'
import { buildSessionInfo } from '~/server/session-info'
import { SessionManager, scopeKeyOf } from '~/server/sessions'
import { ownerKeyFor, ownerKeyOf } from '~/server/sql/state'
import { createMemoryPrefsDb, createSqliteIoPrefs, createSqlitePrefs, openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import type { TargetPool } from '~/server/db/target-pool'

const target = { host: 'db.example', port: 3306, username: 'app' }
const fakePool = (closed = false) => ({ pool: { _closed: closed }, end: vi.fn(async () => undefined) }) as unknown as TargetPool

describe('client headers', () => {
  it('keeps the connection header name in step with the server contract', () => {
    expect(CLIENT_CONNECTION_HEADER).toBe(CONNECTION_HEADER)
  })

  it('adds csrf and connection to raw requests, and the connection to download links', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null })
    try {
      setCsrfToken('tok')
      expect(withSessionHeaders({ a: 'b' })).toEqual({ a: 'b', [CSRF_HEADER]: 'tok' })
      expect(withConnectionParam('/api/io/download/j1')).toBe('/api/io/download/j1')
      store.set(CLIENT_CONNECTION_HEADER, 'c 1')
      expect(withSessionHeaders()).toEqual({ [CSRF_HEADER]: 'tok', [CLIENT_CONNECTION_HEADER]: 'c 1' })
      expect(withConnectionParam('/api/io/download/j1')).toBe('/api/io/download/j1?connection=c%201')
      expect(withConnectionParam('/x?a=1')).toBe('/x?a=1&connection=c%201')
    } finally {
      setCsrfToken(undefined)
      vi.unstubAllGlobals()
    }
  })
})

describe('owner and scope keys', () => {
  it('direct mode keeps the target key, account mode uses the user, stateless the session', () => {
    const session = { idHash: 'sid', target }
    expect(ownerKeyFor(session)).toBe(ownerKeyOf(target))
    expect(ownerKeyFor({ ...session, ownerKey: 'u:42' })).toBe('u:42')
    vi.stubEnv('DBLOOM_STORE', 'none')
    try {
      expect(ownerKeyFor({ ...session, ownerKey: 'u:42' })).toBe('sid')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('scopes per connection in account mode and by session in direct mode', () => {
    expect(scopeKeyOf('abc')).toBe('abc')
    expect(scopeKeyOf('abc', 'conn')).toBe('abc/conn')
  })
})

describe('state gate and setup gate', () => {
  it('lets a state pass only for the functions of section 5.5', () => {
    expect(() => stateGate('full', 'anything')).not.toThrow()
    for (const fn of STATE_ALLOWED_FUNCTIONS.pending_mfa) expect(() => stateGate('pending_mfa', fn)).not.toThrow()
    expect(() => stateGate('pending_mfa', 'runSql')).toThrowError(expect.objectContaining({ code: 'mfa_required' }))
    expect(() => stateGate('pending_mfa')).toThrowError(expect.objectContaining({ code: 'mfa_required' }))
    expect(() => stateGate('enrol_only', 'getRows')).toThrowError(expect.objectContaining({ code: 'enrol_required' }))
    expect(() => stateGate('must_change', 'changePassword')).not.toThrow()
    expect(() => stateGate('must_change', 'openConnection')).toThrowError(expect.objectContaining({ code: 'password_change_required' }))
  })

  it('answers setup_pending until the wizard is done, then remembers readiness', () => {
    let state: { kind: string; mode?: string } = { kind: 'setup_pending' }
    const runtime = { setup: { startupState: vi.fn(() => state) } } as never
    expect(() => assertSetupDone(runtime)).toThrowError(expect.objectContaining({ code: 'setup_pending' }))
    state = { kind: 'ready', mode: 'direct' }
    expect(() => assertSetupDone(runtime)).not.toThrow()
    const calls = (runtime as { setup: { startupState: ReturnType<typeof vi.fn> } }).setup.startupState.mock.calls.length
    assertSetupDone(runtime)
    expect((runtime as { setup: { startupState: ReturnType<typeof vi.fn> } }).setup.startupState.mock.calls.length).toBe(calls)
  })

  it('reads the mode from the start state; stateless and missing setup are direct', () => {
    expect(loginModeOf({ setup: { startupState: () => ({ kind: 'ready', mode: 'account' }) } } as never)).toBe('account')
    expect(loginModeOf({ setup: { startupState: () => ({ kind: 'stateless' }) } } as never)).toBe('direct')
    expect(loginModeOf({})).toBe('direct')
  })
})

describe('resolveTargetSession', () => {
  const accountSession = (over: Partial<AccountLiveSession> = {}): AccountLiveSession => ({
    idHash: 'sid', csrf: 'c', target, pool: fakePool(), readOnly: false, kind: 'account', connectionId: 'k1', scopeKey: 'sid/k1',
    user: { id: 'u1', username: 'ann', displayName: 'Ann', role: 'user', securityVersion: 0 }, ownerKey: 'u:u1', ...over,
  }) as AccountLiveSession

  const input = { token: 't', connectionId: 'k1', csrf: 'c', background: false }

  it('direct mode returns the plain session and checks csrf', async () => {
    const live = { idHash: 'sid', csrf: 'c', target, pool: fakePool(), readOnly: false }
    const sessions = { resolve: vi.fn(() => live), verifyCsrf: (s: { csrf: string }, p?: string) => s.csrf === p }
    const runtime = { sessions, setup: { startupState: () => ({ kind: 'ready', mode: 'direct' }) } } as never
    expect(await resolveTargetSession(runtime, input)).toBe(live)
    expect(await resolveTargetSession(runtime, { ...input, csrf: 'x' })).toBeUndefined()
    expect(await resolveTargetSession(runtime, { ...input, csrf: undefined, requireCsrf: false })).toBe(live)
  })

  it('account mode scopes the session to the connection and keeps the user as owner', async () => {
    const resolveTarget = vi.fn(() => accountSession())
    const runtime = { sessions: { resolveTarget, verifyCsrf: (s: { csrf: string }, p?: string) => s.csrf === p }, setup: { startupState: () => ({ kind: 'ready', mode: 'account' }) } } as never
    const session = await resolveTargetSession(runtime, input)
    expect(session).toMatchObject({ idHash: 'sid/k1', sessionIdHash: 'sid', ownerKey: 'u:u1' })
    expect(resolveTarget).toHaveBeenCalledWith('t', 'k1', { background: false })
    expect(await resolveTargetSession(runtime, { ...input, csrf: 'bad' })).toBeUndefined()
  })

  it('refuses a foreign connection id and reopens a closed pool once (G5)', async () => {
    const fresh = fakePool()
    const reconnect = vi.fn(async () => fresh)
    const sessions = { resolveTarget: vi.fn(() => accountSession({ pool: fakePool(true) })), verifyCsrf: () => true }
    const runtime = { sessions, setup: { startupState: () => ({ kind: 'ready', mode: 'account' }) } } as never
    expect((await resolveTargetSession(runtime, input, reconnect))?.pool).toBe(fresh)
    expect(reconnect).toHaveBeenCalledTimes(1)
    sessions.resolveTarget.mockReturnValueOnce(undefined as never)
    expect(await resolveTargetSession(runtime, { ...input, connectionId: 'foreign' }, reconnect)).toBeUndefined()
    // A failed reconnect ends in the one "session ended" answer.
    sessions.resolveTarget.mockReturnValueOnce(accountSession({ pool: fakePool(true) }))
    expect(await resolveTargetSession(runtime, input, async () => { throw new Error('down') })).toBeUndefined()
    expect(poolIsClosed(fakePool(true))).toBe(true)
    expect(poolIsClosed(fakePool(false))).toBe(false)
  })
})

describe('sessions, hooks, users, prefs on a real store', () => {
  let dir: string
  let store: SqliteStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbloom-wiring-'))
    store = openSqliteStore(join(dir, 'store.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const config = { sessionIdleMs: 1_800_000, sessionAbsoluteMs: 28_800_000 }
  const meta = { clientHint: 'Firefox', address: '127.0.0.1' }
  const makeUser = (name: string, hooks = {}) => {
    const users = createUserService(store.accounts, async (p) => `$phc$${p}`, Date.now, undefined, hooks)
    return { users, create: () => users.create({ username: name, displayName: name, role: 'user', password: 'correct horse battery' }, 'setup') }
  }

  it('does not list pending_mfa sessions and gives no target to a half-signed-in session', async () => {
    const sessions = new SessionManager(store, config)
    const { create } = makeUser('pend')
    const user = await create()
    const pending = sessions.createAccount(user, 'pending_mfa', meta)
    const full = sessions.createAccount(user, 'full', meta)
    const list = sessions.listUserSessions(user.id, 'x')
    expect(list).toHaveLength(1)
    const ctx = sessions.resolveAccount(full.token, { background: true })!
    expect(list[0]!.ref).toBe(ctx.idHash)
    const pend = sessions.resolveAccount(pending.token, { background: true })!
    sessions.addConnection(pend.idHash, { connectionId: 'k', target, pool: fakePool(), readOnly: false, source: 'typed', openedAt: 1 })
    expect(sessions.resolveTarget(pending.token, 'k', { background: true })).toBeUndefined()
  })

  it('closes every connection and runs the end hooks when a session ends', async () => {
    const sessions = new SessionManager(store, config)
    const ended: string[] = []
    sessions.onEnd((id) => ended.push(id))
    const { create } = makeUser('endy')
    const user = await create()
    const { token } = sessions.createAccount(user, 'full', meta)
    const ctx = sessions.resolveAccount(token, { background: true })!
    const pool = fakePool()
    sessions.addConnection(ctx.idHash, { connectionId: 'k', target, pool, readOnly: false, source: 'typed', openedAt: 1 })
    await sessions.endSession(ctx.idHash)
    expect((pool as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled()
    expect(ended).toEqual([ctx.idHash])
    expect(sessions.resolveAccount(token, { background: true })).toBeUndefined()
  })

  it('deleting a user ends their sessions and removes their preferences', async () => {
    const backend = createSqlitePrefsBackend(store.db)
    const prefs = createPrefsService(backend, prefsRegistry)
    const ended: string[][] = []
    const deleted: string[] = []
    const { users, create } = makeUser('gone', {
      onSessionsEnded: (ids: string[]) => ended.push(ids),
      onUserDeleted: (id: string) => {
        deleted.push(id)
        prefs.deleteOwner(`u:${id}`)
      },
    })
    const victim = await create()
    const admins = makeUser('boss')
    const boss = await admins.users.create({ username: 'boss2', displayName: 'b', role: 'admin', password: 'correct horse battery' }, 'setup')
    const sessions = new SessionManager(store, config)
    sessions.createAccount(victim, 'full', meta)
    prefs.set(`u:${victim.id}`, 'theme', 'dark')
    expect(prefs.get(`u:${victim.id}`).theme).toBe('dark')
    users.delete(victim.id, { id: boss.id, username: boss.username, displayName: boss.displayName, role: 'admin', securityVersion: 0 })
    expect(deleted).toEqual([victim.id])
    expect(ended[0]).toHaveLength(1)
    expect(prefs.get(`u:${victim.id}`).theme).not.toBe('dark')
  })

  it('shares one in-memory table between the registry, rows and io preference stores (stateless)', () => {
    const db = createMemoryPrefsDb()
    const backend = createSqlitePrefsBackend(db)
    const registry = createPrefsService(backend, prefsRegistry)
    const rows = createSqlitePrefs(db)
    const io = createSqliteIoPrefs(db)
    registry.set('sess1', 'theme', 'light')
    rows.set('sess1', 'db:3306', { kind: 'global' }, 'rows.pageSize', 50)
    io.set('sess1', 'db:3306', 'io.exportFormat', 'csv')
    const owned = backend.rows('sess1')
    expect(owned.map((r) => r.key).sort()).toEqual(expect.arrayContaining(['theme', 'rows.pageSize', 'io.exportFormat']))
    backend.removeOwner('sess1')
    expect(backend.rows('sess1')).toEqual([])
    expect(rows.get('sess1', 'db:3306')).toEqual({})
  })

  it('builds the link services from their parts', () => {
    const stepUp = { requireRecentFactor: vi.fn() }
    const services = buildLinkServices({
      store: store.accounts,
      throttle: { delayMs: () => 0, fail: () => undefined, reset: () => undefined } as never,
      settings: () => ({ publicOrigin: 'https://x.example', inviteLifetimeMs: 1000, recoveryLinkLifetimeMs: 1000, passwordMinLength: 12, breachedCheck: false, argon2Login: {} }) as never,
      users: { usernameKey: (n: string) => n.toLowerCase() },
      passwords: {} as never,
      webauthn: {} as never,
      stepUp,
      onSessionsEnded: () => undefined,
    })
    expect(services.stepUp).toBe(stepUp)
    expect(typeof services.invites.issue).toBe('function')
    expect(typeof services.recovery.redeem).toBe('function')
  })

  it('builds session info per mode and hides half-signed-in details', async () => {
    const sessions = new SessionManager(store, config)
    const { create } = makeUser('info')
    const user = await create()
    const prefs = createPrefsService(createSqlitePrefsBackend(store.db), prefsRegistry)
    prefs.set(`u:${user.id}`, 'theme', 'dark')
    const vault = { exists: true, unlocked: false, autoLockAt: null, enabled: true }
    const mode = { kind: 'ready', mode: 'account' } as const
    const base = {
      runtime: { sessions, config: { ...config, readOnly: false }, store, setup: { startupState: () => mode } } as never,
      settings: () => ({ adminSessionIdleMs: 1000, stepUpWindowMs: 5000 }),
      prefs: () => prefs,
      stateless: false,
      connections: () => [],
      vaultStatus: () => vault,
    }
    const full = sessions.createAccount(user, 'full', meta)
    const info = buildSessionInfo({ ...base, token: full.token })
    expect(info).toMatchObject({ mode: 'account', state: 'full', theme: 'dark', vault })
    const pending = sessions.createAccount(user, 'pending_mfa', meta)
    expect(buildSessionInfo({ ...base, token: pending.token })).toMatchObject({ state: 'pending_mfa', theme: 'system', connections: [], vault: { exists: false } })
    expect(buildSessionInfo({ ...base, token: 'nope' })).toBeNull()
  })
})

describe('direct login applies the connect rules', () => {
  const config = { allowedTargets: [], freeFormAck: true, allowLoopback: true, allowPrivate: false, tls: 'off', sessionAbsoluteMs: 1, sessionIdleMs: 1, connectTimeoutMs: 100 } as never
  const sessions = { create: vi.fn() } as never

  it('refuses root and empty passwords by policy, naming the reason, before any network contact', async () => {
    const auth = new DirectAuth(config, sessions, { rules: createTargetConnectRules(), settings: () => ({ allowEmptyTargetPassword: false, denyRootTarget: true }) })
    await expect(auth.login({ host: 'localhost:3306', username: 'root', password: 'pw' }, '1.1.1.1')).rejects.toMatchObject({ code: 'target_policy', detail: { reason: 'root_denied' } })
    await expect(auth.login({ host: 'localhost:3306', username: 'app', password: '' }, '1.1.1.1')).rejects.toMatchObject({ code: 'target_policy', detail: { reason: 'empty_password' } })
  })

  it('stays the generic failure for everything else', async () => {
    const auth = new DirectAuth(config, sessions, { rules: createTargetConnectRules(), settings: () => ({ allowEmptyTargetPassword: true, denyRootTarget: false }) })
    await expect(auth.login({ host: '', username: 'app', password: 'x' }, '1.1.1.1')).rejects.toBeInstanceOf(LoginFailedError)
    expect(AuthError).toBeDefined()
  })
})

