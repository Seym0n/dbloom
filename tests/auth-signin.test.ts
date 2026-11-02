/** Package C: sign-in, second factor, passkey sign-in, step-up, enumeration timing (FR-AUT-006, 009, 011, 012, 013, 027).
 * Real SQLite store in a temp directory (no Docker needed); Argon2id at the default cost.
 */
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
import { clientHintOf, createSignInService, sha256Hex, type SignInDeps } from '~/server/auth/signin'
import { createStepUp } from '~/server/auth/stepup'
import { BackoffThrottle } from '~/server/auth/throttle'
import { OwnTotp, hotp } from '~/server/auth/totp'
import { AAD, ARGON2_LOGIN_DEFAULT, AuthError, type AccountContext, type User } from '~/server/auth/types'
import { createUserService } from '~/server/auth/users'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SoftAuthenticator } from './auth-authenticator'

const RP = { rpId: 'dbloom.test', origin: 'https://dbloom.test' }
const PASSWORD = 'correct horse battery staple'
const META = { address: '203.0.113.7', clientHint: 'Chrome on Windows' }

let dir: string
let store: SqliteStore
let clock: { t: number }
let logs: string[]

type Rig = ReturnType<typeof rig>
function rig(opts: { throttleFailures?: number } = {}) {
  const resolver = createAuthSettingsResolver(store.accounts, { DBLOOM_PUBLIC_ORIGIN: RP.origin } as NodeJS.ProcessEnv)
  const sessions = new SessionManager(store, { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3600_000 }, () => clock.t, () => resolver.resolve())
  const password = createPasswordService({ contains: async () => false, source: () => ({ kind: 'none', entries: 0 }) })
  const ring = new ServerKeyRing(randomBytes(32), undefined)
  const challenges = createChallengeStore(() => clock.t)
  const users = createUserService(store.accounts, (p) => password.hash(p, ARGON2_LOGIN_DEFAULT), () => clock.t, () => resolver.resolve())
  const throttle = new BackoffThrottle(opts.throttleFailures ?? 5, 15 * 60_000, 15 * 60_000, () => clock.t)
  const deps: SignInDeps = {
    store: store.accounts,
    sessions,
    users,
    settings: resolver,
    throttle,
    password,
    totp: new OwnTotp(),
    codes: createRecoveryCodeService(ring),
    ring,
    challenges,
    webauthn: createWebAuthnService({ challenges, relyingParty: () => ({ ...RP, rpName: 'DBLoom' }) }),
    now: () => clock.t,
  }
  return { deps, signIn: createSignInService(deps), stepUp: createStepUp(deps), sessions, users, resolver, throttle, ring, challenges }
}

const create = (r: Rig, name: string, extra: { role?: 'admin' | 'user'; temporary?: boolean } = {}) =>
  r.users.create({ username: name, displayName: name, role: extra.role ?? 'user', password: PASSWORD }, 'setup', { temporary: !!extra.temporary })

const ctxOf = (r: Rig, token: string): AccountContext => {
  const ctx = r.sessions.resolveAccount(token, { background: true })
  if (!ctx) throw new Error('no session')
  return ctx
}
const codeAt = (secret: Buffer, offsetSteps = 0) => hotp(secret, Math.floor(clock.t / 1000 / 30) + offsetSteps)
const addTotp = (r: Rig, user: User) => {
  const secret = randomBytes(20)
  store.accounts.setTotp({ userId: user.id, sealed: r.ring.seal('totp', AAD.totp(user.id), secret), lastStep: 0, createdAt: clock.t })
  return secret
}
const addPasskey = async (r: Rig, user: User, auth: SoftAuthenticator, uv: boolean) => {
  const opts = await r.deps.webauthn.registrationOptions(user, [], 'enrol_passkey', 'enrol')
  const info = await r.deps.webauthn.verifyRegistration('enrol', 'enrol_passkey', auth.register(opts.challenge), { requireUserVerification: uv })
  store.accounts.addPasskey({ ...info, userId: user.id, name: 'key', createdAt: clock.t, lastUsedAt: null })
}
const failure = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x)
  expect(e).toBeInstanceOf(AuthError)
  return e as AuthError
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-authc-'))
  store = openSqliteStore(join(dir, 'store.db'))
  clock = { t: Date.now() }
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('password sign-in (FR-AUT-006)', () => {
  it('gives a full session without a factor, with a fresh token and csrf', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const result = await r.signIn.passwordSignIn({ username: 'Ana', password: PASSWORD }, META)
    expect(result.state).toBe('full')
    expect(result.token).not.toBe(result.csrf)
    expect(ctxOf(r, result.token)).toMatchObject({ state: 'full', user: { id: user.id } })
    expect(store.accounts.getUser(user.id)?.lastSignInAt).toBe(clock.t)
  })

  it('answers unknown, disabled, password-less and wrong password identically', async () => {
    const r = rig({ throttleFailures: 1000 })
    await create(r, 'ana')
    const disabled = await create(r, 'dis')
    const noPw = await create(r, 'nopw')
    await create(r, 'admin2', { role: 'admin' }) // keeps the last-admin guard out of the way
    r.users.setStatus(disabled.id, 'disabled', { id: 'x', username: 'x', displayName: 'x', role: 'admin', securityVersion: 0 })
    store.accounts.deletePassword(noPw.id)
    const errors = await Promise.all(
      [
        { username: 'ghost', password: PASSWORD },
        { username: 'dis', password: PASSWORD },
        { username: 'nopw', password: PASSWORD },
        { username: 'ana', password: 'wrong wrong wrong wrong' },
      ].map((input) => failure(r.signIn.passwordSignIn(input, META))),
    )
    for (const e of errors) {
      expect(e.code).toBe('auth_failed')
      expect(e.message).toBe('auth_failed')
      expect(e.detail).toEqual({})
    }
  })

  it('refuses password sign-in when ST-057 does not allow passwords, and an expired temporary password', async () => {
    const r = rig()
    await create(r, 'ana')
    await create(r, 'tmp', { temporary: true })
    const user = store.accounts.getUserByKey('tmp')!
    expect((await r.signIn.passwordSignIn({ username: 'tmp', password: PASSWORD }, META)).state).toBe('must_change')
    clock.t = user.tempPasswordExpiresAt! + 1
    expect((await failure(r.signIn.passwordSignIn({ username: 'tmp', password: PASSWORD }, META))).code).toBe('auth_failed')
    r.resolver.write({ primaryCredentials: ['passkey'] }, 'test')
    expect((await failure(r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META))).code).toBe('auth_failed')
  })

  it('throttles after five failures, unknown names too, with a wait and no hash', async () => {
    const r = rig()
    await create(r, 'ana')
    for (const name of ['ana', 'ghost']) {
      for (let i = 0; i < 5; i += 1) {
        const meta = { ...META, address: `198.51.100.${name === 'ana' ? i : 100 + i}` }
        expect((await failure(r.signIn.passwordSignIn({ username: name, password: 'nope nope nope nope' }, meta))).code).toBe('auth_failed')
      }
      const t0 = performance.now()
      const e = await failure(r.signIn.passwordSignIn({ username: name, password: PASSWORD }, { ...META, address: '192.0.2.99' }))
      expect(e.code).toBe('auth_throttled')
      expect(e.detail.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(performance.now() - t0).toBeLessThan(50) // refused before any Argon2
    }
    // Never permanent: the backoff ends.
    clock.t += 20 * 60_000
    expect((await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).state).toBe('full')
  })

  it('does not reset the account counter while a second factor is still to be guessed', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    for (let i = 0; i < 4; i += 1) await failure(r.signIn.passwordSignIn({ username: 'ana', password: 'nope nope nope nope' }, META))
    expect((await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).state).toBe('pending_mfa')
    await failure(r.signIn.passwordSignIn({ username: 'ana', password: 'nope nope nope nope' }, META))
    expect((await failure(r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META))).code).toBe('auth_throttled')
  })

  it('keeps passwords, codes and tokens out of the audit log', async () => {
    const r = rig()
    await create(r, 'ana')
    const ok = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    await failure(r.signIn.passwordSignIn({ username: 'ana', password: 'wrongpassword-marker' }, META))
    const text = logs.join('\n')
    expect(text).toContain('auth.signin')
    for (const secret of [PASSWORD, 'wrongpassword-marker', ok.token, ok.csrf]) expect(text).not.toContain(secret)
  })
})

describe('2FA policy and states (FR-AUT-012)', () => {
  it('enrol_only for an enforced user without a factor, full while the grace period runs', async () => {
    const r = rig()
    await create(r, 'carl')
    r.resolver.write({ mfaScope: 'all' }, 'test')
    clock.t = Date.now() + 1000 // the policy change is stamped with the real clock
    expect((await r.signIn.passwordSignIn({ username: 'carl', password: PASSWORD }, META)).state).toBe('enrol_only')
    r.resolver.write({ mfaGraceMs: 3600_000 }, 'test')
    expect((await r.signIn.passwordSignIn({ username: 'carl', password: PASSWORD }, META)).state).toBe('full')
    clock.t += 3600_000 + 5000
    expect((await r.signIn.passwordSignIn({ username: 'carl', password: PASSWORD }, META)).state).toBe('enrol_only')
  })

  it('administrators always need a factor', async () => {
    const r = rig()
    await create(r, 'boss', { role: 'admin' })
    expect((await r.signIn.passwordSignIn({ username: 'boss', password: PASSWORD }, META)).state).toBe('enrol_only')
  })

  it('pending_mfa for any user holding a factor, even when 2FA is not required', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    expect((await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)).state).toBe('pending_mfa')
  })

  it('a temporary password leads to must_change after the second factor', async () => {
    const r = rig()
    const user = await create(r, 'dora', { temporary: true })
    const secret = addTotp(r, user)
    const s = await r.signIn.passwordSignIn({ username: 'dora', password: PASSWORD }, META)
    expect(s.state).toBe('pending_mfa')
    await r.signIn.mfaOptions(ctxOf(r, s.token), 'totp')
    const done = await r.signIn.mfaVerify(ctxOf(r, s.token), s.token, { method: 'totp', code: codeAt(secret) })
    expect(done.state).toBe('must_change')
  })
})

describe('second factor (FR-AUT-011)', () => {
  async function pending(r: Rig, name = 'ana') {
    const user = await create(r, name)
    const secret = addTotp(r, user)
    const s = await r.signIn.passwordSignIn({ username: name, password: PASSWORD }, META)
    return { user, secret, s, ctx: ctxOf(r, s.token) }
  }

  it('TOTP: full session, new token, old token dead, mfa_at and step-up set', async () => {
    const r = rig()
    const { secret, s, ctx } = await pending(r)
    expect(await r.signIn.mfaOptions(ctx, 'totp')).toEqual({ method: 'totp' })
    const done = await r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: codeAt(secret) })
    expect(done.state).toBe('full')
    expect(done.token).not.toBe(s.token)
    expect(r.sessions.resolveAccount(s.token, { background: true })).toBeUndefined()
    expect(ctxOf(r, done.token)).toMatchObject({ state: 'full', mfaAt: clock.t, stepupAt: clock.t })
  })

  it('refuses a code without a held challenge and ends the session', async () => {
    const r = rig()
    const { secret, s, ctx } = await pending(r)
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: codeAt(secret) }))).code).toBe('mfa_expired')
    expect(r.sessions.resolveAccount(s.token, { background: true })).toBeUndefined()
  })

  it('refuses a replayed TOTP code in a second sign-in', async () => {
    const r = rig()
    const { secret, s, ctx } = await pending(r)
    await r.signIn.mfaOptions(ctx, 'totp')
    await r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: codeAt(secret) })
    const again = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx2 = ctxOf(r, again.token)
    await r.signIn.mfaOptions(ctx2, 'totp')
    expect((await failure(r.signIn.mfaVerify(ctx2, again.token, { method: 'totp', code: codeAt(secret) }))).code).toBe('mfa_failed')
    // The next step's code works.
    clock.t += 30_000
    expect((await r.signIn.mfaVerify(ctx2, again.token, { method: 'totp', code: codeAt(secret) })).state).toBe('full')
  })

  it('ends the challenge and the session after five wrong codes (SCN-066)', async () => {
    const r = rig({ throttleFailures: 100 })
    const { s, ctx } = await pending(r)
    await r.signIn.mfaOptions(ctx, 'totp')
    for (let i = 0; i < 4; i += 1) expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: '000000' }))).code).toBe('mfa_failed')
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: '000000' }))).code).toBe('mfa_expired')
    expect(r.sessions.resolveAccount(s.token, { background: true })).toBeUndefined()
  })

  it('asking for options again does not reset the tries', async () => {
    const r = rig({ throttleFailures: 100 })
    const { s, ctx } = await pending(r)
    for (let i = 0; i < 4; i += 1) {
      await r.signIn.mfaOptions(ctx, 'totp')
      await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: '000000' }))
    }
    await r.signIn.mfaOptions(ctx, 'totp')
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: '000000' }))).code).toBe('mfa_expired')
  })

  it('wrong codes count on the account key and trigger the backoff', async () => {
    const r = rig()
    const { s, ctx } = await pending(r)
    await r.signIn.mfaOptions(ctx, 'totp')
    for (let i = 0; i < 4; i += 1) await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: '000000' }))
    // Fifth failure ends the challenge; the account key is now in backoff.
    await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: '000000' }))
    expect(r.throttle.delayMs('acct:ana')).toBeGreaterThan(0)
  })

  it('expires the pending state after five minutes', async () => {
    const r = rig()
    const { secret, s, ctx } = await pending(r)
    await r.signIn.mfaOptions(ctx, 'totp')
    clock.t += 5 * 60_000
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: codeAt(secret) }))).code).toBe('mfa_expired')
  })

  it('recovery code works once, the count drops, the second use fails (FR-AUT-010)', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    const codes = r.deps.codes.generate()
    store.accounts.replaceRecoveryCodes(user.id, codes.map((c) => r.deps.codes.mac(user.id, r.deps.codes.normalise(c)!)), clock.t)
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx = ctxOf(r, s.token)
    expect(await r.signIn.mfaOptions(ctx, 'recovery')).toEqual({ method: 'recovery' })
    const lower = codes[0]!.toLowerCase().replace(/-/g, ' ')
    expect((await r.signIn.mfaVerify(ctx, s.token, { method: 'recovery', code: lower })).state).toBe('full')
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(9)
    const s2 = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx2 = ctxOf(r, s2.token)
    await r.signIn.mfaOptions(ctx2, 'recovery')
    expect((await failure(r.signIn.mfaVerify(ctx2, s2.token, { method: 'recovery', code: codes[0]! }))).code).toBe('mfa_failed')
    expect(logs.join('\n')).not.toContain(codes[0]!)
  })

  it('a code step refuses a session that is not pending_mfa', async () => {
    const r = rig()
    await create(r, 'ana')
    const full = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx = ctxOf(r, full.token)
    expect((await failure(r.signIn.mfaOptions(ctx, 'totp'))).code).toBe('mfa_failed')
    expect((await failure(r.signIn.mfaVerify(ctx, full.token, { method: 'totp', code: '123456' }))).code).toBe('mfa_failed')
  })

  it('an unreadable TOTP secret counts as no TOTP and is audited (SEC-SAU-067)', async () => {
    const r = rig()
    const { user, secret, s, ctx } = await pending(r)
    store.accounts.setTotp({ userId: user.id, sealed: 'v1.garbage', lastStep: 0, createdAt: clock.t })
    await r.signIn.mfaOptions(ctx, 'totp')
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'totp', code: codeAt(secret) }))).code).toBe('mfa_failed')
    expect(logs.join('\n')).toContain('secret.unreadable')
  })

  it('passkey as second factor accepts a non-verifying authenticator, rejects replay and a foreign credential', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const other = await create(r, 'bob')
    const key = new SoftAuthenticator({ ...RP, userVerified: false })
    await addPasskey(r, user, key, false)
    const foreign = new SoftAuthenticator({ ...RP })
    await addPasskey(r, other, foreign, true)
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx = ctxOf(r, s.token)
    const options = (await r.signIn.mfaOptions(ctx, 'passkey')) as { challenge: string; allowCredentials: unknown[] }
    expect(options.allowCredentials).toHaveLength(1)
    const response = key.assert(options.challenge)
    // A credential of another user fails and burns the challenge.
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'passkey', response: foreign.assert(options.challenge) as never }))).code).toBe('mfa_failed')
    expect((await failure(r.signIn.mfaVerify(ctx, s.token, { method: 'passkey', response: response as never }))).code).toBe('mfa_failed')
    const fresh = (await r.signIn.mfaOptions(ctx, 'passkey')) as { challenge: string }
    const done = await r.signIn.mfaVerify(ctx, s.token, { method: 'passkey', response: key.assert(fresh.challenge) as never })
    expect(done.state).toBe('full')
    // Replay of the same assertion with a new session fails: the counter did not increase and the challenge is gone.
    const s2 = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx2 = ctxOf(r, s2.token)
    const o2 = (await r.signIn.mfaOptions(ctx2, 'passkey')) as { challenge: string }
    key.counter -= 1 // the same counter value as the accepted assertion
    expect((await failure(r.signIn.mfaVerify(ctx2, s2.token, { method: 'passkey', response: key.assert(o2.challenge, { counter: key.counter }) as never }))).code).toBe('mfa_failed')
    expect(logs.join('\n')).toContain('webauthn.counter')
  })
})

describe('passkey sign-in (SCN-067)', () => {
  async function passwordlessRig(uv: boolean) {
    const r = rig()
    const user = await create(r, 'ana')
    const key = new SoftAuthenticator({ ...RP, userVerified: uv })
    await addPasskey(r, user, key, uv)
    return { r, user, key }
  }
  const begin = async (r: Rig) => {
    const { preAuthCookie, options } = await r.signIn.passkeyBegin({ address: META.address })
    return { preAuthCookie, challenge: options.challenge, options }
  }

  it('gives a full session with user verification and sets the factor flags', async () => {
    const { r, user, key } = await passwordlessRig(true)
    const { preAuthCookie, challenge, options } = await begin(r)
    expect(options.userVerification).toBe('required')
    expect(options.allowCredentials ?? []).toHaveLength(0)
    const result = await r.signIn.passkeyFinish(preAuthCookie, key.assert(challenge, { userHandle: user.webauthnUserId }) as never, META)
    expect(result.state).toBe('full')
    expect(ctxOf(r, result.token)).toMatchObject({ state: 'full', mfaAt: clock.t, user: { id: user.id } })
  })

  it('refuses a non-verifying authenticator for passwordless', async () => {
    const { r, user, key } = await passwordlessRig(false)
    const { preAuthCookie, challenge } = await begin(r)
    expect((await failure(r.signIn.passkeyFinish(preAuthCookie, key.assert(challenge, { userHandle: user.webauthnUserId }) as never, META))).code).toBe('mfa_failed')
  })

  it('refuses a missing or foreign user handle, a replay and a wrong origin', async () => {
    const { r, user, key } = await passwordlessRig(true)
    let b = await begin(r)
    expect((await failure(r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge) as never, META))).code).toBe('mfa_failed')
    b = await begin(r)
    expect((await failure(r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge, { userHandle: 'AAAA' }) as never, META))).code).toBe('mfa_failed')
    b = await begin(r)
    expect((await failure(r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge, { userHandle: user.webauthnUserId, origin: 'https://evil.test' }) as never, META))).code).toBe('mfa_failed')
    b = await begin(r)
    const good = key.assert(b.challenge, { userHandle: user.webauthnUserId })
    await r.signIn.passkeyFinish(b.preAuthCookie, good as never, META)
    // Same response again: no held challenge any more.
    expect((await failure(r.signIn.passkeyFinish(b.preAuthCookie, good as never, META))).code).toBe('mfa_failed')
    // A response bound to another pre-auth cookie does not verify either.
    const other = await begin(r)
    const mine = await begin(r)
    expect((await failure(r.signIn.passkeyFinish(other.preAuthCookie, key.assert(mine.challenge, { userHandle: user.webauthnUserId }) as never, META))).code).toBe('mfa_failed')
  })

  it('is refused when ST-057 does not offer passkeys, and for a disabled user', async () => {
    const { r, user, key } = await passwordlessRig(true)
    const b = await begin(r)
    await create(r, 'second-admin', { role: 'admin' })
    r.users.setStatus(user.id, 'disabled', { id: 'x', username: 'x', displayName: 'x', role: 'admin', securityVersion: 0 })
    expect((await failure(r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge, { userHandle: user.webauthnUserId }) as never, META))).code).toBe('mfa_failed')
    r.resolver.write({ primaryCredentials: ['password'] }, 'test')
    expect((await failure(r.signIn.passkeyBegin({ address: META.address }))).code).toBe('auth_failed')
  })

  it('accepts a counter of 0 on both sides and refuses a lowered one', async () => {
    const { r, user, key } = await passwordlessRig(true)
    let b = await begin(r)
    await r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge, { userHandle: user.webauthnUserId, counter: 0 }) as never, META)
    b = await begin(r)
    await r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge, { userHandle: user.webauthnUserId, counter: 5 }) as never, META)
    b = await begin(r)
    expect((await failure(r.signIn.passkeyFinish(b.preAuthCookie, key.assert(b.challenge, { userHandle: user.webauthnUserId, counter: 3 }) as never, META))).code).toBe('mfa_failed')
    expect(logs.join('\n')).toContain('webauthn.counter')
  })
})

describe('sign-out', () => {
  it('ends a pending session too and drops its challenges', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    await r.signIn.mfaOptions(ctxOf(r, s.token), 'totp')
    await r.signIn.signOut(s.token)
    expect(r.sessions.resolveAccount(s.token, { background: true })).toBeUndefined()
    await r.signIn.signOut(undefined) // no throw without a cookie
  })
})

describe('step-up (FR-AUT-013, SCN-076)', () => {
  async function fullSession(r: Rig, name = 'ana') {
    const user = await create(r, name)
    const secret = addTotp(r, user)
    const s = await r.signIn.passwordSignIn({ username: name, password: PASSWORD }, META)
    await r.signIn.mfaOptions(ctxOf(r, s.token), 'totp')
    const done = await r.signIn.mfaVerify(ctxOf(r, s.token), s.token, { method: 'totp', code: codeAt(secret) })
    return { user, secret, token: done.token }
  }

  it('passes inside the window and asks again after it', async () => {
    const r = rig()
    const { token } = await fullSession(r)
    r.stepUp.requireRecentFactor(ctxOf(r, token), 'invite')
    clock.t += 5 * 60_000
    const e = (() => { try { r.stepUp.requireRecentFactor(ctxOf(r, token), 'invite') } catch (x) { return x as AuthError } })()
    expect(e?.code).toBe('stepup_required')
  })

  it('TOTP step-up renews the window with a new token; a code cannot be replayed', async () => {
    const r = rig()
    const { secret, token } = await fullSession(r)
    clock.t += 5 * 60_000 + 30_000
    await r.stepUp.options(ctxOf(r, token), 'totp')
    const renewed = await r.stepUp.verify(ctxOf(r, token), token, { method: 'totp', code: codeAt(secret) })
    expect(renewed.token).not.toBe(token)
    expect(renewed.stepUpUntil).toBe(clock.t + 5 * 60_000)
    r.stepUp.requireRecentFactor(ctxOf(r, renewed.token), 'invite')
    // The same code again (next window) is a replay.
    clock.t += 5 * 60_000
    await r.stepUp.options(ctxOf(r, renewed.token), 'totp')
    expect((await failure(r.stepUp.verify(ctxOf(r, renewed.token), renewed.token, { method: 'totp', code: codeAt(secret, -10) }))).code).toBe('mfa_failed')
  })

  it('a wrong code and a missing challenge fail; the window stays closed', async () => {
    const r = rig()
    const { secret, token } = await fullSession(r)
    clock.t += 6 * 60_000
    expect((await failure(r.stepUp.verify(ctxOf(r, token), token, { method: 'totp', code: codeAt(secret) }))).code).toBe('mfa_failed')
    await r.stepUp.options(ctxOf(r, token), 'totp')
    expect((await failure(r.stepUp.verify(ctxOf(r, token), token, { method: 'totp', code: '000000' }))).code).toBe('mfa_failed')
    expect(() => r.stepUp.requireRecentFactor(ctxOf(r, token), 'x')).toThrow('stepup_required')
  })

  it('password step-up only for users without any factor', async () => {
    const r = rig()
    await create(r, 'plain')
    const s = await r.signIn.passwordSignIn({ username: 'plain', password: PASSWORD }, META)
    clock.t += 6 * 60_000
    await r.stepUp.options(ctxOf(r, s.token), 'password')
    expect((await failure(r.stepUp.verify(ctxOf(r, s.token), s.token, { method: 'password', password: 'wrong wrong wrong' }))).code).toBe('auth_failed')
    const ok = await r.stepUp.verify(ctxOf(r, s.token), s.token, { method: 'password', password: PASSWORD })
    r.stepUp.requireRecentFactor(ctxOf(r, ok.token), 'x')
    // A user with a factor cannot use the password.
    const { token } = await fullSession(r, 'withfactor')
    expect((await failure(r.stepUp.options(ctxOf(r, token), 'password'))).code).toBe('mfa_failed')
    expect((await failure(r.stepUp.verify(ctxOf(r, token), token, { method: 'password', password: PASSWORD }))).code).toBe('mfa_failed')
  })

  it('passkey step-up requires user verification', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const nv = new SoftAuthenticator({ ...RP, userVerified: false })
    await addPasskey(r, user, nv, false)
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    const ctx = ctxOf(r, s.token)
    const o1 = (await r.signIn.mfaOptions(ctx, 'passkey')) as { challenge: string }
    const full = await r.signIn.mfaVerify(ctx, s.token, { method: 'passkey', response: nv.assert(o1.challenge) as never })
    clock.t += 6 * 60_000
    const o2 = (await r.stepUp.options(ctxOf(r, full.token), 'passkey')) as { challenge: string; userVerification: string }
    expect(o2.userVerification).toBe('required')
    expect((await failure(r.stepUp.verify(ctxOf(r, full.token), full.token, { method: 'passkey', response: nv.assert(o2.challenge) as never }))).code).toBe('mfa_failed')
  })

  it('refuses non-full sessions', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    const s = await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META)
    expect(() => r.stepUp.requireRecentFactor(ctxOf(r, s.token), 'x')).toThrow('stepup_required')
    expect((await failure(r.stepUp.options(ctxOf(r, s.token), 'totp'))).code).toBe('stepup_required')
  })
})

describe('helpers', () => {
  it('clientHintOf gives browser and OS family only', () => {
    expect(clientHintOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('Chrome on Windows')
    expect(clientHintOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('Safari on macOS')
    expect(clientHintOf(undefined)).toBe('Browser')
    expect(sha256Hex('a')).toHaveLength(64)
  })
})

describe('enumeration timing (FR-AUT-006, success criterion 3)', () => {
  it('unknown user, disabled user and wrong password: same error, timing within 20% (median of 50)', async () => {
    const r = rig({ throttleFailures: 100_000 })
    await create(r, 'ana')
    const dis = await create(r, 'dis')
    await create(r, 'keeper', { role: 'admin' })
    r.users.setStatus(dis.id, 'disabled', { id: 'x', username: 'x', displayName: 'x', role: 'admin', securityVersion: 0 })
    const kinds = {
      unknown: () => ({ username: `ghost${Math.random()}`, password: PASSWORD }),
      disabled: () => ({ username: 'dis', password: PASSWORD }),
      wrong: () => ({ username: 'ana', password: 'wrong wrong wrong wrong' }),
    } as const
    const times: Record<keyof typeof kinds, number[]> = { unknown: [], disabled: [], wrong: [] }
    const bodies = new Set<string>()
    await r.signIn.passwordSignIn({ username: 'ana', password: PASSWORD }, META) // warm up (dummy hash, JIT)
    for (let i = 0; i < 50; i += 1) {
      for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
        const t0 = performance.now()
        const e = await failure(r.signIn.passwordSignIn(kinds[kind](), { ...META, address: `10.0.${i % 250}.${i}` }))
        times[kind].push(performance.now() - t0)
        bodies.add(JSON.stringify({ code: e.code, message: e.message, detail: e.detail }))
      }
    }
    expect(bodies.size).toBe(1)
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const m = { unknown: median(times.unknown), disabled: median(times.disabled), wrong: median(times.wrong) }
    for (const kind of ['unknown', 'disabled'] as const) {
      expect(Math.abs(m[kind] - m.wrong) / m.wrong, `${kind} ${m[kind].toFixed(1)} ms vs wrong ${m.wrong.toFixed(1)} ms`).toBeLessThan(0.2)
    }
  }, 120_000)
})
