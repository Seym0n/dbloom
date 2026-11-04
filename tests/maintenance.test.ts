/** SPEC/32 task 4: maintenance rules (ST-218), the guard of target sessions, sign-in refusal. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChallengeStore } from '~/server/auth/challenges'
import { createRecoveryCodeService } from '~/server/auth/codes'
import { createPasswordService } from '~/server/auth/password'
import { ServerKeyRing } from '~/server/auth/secret-key'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createSettingsWriter } from '~/server/auth/settings-write'
import { createSignInService, type SignInDeps } from '~/server/auth/signin'
import { BackoffThrottle } from '~/server/auth/throttle'
import { OwnTotp } from '~/server/auth/totp'
import { ARGON2_LOGIN_DEFAULT, AuthError, type AuthSettingKey } from '~/server/auth/types'
import { createUserService } from '~/server/auth/users'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { assertNotInMaintenance, maintenanceBlocks, maintenanceForced, maintenanceView } from '~/server/maintenance'
import { authErrorResponse } from '~/server/auth/error-transport'
import { resolveTargetSession } from '~/server/session-context'
import { SessionManager } from '~/server/sessions'
import { buildSessionInfo } from '~/server/session-info'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SoftAuthenticator } from './auth-authenticator'

const NOW = 1_000_000
const off = { maintenanceOn: false, maintenanceEndsAt: 0 }

describe('rules (FR-ASE-011)', () => {
  it('off, on without an end, on until a future end, ended', () => {
    expect(maintenanceView(off, {}, NOW)).toEqual({ active: false, endsAt: null })
    expect(maintenanceView({ maintenanceOn: true, maintenanceEndsAt: 0 }, {}, NOW)).toEqual({ active: true, endsAt: null })
    expect(maintenanceView({ maintenanceOn: true, maintenanceEndsAt: NOW + 1 }, {}, NOW)).toEqual({ active: true, endsAt: NOW + 1 })
    expect(maintenanceView({ maintenanceOn: true, maintenanceEndsAt: NOW }, {}, NOW)).toEqual({ active: false, endsAt: null }) // ends at the end time
    expect(maintenanceView({ maintenanceOn: true, maintenanceEndsAt: NOW - 5 }, {}, NOW)).toEqual({ active: false, endsAt: null })
  })

  it('an end time on a switch that is off does nothing', () => {
    expect(maintenanceView({ maintenanceOn: false, maintenanceEndsAt: NOW + 100 }, {}, NOW).active).toBe(false)
  })

  it('DBLOOM_MAINTENANCE forces it, whatever the stored state and end time say', () => {
    for (const v of ['true', '1', ' TRUE ']) expect(maintenanceForced({ DBLOOM_MAINTENANCE: v })).toBe(true)
    for (const v of ['false', '0', '', 'yes', undefined]) expect(maintenanceForced({ DBLOOM_MAINTENANCE: v })).toBe(false)
    expect(maintenanceView(off, { DBLOOM_MAINTENANCE: 'true' }, NOW)).toEqual({ active: true, endsAt: null })
    expect(maintenanceView({ maintenanceOn: true, maintenanceEndsAt: NOW - 1 }, { DBLOOM_MAINTENANCE: '1' }, NOW)).toEqual({ active: true, endsAt: null })
  })

  it('refuses users and signed-out callers, never administrators, and never when it is not active', () => {
    const on = { active: true, endsAt: null }
    expect(maintenanceBlocks(on, { role: 'user' })).toBe(true)
    expect(maintenanceBlocks(on, null)).toBe(true)
    expect(maintenanceBlocks(on, undefined)).toBe(true)
    expect(maintenanceBlocks(on, { role: 'admin' })).toBe(false)
    expect(maintenanceBlocks({ active: false, endsAt: null }, { role: 'user' })).toBe(false)
  })

  it('assertNotInMaintenance throws the maintenance code; a runtime without settings never blocks', () => {
    const on = { settings: () => ({ maintenanceOn: true, maintenanceEndsAt: 0 }) }
    expect(() => assertNotInMaintenance(on, { role: 'user' }, NOW, {})).toThrow(expect.objectContaining({ code: 'maintenance' }))
    expect(() => assertNotInMaintenance(on, { role: 'admin' }, NOW, {})).not.toThrow()
    expect(() => assertNotInMaintenance({}, { role: 'user' }, NOW, {})).not.toThrow()
    expect(() => assertNotInMaintenance({ settings: () => off }, { role: 'user' }, NOW, {})).not.toThrow()
  })

  it('the transport answers 503 with the code only', () => {
    expect(authErrorResponse(new AuthError('maintenance'))).toEqual({ body: { code: 'maintenance' }, status: 503 })
  })
})

describe('target sessions (functions and raw routes)', () => {
  const resolved = (role: 'admin' | 'user') => ({ kind: 'account', pool: {}, scopeKey: 'k', idHash: 'h', connectionId: 'c', user: { id: 'u', username: 'u', displayName: 'u', role, securityVersion: 0 } })
  const runtime = (role: 'admin' | 'user', mode: 'account' | 'direct', on: boolean) =>
    ({
      sessions: { resolveTarget: () => resolved(role), resolve: () => ({ idHash: 'direct' }), verifyCsrf: () => true },
      setup: { startupState: () => ({ kind: 'ready', mode }) },
      settings: () => ({ maintenanceOn: on, maintenanceEndsAt: 0 }),
    }) as never
  const input = { token: 't', connectionId: 'c', csrf: 'x', background: false }

  it('a user is refused with maintenance while it is on, an administrator is not', async () => {
    await expect(resolveTargetSession(runtime('user', 'account', true), input)).rejects.toMatchObject({ code: 'maintenance' })
    await expect(resolveTargetSession(runtime('admin', 'account', true), input)).resolves.toMatchObject({ sessionIdHash: 'h' })
    await expect(resolveTargetSession(runtime('user', 'account', false), input)).resolves.toMatchObject({ sessionIdHash: 'h' })
  })

  it('direct mode has no maintenance mode', async () => {
    await expect(resolveTargetSession(runtime('user', 'direct', true), input)).resolves.toEqual({ idHash: 'direct' })
  })
})

describe('sign-in and session info', () => {
  const RP = { rpId: 'dbloom.test', origin: 'https://dbloom.test' }
  const PASSWORD = 'correct horse battery staple'
  const META = { address: '203.0.113.7', clientHint: 'Chrome on Windows' }
  let dir: string
  let store: SqliteStore
  let clock: number
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbloom-maint-'))
    store = openSqliteStore(join(dir, 'store.db'))
    clock = Date.now()
    env = { DBLOOM_PUBLIC_ORIGIN: RP.origin }
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function rig() {
    const resolver = createAuthSettingsResolver(store.accounts, env)
    const sessions = new SessionManager(store, { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3600_000 }, () => clock, () => resolver.resolve())
    const password = createPasswordService({ contains: async () => false, source: () => ({ kind: 'none', entries: 0 }) })
    const ring = new ServerKeyRing(randomBytes(32), undefined)
    const challenges = createChallengeStore(() => clock)
    const users = createUserService(store.accounts, (p) => password.hash(p, ARGON2_LOGIN_DEFAULT), () => clock, () => resolver.resolve())
    const deps: SignInDeps = {
      store: store.accounts,
      sessions,
      users,
      settings: resolver,
      throttle: new BackoffThrottle(5, 15 * 60_000, 15 * 60_000, () => clock),
      password,
      totp: new OwnTotp(),
      codes: createRecoveryCodeService(ring),
      ring,
      challenges,
      webauthn: createWebAuthnService({ challenges, relyingParty: () => ({ ...RP, rpName: 'DBLoom' }) }),
      maintenanceBlocks: (user) => maintenanceBlocks(maintenanceView(resolver.resolve(), env, clock), user),
      now: () => clock,
    }
    return { deps, resolver, sessions, users, signIn: createSignInService(deps) }
  }
  const setting = (key: AuthSettingKey, value: unknown) => {
    createSettingsWriter({ store: store.accounts, env, changed: () => undefined, audit: () => undefined }).set(key, value, store.accounts.getSettings().find((s) => s.key === key)?.updatedAt ?? null, 'test')
  }
  const sessionCount = () => (store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n

  it('a user is refused after the password proved them: no session, no failed attempt; an administrator signs in', async () => {
    const r = rig()
    await r.users.create({ username: 'ana', displayName: 'ana', role: 'user', password: PASSWORD }, 'setup')
    await r.users.create({ username: 'root', displayName: 'root', role: 'admin', password: PASSWORD }, 'setup')
    setting('maintenanceOn', true)
    for (let i = 0; i < 8; i++) {
      await expect(r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).rejects.toMatchObject({ code: 'maintenance' })
    }
    expect(sessionCount()).toBe(0)
    // eight refusals did not feed the throttle (five failures would lock the account)
    const wrong = await r.signIn.passwordSignIn({ username: 'ana', password: 'wrong wrong wrong wrong' }, META).catch((e: AuthError) => e)
    expect((wrong as AuthError).code).toBe('auth_failed')
    expect((await r.signIn.passwordSignIn({ username: 'root', password: PASSWORD }, META)).state).toBe('enrol_only') // an administrator gets through (2FA enrolment is the ordinary state of a new one)
    // a wrong password during maintenance is the ordinary refusal: the mode is not a way to learn who exists
    const ghost = await r.signIn.passwordSignIn({ username: 'ghost', password: PASSWORD }, META).catch((e: AuthError) => e)
    expect((ghost as AuthError).code).toBe('auth_failed')
    setting('maintenanceOn', false)
    expect((await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).state).toBe('full')
  })

  it('the refusal is audited and ends by itself at the end time', async () => {
    const logs: string[] = []
    vi.mocked(console.log).mockImplementation((l: unknown) => void logs.push(String(l)))
    const r = rig()
    await r.users.create({ username: 'ana', displayName: 'ana', role: 'user', password: PASSWORD }, 'setup')
    setting('maintenanceOn', true)
    setting('maintenanceEndsAt', clock + 60_000)
    await expect(r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).rejects.toMatchObject({ code: 'maintenance' })
    expect(logs.join('\n')).toMatch(/"audit":"auth.signin".*"outcome":"refused".*"reason":"maintenance"/)
    clock += 60_001
    expect((await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).state).toBe('full')
  })

  it('the passkey sign-in is refused the same way', async () => {
    const r = rig()
    const user = await r.users.create({ username: 'ana', displayName: 'ana', role: 'user', password: PASSWORD }, 'setup')
    const key = new SoftAuthenticator({ ...RP, userVerified: true })
    const opts = await r.deps.webauthn.registrationOptions(user, [], 'enrol_passkey', 'enrol')
    const info = await r.deps.webauthn.verifyRegistration('enrol', 'enrol_passkey', key.register(opts.challenge), { requireUserVerification: true })
    store.accounts.addPasskey({ ...info, userId: user.id, name: 'key', createdAt: clock, lastUsedAt: null })
    setting('maintenanceOn', true)
    const { preAuthCookie, options } = await r.signIn.passkeyBegin({ address: META.address })
    await expect(r.signIn.passkeyFinish(preAuthCookie, key.assert(options.challenge, { userHandle: user.webauthnUserId }) as never, META)).rejects.toMatchObject({ code: 'maintenance' })
    expect(sessionCount()).toBe(0)
  })

  it('session info tells everybody the state of maintenance, and shows the banner to full sessions only', async () => {
    const r = rig()
    const user = await r.users.create({ username: 'ana', displayName: 'ana', role: 'user', password: PASSWORD }, 'setup')
    setting('infoBanner', 'Backup tonight')
    setting('maintenanceOn', true)
    setting('maintenanceEndsAt', clock + 5_000)
    const base = {
      runtime: { sessions: r.sessions, config: { sessionIdleMs: 1, readOnly: false }, store, setup: { startupState: () => ({ kind: 'ready', mode: 'account' }) } } as never,
      settings: () => r.resolver.resolve(),
      prefs: () => ({ get: () => ({}) }) as never,
      stateless: false,
      connections: () => [],
      vaultStatus: () => ({ exists: false, unlocked: false, autoLockAt: null, enabled: false }),
      now: () => clock,
      env,
    }
    const full = r.sessions.createAccount(user, 'full', META)
    expect(buildSessionInfo({ ...base, token: full.token })).toMatchObject({ banner: 'Backup tonight', maintenance: { active: true, endsAt: clock + 5_000 } })
    const pending = r.sessions.createAccount(user, 'pending_mfa', META)
    const half = buildSessionInfo({ ...base, token: pending.token })!
    expect(half).toMatchObject({ maintenance: { active: true } })
    expect(half).not.toHaveProperty('banner')
    setting('infoBanner', '')
    setting('maintenanceOn', false)
    const quiet = buildSessionInfo({ ...base, token: full.token })!
    expect(quiet).toMatchObject({ maintenance: { active: false, endsAt: null } })
    expect(quiet).not.toHaveProperty('banner')
  })
})
