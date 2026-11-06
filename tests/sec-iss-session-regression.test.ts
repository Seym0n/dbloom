/** Regression tests for SEC-ISS-001, SEC-ISS-104 and SEC-ISS-114 (SPEC/16, SPEC/17).
 * Real SQLite store in a temp directory, test doubles for the target pool (no Docker needed).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportConfirmDialog } from '~/components/io/import-confirm-dialog'
import type { ImportAnalysis } from '~/server/io/types'
import { DirectAuth, LoginFailedError } from '~/server/auth'
import authSignin from '~/i18n/auth-signin.json'
import { loadConfig, type Config } from '~/server/config'
import { createChallengeStore } from '~/server/auth/challenges'
import { createRecoveryCodeService } from '~/server/auth/codes'
import { createConnector, createConnectionService } from '~/server/auth/connections'
import { createPasswordService } from '~/server/auth/password'
import { ServerKeyRing } from '~/server/auth/secret-key'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createSignInService, type SignInDeps } from '~/server/auth/signin'
import { BackoffThrottle } from '~/server/auth/throttle'
import { OwnTotp } from '~/server/auth/totp'
import { ARGON2_LOGIN_DEFAULT, AuthError, type AccountContext } from '~/server/auth/types'
import { createUserService } from '~/server/auth/users'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { configureSessionCookie, sessionCookieName } from '~/server/session-cookie'

// Direct-mode doubles: two "servers" a.test and b.test; the pool remembers which host it was opened for.
const opened: string[] = []
vi.mock('~/server/host-policy', () => ({ resolveAllowedAddress: async (t: { host: string }) => `addr:${t.host}` }))
vi.mock('~/server/db/target-pool', () => ({
  openTargetPool: async (t: { host: string }, _a: string, password: string) => {
    if (password === 'tls-fail') throw Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
    if (password !== 'shared-pw') throw new Error('Access denied')
    opened.push(t.host)
    return { host: t.host, end: async () => undefined, query: async () => [[]], on: () => undefined }
  },
}))

const RP = { rpId: 'dbloom.test', origin: 'https://dbloom.test' }
const PASSWORD = 'correct horse battery staple'
const META = { address: '203.0.113.7', clientHint: 'Chrome on Windows' }

let dir: string
let store: SqliteStore
let clock: { t: number }

function rig() {
  const resolver = createAuthSettingsResolver(store.accounts, { DBLOOM_PUBLIC_ORIGIN: RP.origin } as NodeJS.ProcessEnv)
  const sessions = new SessionManager(store, { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3600_000 }, () => clock.t, () => resolver.resolve())
  const password = createPasswordService({ contains: async () => false, source: () => ({ kind: 'none', entries: 0 }) })
  const ring = new ServerKeyRing(randomBytes(32), undefined)
  const challenges = createChallengeStore(() => clock.t)
  const users = createUserService(store.accounts, (p) => password.hash(p, ARGON2_LOGIN_DEFAULT), () => clock.t, () => resolver.resolve())
  const deps: SignInDeps = {
    store: store.accounts, sessions, users, settings: resolver,
    throttle: new BackoffThrottle(5, 15 * 60_000, 15 * 60_000, () => clock.t),
    password, totp: new OwnTotp(), codes: createRecoveryCodeService(ring), ring, challenges,
    webauthn: createWebAuthnService({ challenges, relyingParty: () => ({ ...RP, rpName: 'DBLoom' }) }),
    now: () => clock.t,
  }
  const create = (name: string) => users.create({ username: name, displayName: name, role: 'user', password: PASSWORD }, 'setup', { temporary: false })
  const ctxOf = (token: string): AccountContext => sessions.resolveAccount(token, { background: false })!
  return { signIn: createSignInService(deps), sessions, users, create, ctxOf }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-sessreg-'))
  store = openSqliteStore(join(dir, 'store.db'))
  clock = { t: Date.now() }
  opened.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  configureSessionCookie(undefined)
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SEC-ISS-114 unauthenticated requests keep the session; id regenerated at login (SEC-TGT-040)', () => {
  it('SEC-ISS-114: resolving without or with a foreign cookie (login page, public requests) changes nothing in an existing session', async () => {
    const r = rig()
    await r.create('ana')
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const before = r.ctxOf(s.token)
    for (const token of [undefined, '', 'garbage', randomBytes(32).toString('base64url')]) {
      expect(r.sessions.resolveAccount(token, { background: false })).toBeUndefined()
      expect(r.sessions.resolve(token)).toBeUndefined()
    }
    const after = r.ctxOf(s.token)
    expect(after.idHash).toBe(before.idHash)
    expect(after.csrf).toBe(before.csrf)
    expect(after.csrf).toBe(s.csrf)
    expect(r.sessions.verifyCsrf(after, s.csrf)).toBe(true)
  })

  it('SEC-ISS-114: a second sign-in (other browser tab) does not alter the first session id or csrf', async () => {
    const r = rig()
    await r.create('ana')
    const first = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const second = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    expect(second.token).not.toBe(first.token)
    expect(second.csrf).not.toBe(first.csrf)
    const again = r.ctxOf(first.token)
    expect(again.csrf).toBe(first.csrf)
    expect(r.sessions.verifyCsrf(again, first.csrf)).toBe(true)
  })

  it('SEC-ISS-114 / SEC-TGT-040: sign-in always mints a new session id and csrf', async () => {
    const r = rig()
    await r.create('ana')
    const tokens = new Set<string>()
    const csrfs = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
      tokens.add(s.token)
      csrfs.add(s.csrf)
    }
    expect(tokens.size).toBe(3)
    expect(csrfs.size).toBe(3)
  })

  it('SEC-ISS-114 / SEC-TGT-040: a state transition rotates the token (old one dead) and keeps the csrf, so an open form still submits', async () => {
    const r = rig()
    await r.create('ana')
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const moved = r.sessions.transition(s.token, { stepupAt: clock.t })
    expect(moved.token).not.toBe(s.token)
    expect(r.sessions.resolveAccount(s.token, { background: true })).toBeUndefined()
    expect(r.sessions.verifyCsrf(r.ctxOf(moved.token), s.csrf)).toBe(true)
  })

  it('SEC-ISS-114: a form rendered earlier (csrf of an existing session) still verifies after other requests', async () => {
    const r = rig()
    await r.create('ana')
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const renderedCsrf = s.csrf
    for (let i = 0; i < 5; i++) {
      r.sessions.resolveAccount(undefined, { background: false })
      r.sessions.resolveAccount(s.token, { background: false })
    }
    expect(r.sessions.verifyCsrf(r.ctxOf(s.token), renderedCsrf)).toBe(true)
  })
})

describe('SEC-ISS-001 logout, cookie, import file names, TLS reason', () => {
  it('SEC-ISS-001: logout (account mode signOut) ends all server-side auth state of the session', async () => {
    const r = rig()
    await r.create('ana')
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const idHash = r.ctxOf(s.token).idHash
    expect(store.accounts.getAccountSession(idHash)).toBeDefined()
    await r.signIn.signOut(s.token)
    expect(r.sessions.resolveAccount(s.token, { background: false })).toBeUndefined()
    expect(r.sessions.resolve(s.token)).toBeUndefined()
    expect(store.accounts.getAccountSession(idHash)).toBeUndefined()
    expect(store.getSession(idHash)).toBeUndefined()
  })

  it('SEC-ISS-001: logout (direct mode destroy) ends the session and closes its pool', async () => {
    const end = vi.fn(async () => undefined)
    const sessions = new SessionManager(store, { sessionIdleMs: 60_000, sessionAbsoluteMs: 600_000 }, () => clock.t)
    const { token } = sessions.create({ host: 'a.test', port: 3306, username: 'u' }, { end, query: async () => [[]], on: () => undefined } as never)
    expect(sessions.resolve(token)).toBeDefined()
    await sessions.destroy(token)
    expect(sessions.resolve(token)).toBeUndefined()
    expect(end).toHaveBeenCalled()
  })

  it('SEC-ISS-001: both logout paths delete the session cookie with the path and Secure flag it was set with', () => {
    const logoutSrc = readFileSync('src/server/session.functions.ts', 'utf8')
    const signOutSrc = readFileSync('src/server/auth.functions.ts', 'utf8')
    const del = /deleteCookie\(sessionCookie\(\), \{ path: '\/', secure: true \}\)/
    expect(logoutSrc).toMatch(del)
    expect(signOutSrc).toMatch(/signOut\(getCookie\(sessionCookie\(\)\)\)\s*\r?\n\s*deleteCookie\(sessionCookie\(\), \{ path: '\/', secure: true \}\)/)
    expect(logoutSrc).not.toMatch(/deleteCookie\(sessionCookie\(\),[^)]*domain/i)
  })

  it('SEC-ISS-001: the default public port keeps the plain cookie name', () => {
    for (const origin of ['https://dbloom.test', 'https://dbloom.test:443', undefined]) {
      configureSessionCookie(origin)
      expect(sessionCookieName(undefined, 'https://dbloom.test/')).toBe('__Host-dbloom-session')
    }
    configureSessionCookie(undefined)
    expect(sessionCookieName('dbloom.test')).toBe('__Host-dbloom-session')
    expect(sessionCookieName('dbloom.test:443')).toBe('__Host-dbloom-session')
  })

  it('SEC-ISS-001: two instances on one host with different public ports get different cookie names', () => {
    configureSessionCookie('https://host.test:8443')
    const a = sessionCookieName('host.test:8443')
    configureSessionCookie('https://host.test:9443')
    const b = sessionCookieName('host.test:9443')
    expect(a).toBe('__Host-dbloom-session-8443')
    expect(b).toBe('__Host-dbloom-session-9443')
    expect(a).not.toBe(b)
    // No configured origin: the port of the request Host decides; a malformed port is ignored.
    configureSessionCookie(undefined)
    expect(sessionCookieName('host.test:8443')).toBe('__Host-dbloom-session-8443')
    expect(sessionCookieName('[::1]:3000')).toBe('__Host-dbloom-session-3000')
    expect(sessionCookieName('host.test:99999')).toBe('__Host-dbloom-session')
    expect(sessionCookieName(undefined, 'http://localhost:3100/x')).toBe('__Host-dbloom-session-3100')
    // The configured origin wins over a different Host.
    configureSessionCookie('https://host.test:8443')
    expect(sessionCookieName('host.test:1234')).toBe('__Host-dbloom-session-8443')
  })

  it('SEC-ISS-001 / SEC-TGT-112: the import page output-encodes the uploaded file name', () => {
    const evil = '"><img src=x onerror=alert(1)>.sql'
    const analysis = {
      uploadId: 'upload-12345678', analysisHash: 'h', fileName: evil, bytes: 10, compression: 'none', format: 'sql', charset: 'utf-8',
      confirmRequired: false,
      statements: {
        total: 1, byClass: { none: 1, soft: 0, hard: 0, refused: 0 }, hardKinds: {}, refusedKinds: {},
        createsDatabases: [], dropsDatabases: [], usesDatabase: false, needsDatabase: true,
      },
    } as ImportAnalysis
    const out = renderToStaticMarkup(
      createElement(ImportConfirmDialog, {
        open: true, analysis, server: 'db.example:3306', db: 'd', table: undefined, typedName: 'd', busy: false,
        onCancel: () => undefined, onConfirm: () => undefined,
      }),
    )
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    expect(out).toContain('&quot;&gt;')
  })

  const tlsConnector = (error: Error) =>
    createConnector({
      config: { ...loadConfig({}), tls: 'verify' } as Config,
      throttle: new BackoffThrottle(50, 60_000, 60_000, () => clock.t),
      settings: () => ({ allowEmptyTargetPassword: true, denyRootTarget: false }),
      rules: { checkPolicy: () => undefined, afterConnect: async () => ({ database: null, collation: null, roles: 'off' }) },
      resolveAddress: async () => '203.0.113.9',
      openPool: async () => {
        throw error
      },
    })
  const tlsErr = (code: string, message: string) => Object.assign(new Error(message), { code })
  let seq = 0
  const openTyped = async (error: Error) => {
    const r = rig()
    const name = `tls${seq++}`
    await r.create(name)
    const s = await r.signIn.passwordSignIn({ username: name, password: PASSWORD }, META)
    const service = createConnectionService({ sessions: r.sessions, store: store.accounts, profiles: {} as never, connector: tlsConnector(error), now: () => clock.t })
    return service
      .open(r.ctxOf(s.token), { source: 'typed', host: 'db.example', username: 'u', password: 'p', tls: 'verify' }, { address: META.address })
      .then(() => undefined, (e: unknown) => e as Error)
  }

  it('SEC-ISS-001: account mode: a failed TLS connect states a fixed reason category, no driver text or host', async () => {
    const cases: Array<[string, string]> = [
      ['SELF_SIGNED_CERT_IN_CHAIN', 'untrusted_ca'],
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'untrusted_ca'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'hostname_mismatch'],
      ['CERT_HAS_EXPIRED', 'cert_expired'],
      ['CERT_NOT_YET_VALID', 'cert_not_yet_valid'],
      ['EPROTO', 'handshake_failed'],
    ]
    for (const [code, reason] of cases) {
      const err = (await openTyped(tlsErr(code, `raw driver text for db.example 203.0.113.9 ${code}`))) as AuthError
      expect(err, code).toBeInstanceOf(AuthError)
      expect(err.code).toBe('target_tls')
      expect(err.detail).toEqual({ reason })
      expect(JSON.stringify([err.message, err.detail])).not.toMatch(/raw driver|db\.example|203\.0\.113/)
      expect(authSignin[`auth.error.target_tls.${reason}` as keyof typeof authSignin]).toBeTruthy()
    }
  })

  it('SEC-ISS-001: account mode: a non-TLS connect failure stays the one generic message', async () => {
    expect(await openTyped(tlsErr('ECONNREFUSED', 'connect ECONNREFUSED'))).toBeInstanceOf(LoginFailedError)
  })

  it('SEC-ISS-001 / SEC-TGT-018: direct mode: a TLS failure stays the uniform login failure', async () => {
    const cfg: Config = { ...loadConfig({}), dataDir: '', allowedTargets: [], freeFormAck: true, tls: 'verify', sessionIdleMs: 60_000, sessionAbsoluteMs: 600_000 }
    const auth = new DirectAuth(cfg, new SessionManager(store, cfg, () => clock.t))
    const err = await auth.login({ host: 'a.test', username: 'u', password: 'tls-fail' }, '1.2.3.4').then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(LoginFailedError)
    expect((err as Error).message).not.toMatch(/certificate|tls/i)
  })
})

describe('SEC-ISS-104 login after session expiry connects to the server chosen on the form', () => {
  const config: Config = { ...loadConfig({}), dataDir: '', allowedTargets: [], freeFormAck: true, tls: 'off', sessionIdleMs: 60_000, sessionAbsoluteMs: 600_000 }

  it('SEC-ISS-104: direct mode, same credentials on two servers, after expiry: each login connects the chosen server', async () => {
    const sessions = new SessionManager(store, config, () => clock.t)
    const auth = new DirectAuth(config, sessions)
    const first = await auth.login({ host: 'a.test', username: 'u', password: 'shared-pw' }, '1.2.3.4')
    expect(sessions.resolve(first.token)!.target.host).toBe('a.test')
    clock.t += config.sessionIdleMs + 1
    expect(sessions.resolve(first.token)).toBeUndefined()
    const second = await auth.login({ host: 'b.test', username: 'u', password: 'shared-pw' }, '1.2.3.4')
    const live = sessions.resolve(second.token)!
    expect(live.target.host).toBe('b.test')
    expect((live.pool as unknown as { host: string }).host).toBe('b.test')
    expect(second.token).not.toBe(first.token)
    const third = await auth.login({ host: 'a.test', username: 'u', password: 'shared-pw' }, '1.2.3.4')
    expect((sessions.resolve(third.token)!.pool as unknown as { host: string }).host).toBe('a.test')
    expect(opened).toEqual(['a.test', 'b.test', 'a.test'])
  })

  it('SEC-ISS-104: account mode, after session expiry a new sign-in plus connection on server B connects B, not the earlier A', async () => {
    const r = rig()
    await r.create('ana')
    const addresses: string[] = []
    const connector = createConnector({
      config,
      throttle: new BackoffThrottle(50, 60_000, 60_000, () => clock.t),
      settings: () => ({ allowEmptyTargetPassword: true, denyRootTarget: false }),
      rules: { checkPolicy: () => undefined, afterConnect: async () => ({ database: null, collation: null, roles: 'off' }) },
      resolveAddress: async (t) => `addr:${t.host}`,
      openPool: async (t, address) => {
        addresses.push(`${t.host}@${address}`)
        return { end: async () => undefined, query: async () => [[]], on: () => undefined } as never
      },
    })
    const service = createConnectionService({ sessions: r.sessions, store: store.accounts, profiles: {} as never, connector, now: () => clock.t, onClose: async () => undefined })
    const typed = (host: string) => ({ source: 'typed' as const, host, username: 'u', password: 'shared-pw', tls: 'off' as const })

    const s1 = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const infoA = await service.open(r.ctxOf(s1.token), typed('a.test'), { address: META.address })
    expect(infoA.host).toBe('a.test')

    clock.t += 31 * 60_000
    expect(r.sessions.resolveAccount(s1.token, { background: false })).toBeUndefined()

    const s2 = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    expect(r.sessions.listConnections(r.ctxOf(s2.token).idHash)).toHaveLength(0)
    const infoB = await service.open(r.ctxOf(s2.token), typed('b.test'), { address: META.address })
    expect(infoB.host).toBe('b.test')
    const entry = r.sessions.getConnection(r.ctxOf(s2.token).idHash, infoB.connectionId)!
    expect(entry.target.host).toBe('b.test')
    expect(addresses).toEqual(['a.test@addr:a.test', 'b.test@addr:b.test'])
  })
})
