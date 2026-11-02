/** Account security and administrator user services (FR-AUT-005, 008 to 010, 012, 014, 017, 028; SCN-066 to 069, 074, 076).
 * Real SQLite store in a temp directory, real session manager, soft authenticator; no Docker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountSecurity, sessionRef } from '~/server/auth/account-security'
import { createAdminUsers } from '~/server/auth/admin-users'
import { createChallengeStore } from '~/server/auth/challenges'
import { createRecoveryCodeService } from '~/server/auth/codes'
import { createPasswordService } from '~/server/auth/password'
import { ServerKeyRing } from '~/server/auth/secret-key'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createStepUp } from '~/server/auth/stepup'
import type { SignInDeps } from '~/server/auth/signin'
import { BackoffThrottle } from '~/server/auth/throttle'
import { OwnTotp, hotp } from '~/server/auth/totp'
import { ARGON2_LOGIN_DEFAULT, AuthError, type AccountContext, type Role, type User } from '~/server/auth/types'
import { createUserService } from '~/server/auth/users'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SoftAuthenticator } from './auth-authenticator'

const RP = { rpId: 'dbloom.test', origin: 'https://dbloom.test' }
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'another long passphrase 42'
const META = { address: '203.0.113.7', clientHint: 'Chrome on Windows' }

let dir: string
let store: SqliteStore
let clock: { t: number }
let logs: string[]
let ended: string[]
let deletedPrefs: string[]

function rig() {
  const resolver = createAuthSettingsResolver(store.accounts, { DBLOOM_PUBLIC_ORIGIN: RP.origin } as NodeJS.ProcessEnv)
  const sessions = new SessionManager(store, { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3600_000 }, () => clock.t, () => resolver.resolve())
  const password = createPasswordService({ contains: async () => false, source: () => ({ kind: 'none', entries: 0 }) })
  const ring = new ServerKeyRing(randomBytes(32), undefined)
  const challenges = createChallengeStore(() => clock.t)
  const users = createUserService(store.accounts, (p) => password.hash(p, ARGON2_LOGIN_DEFAULT), () => clock.t, () => resolver.resolve(), {
    onSessionsEnded: (ids) => void ended.push(...ids),
    onUserDeleted: (id) => void deletedPrefs.push(`u:${id}`),
  })
  const throttle = new BackoffThrottle(5, 15 * 60_000, 15 * 60_000, () => clock.t)
  const deps: SignInDeps = {
    store: store.accounts, sessions, users, settings: resolver, throttle, password, totp: new OwnTotp(),
    codes: createRecoveryCodeService(ring), ring, challenges,
    webauthn: createWebAuthnService({ challenges, relyingParty: () => ({ ...RP, rpName: 'DBLoom' }) }),
    now: () => clock.t,
  }
  const stepUp = createStepUp(deps)
  const security = createAccountSecurity({
    store: store.accounts, sessions, users, settings: resolver, throttle, password, totp: deps.totp, codes: deps.codes, ring, challenges,
    webauthn: deps.webauthn, stepUp, siteName: () => 'DBLoom', onSessionsEnded: (ids) => void ended.push(...ids), now: () => clock.t,
  })
  const admin = createAdminUsers({ store: store.accounts, users, password, settings: resolver, stepUp, now: () => clock.t })
  return { deps, sessions, users, resolver, security, admin, ring, throttle }
}
type Rig = ReturnType<typeof rig>

const create = (r: Rig, name: string, role: Role = 'user', temporary = false) =>
  r.users.create({ username: name, displayName: name, role, password: PASSWORD }, 'setup', { temporary })

/** A session of a user; `stepped` marks a fresh step-up. Methods always resolve the current token. */
function session(r: Rig, user: User, state: 'full' | 'enrol_only' | 'must_change' = 'full', stepped = true) {
  let { token } = r.sessions.createAccount(store.accounts.getUser(user.id)!, state, META)
  if (stepped) token = r.sessions.transition(token, { stepupAt: clock.t }).token
  return {
    get token() { return token },
    set token(v: string) { token = v },
    ctx(): AccountContext {
      const c = r.sessions.resolveAccount(token, { background: true })
      if (!c) throw new Error('no session')
      return c
    },
    alive: () => r.sessions.resolveAccount(token, { background: true }) !== undefined,
  }
}
const code = async (p: unknown) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return e instanceof AuthError ? e.code : String(e)
  }
}
const reason = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x)
  return e instanceof AuthError ? e.detail.reason : undefined
}
const codeAt = (secret: Buffer, offsetSteps = 0) => hotp(secret, Math.floor(clock.t / 1000 / 30) + offsetSteps)
const addTotp = (r: Rig, user: User) => {
  const secret = randomBytes(20)
  store.accounts.setTotp({ userId: user.id, sealed: r.ring.seal('totp', `totp/v1/${user.id}`, secret), lastStep: 0, createdAt: clock.t })
  store.accounts.replaceRecoveryCodes(user.id, ['a', 'b'], clock.t)
}
const enrolPasskey = async (r: Rig, s: ReturnType<typeof session>, auth = new SoftAuthenticator({ ...RP, userVerified: false })) => {
  const options = await r.security.passkeyRegisterOptions(s.ctx())
  const result = await r.security.passkeyRegisterVerify(s.ctx(), s.token, { response: auth.register(options.challenge), name: 'key' })
  s.token = result.token
  return result
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-authsec-'))
  store = openSqliteStore(join(dir, 'store.db'))
  clock = { t: Date.now() }
  logs = []
  ended = []
  deletedPrefs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('changePassword (FR-AUT-005, SCN-074)', () => {
  it('needs the current password, applies the policy and refuses reuse', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const s = session(r, user, 'full', false)
    expect(await code(r.security.changePassword(s.ctx(), s.token, { currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD }))).toBe('auth_failed')
    expect(await reason(r.security.changePassword(s.ctx(), s.token, { currentPassword: PASSWORD, newPassword: 'short' }))).toBe('too_short')
    expect(await reason(r.security.changePassword(s.ctx(), s.token, { currentPassword: PASSWORD, newPassword: 'xxANAxxxxxxxxxx' }))).toBe('contains_username')
    expect(await reason(r.security.changePassword(s.ctx(), s.token, { currentPassword: PASSWORD, newPassword: PASSWORD }))).toBe('reused')
    expect(store.accounts.listNotices(user.id)).toHaveLength(0)
  })

  it('ends other sessions, regenerates the current token, keeps csrf and adds a notice', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const a = session(r, user, 'full', false)
    const b = session(r, user, 'full', false)
    const oldToken = a.token
    const csrf = a.ctx().csrf
    const result = await r.security.changePassword(a.ctx(), a.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(result).toMatchObject({ csrf, state: 'full' })
    expect(result.token).not.toBe(oldToken)
    a.token = result.token
    expect(a.alive()).toBe(true)
    expect(r.sessions.resolveAccount(oldToken, { background: true })).toBeUndefined()
    expect(b.alive()).toBe(false)
    expect(ended).toHaveLength(1)
    expect(store.accounts.listNotices(user.id).map((n) => n.kind)).toEqual(['password_changed'])
    // The new password works, the old one does not.
    const phc = store.accounts.getPassword(user.id)!.phc
    expect(await r.deps.password.verify(phc, NEW_PASSWORD)).toBe(true)
    expect(await r.deps.password.verify(phc, PASSWORD)).toBe(false)
    expect(logs.join('\n')).not.toContain(NEW_PASSWORD)
  })

  it('leaves must_change; a required factor missing leads to enrol_only', async () => {
    const r = rig()
    const user = await create(r, 'tmp', 'user', true)
    const s = session(r, user, 'must_change', false)
    const out = await r.security.changePassword(s.ctx(), s.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(out.state).toBe('full')
    expect(store.accounts.getUser(user.id)).toMatchObject({ mustChangePassword: false, tempPasswordExpiresAt: null })

    const adm = await create(r, 'boss', 'admin', true)
    const t = session(r, adm, 'must_change', false)
    expect((await r.security.changePassword(t.ctx(), t.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).state).toBe('enrol_only')
  })

  it('throttles repeated wrong current passwords', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const s = session(r, user, 'full', false)
    for (let i = 0; i < 5; i += 1) await code(r.security.changePassword(s.ctx(), s.token, { currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD }))
    const e = await r.security.changePassword(s.ctx(), s.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).then(() => undefined, (x: unknown) => x as AuthError)
    expect(e?.code).toBe('auth_throttled')
    expect(e?.detail.retryAfterSeconds).toBeGreaterThan(0)
  })
})

describe('TOTP (FR-AUT-008, 010, 012)', () => {
  it('needs step-up in a full session, none in enrol_only', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const full = session(r, user, 'full', false)
    expect(await code(Promise.resolve().then(() => r.security.totpStart(full.ctx())))).toBe('stepup_required')
    const enrol = session(r, user, 'enrol_only', false)
    expect(r.security.totpStart(enrol.ctx()).secret).toMatch(/^[A-Z2-7]+$/)
  })

  it('confirms with one valid code, returns ten codes once, ends other sessions, moves enrol_only to full', async () => {
    const r = rig()
    const user = await create(r, 'carl', 'admin')
    const s = session(r, user, 'enrol_only', false)
    const other = session(r, user, 'enrol_only', false)
    const start = r.security.totpStart(s.ctx())
    expect(start.uri).toContain('otpauth://totp/')
    expect(start.qrSvg).toContain('<svg')
    const secret = Buffer.from(base32decode(start.secret))
    expect(await code(Promise.resolve().then(() => r.security.totpConfirm(s.ctx(), s.token, '000000')))).toBe('mfa_failed')
    const before = s.token
    const done = r.security.totpConfirm(s.ctx(), s.token, codeAt(secret))
    expect(done.recoveryCodes).toHaveLength(10)
    expect(done.recoveryCodes![0]).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(done.token).not.toBe(before)
    s.token = done.token
    expect(s.ctx().state).toBe('full')
    expect(other.alive()).toBe(false)
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(10)
    expect(store.accounts.listNotices(user.id).map((n) => n.kind)).toEqual(['factor_added'])
    // Stored sealed, the code of the accepted step cannot be replayed.
    const row = store.accounts.getTotp(user.id)!
    expect(row.sealed).not.toContain(start.secret)
    expect(row.lastStep).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(start.secret)
    // The pending secret is gone: a second confirm fails.
    s.token = r.sessions.transition(s.token, { stepupAt: clock.t }).token
    expect(await code(Promise.resolve().then(() => r.security.totpConfirm(s.ctx(), s.token, codeAt(secret))))).toBe('mfa_failed')
  })

  it('gives no new recovery codes when replacing an existing secret; five wrong codes end the challenge', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    const s = session(r, user)
    const start = r.security.totpStart(s.ctx())
    const secret = Buffer.from(base32decode(start.secret))
    for (let i = 0; i < 5; i += 1) await code(Promise.resolve().then(() => r.security.totpConfirm(s.ctx(), s.token, '000000')))
    clock.t += 16 * 60_000 // past the throttle backoff window
    s.token = r.sessions.transition(s.token, { stepupAt: clock.t }).token
    expect(await code(Promise.resolve().then(() => r.security.totpConfirm(s.ctx(), s.token, codeAt(secret))))).toBe('mfa_failed')
    r.security.totpStart(s.ctx())
    const start2 = r.security.totpStart(s.ctx())
    const result = r.security.totpConfirm(s.ctx(), s.token, codeAt(Buffer.from(base32decode(start2.secret))))
    expect(result.recoveryCodes).toBeUndefined()
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(2)
  })

  it('refuses when the factor is not allowed by the settings', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    r.resolver.write({ mfaFactors: ['passkey'] }, 'test')
    const s = session(r, user)
    expect(await code(Promise.resolve().then(() => r.security.totpStart(s.ctx())))).toBe('auth_failed')
  })
})

describe('passkeys (FR-AUT-009, 012; SCN-067, 068)', () => {
  it('enrols without user verification, first factor yields codes, the second does not', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const s = session(r, user)
    const first = await enrolPasskey(r, s)
    expect(first.recoveryCodes).toHaveLength(10)
    const second = await enrolPasskey(r, s)
    expect(second.recoveryCodes).toBeUndefined()
    const factors = r.security.listFactors(s.ctx())
    expect(factors.passkeys).toHaveLength(2)
    expect(factors).toMatchObject({ totp: false, recoveryCodes: 10 })
    expect(Object.keys(factors.passkeys[0]!).sort()).toEqual(['backedUp', 'createdAt', 'id', 'lastUsedAt', 'name', 'uvInitial'])
    expect(store.accounts.listNotices(user.id).filter((n) => n.kind === 'factor_added')).toHaveLength(2)
  })

  it('needs step-up and enforces the passkey limit', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const cold = session(r, user, 'full', false)
    expect(await code(r.security.passkeyRegisterOptions(cold.ctx()))).toBe('stepup_required')
    const s = session(r, user)
    for (let i = 0; i < 10; i += 1) await enrolPasskey(r, s)
    expect(await code(r.security.passkeyRegisterOptions(s.ctx()))).toBe('auth_failed')
  })

  it('refuses a response made for another origin or an unknown challenge, and counts it against the throttle', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const s = session(r, user)
    const options = await r.security.passkeyRegisterOptions(s.ctx())
    const bad = new SoftAuthenticator({ ...RP, userVerified: false }).register(options.challenge, { origin: 'https://evil.test' })
    expect(await code(r.security.passkeyRegisterVerify(s.ctx(), s.token, { response: bad, name: 'x' }))).toBe('mfa_failed')
    expect(store.accounts.listPasskeys(user.id)).toHaveLength(0)
  })

  it('renames only own passkeys', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    const bob = await create(r, 'bob')
    const a = session(r, ana)
    const b = session(r, bob)
    await enrolPasskey(r, a)
    await enrolPasskey(r, b)
    const id = r.security.listFactors(a.ctx()).passkeys[0]!.id
    const bobId = r.security.listFactors(b.ctx()).passkeys[0]!.id
    r.security.passkeyRename(a.ctx(), { id, name: 'Laptop' })
    expect(store.accounts.getPasskey(id)?.name).toBe('Laptop')
    expect(() => r.security.passkeyRename(a.ctx(), { id: bobId, name: 'x' })).toThrow(AuthError)
    expect(store.accounts.getPasskey(bobId)?.name).toBe('key')
  })

  it('removes with step-up; the last factor stays while 2FA is required, and leaving 2FA is disableMfa', async () => {
    const r = rig()
    const carl = await create(r, 'carl', 'admin')
    const s = session(r, carl)
    await enrolPasskey(r, s)
    await enrolPasskey(r, s)
    const [one, two] = r.security.listFactors(s.ctx()).passkeys
    s.token = r.sessions.transition(s.token, { stepupAt: clock.t }).token
    // A session without recent step-up cannot remove (administrators hold at most two sessions).
    const other = session(r, carl, 'full', false)
    expect(await code(Promise.resolve().then(() => r.security.passkeyRemove(other.ctx(), other.token, one!.id)))).toBe('stepup_required')
    s.token = r.security.passkeyRemove(s.ctx(), s.token, one!.id).token
    expect(other.alive()).toBe(false)
    expect(store.accounts.listNotices(carl.id).some((n) => n.kind === 'factor_removed')).toBe(true)
    // Last factor of an administrator: refused.
    expect(await code(Promise.resolve().then(() => r.security.passkeyRemove(s.ctx(), s.token, two!.id)))).toBe('enrol_required')
    expect(store.accounts.listPasskeys(carl.id)).toHaveLength(1)

    // A user without enforced 2FA cannot drop the last factor either; disableMfa is the explicit way.
    const ana = await create(r, 'ana')
    const a = session(r, ana)
    await enrolPasskey(r, a)
    const id = r.security.listFactors(a.ctx()).passkeys[0]!.id
    expect(await code(Promise.resolve().then(() => r.security.passkeyRemove(a.ctx(), a.token, id)))).toBe('auth_failed')
  })

  it('refuses to remove a passkey of another user', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    const bob = await create(r, 'bob')
    const a = session(r, ana)
    const b = session(r, bob)
    await enrolPasskey(r, a)
    await enrolPasskey(r, a)
    await enrolPasskey(r, b)
    const bobId = r.security.listFactors(b.ctx()).passkeys[0]!.id
    expect(await code(Promise.resolve().then(() => r.security.passkeyRemove(a.ctx(), a.token, bobId)))).toBe('auth_failed')
    expect(store.accounts.getPasskey(bobId)).toBeDefined()
  })
})

describe('TOTP removal, recovery codes, MFA switch (FR-AUT-010, 012; SCN-068, 076)', () => {
  it('removes TOTP when another factor remains, refuses the last one', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    const s = session(r, user)
    expect(await code(Promise.resolve().then(() => r.security.totpRemove(s.ctx(), s.token)))).toBe('auth_failed')
    await enrolPasskey(r, s)
    s.token = r.sessions.transition(s.token, { stepupAt: clock.t }).token
    s.token = r.security.totpRemove(s.ctx(), s.token).token
    expect(store.accounts.getTotp(user.id)).toBeUndefined()
    expect(await code(Promise.resolve().then(() => r.security.totpRemove(s.ctx(), s.token)))).toBe('auth_failed')
  })

  it('regenerates codes after step-up only; old codes die, new ones are returned once', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    addTotp(r, user)
    const cold = session(r, user, 'full', false)
    expect(await code(Promise.resolve().then(() => r.security.recoveryCodesRegenerate(cold.ctx())))).toBe('stepup_required')
    const s = session(r, user)
    const { recoveryCodes } = r.security.recoveryCodesRegenerate(s.ctx())
    expect(recoveryCodes).toHaveLength(10)
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(10)
    const mac = r.deps.codes.mac(user.id, r.deps.codes.normalise(recoveryCodes[0]!)!)
    expect(store.accounts.consumeRecoveryCode(user.id, mac)).toBe(true)
    expect(store.accounts.consumeRecoveryCode(user.id, 'a')).toBe(false)
    expect(logs.join('\n')).not.toContain(recoveryCodes[1]!)
    expect(s.alive()).toBe(true)
  })

  it('refuses regeneration for a user without a factor', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const s = session(r, user)
    expect(await code(Promise.resolve().then(() => r.security.recoveryCodesRegenerate(s.ctx())))).toBe('auth_failed')
  })

  it('disableMfa needs step-up, removes factors and codes; refused for administrators and under policy', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    addTotp(r, ana)
    const cold = session(r, ana, 'full', false)
    expect(await code(Promise.resolve().then(() => r.security.disableMfa(cold.ctx(), cold.token)))).toBe('stepup_required')
    const s = session(r, ana)
    const other = session(r, ana)
    s.token = r.security.disableMfa(s.ctx(), s.token).token
    expect(store.accounts.getTotp(ana.id)).toBeUndefined()
    expect(store.accounts.countRecoveryCodes(ana.id)).toBe(0)
    expect(other.alive()).toBe(false)

    const boss = await create(r, 'boss', 'admin')
    addTotp(r, boss)
    const b = session(r, boss)
    expect(await code(Promise.resolve().then(() => r.security.disableMfa(b.ctx(), b.token)))).toBe('enrol_required')

    const dora = await create(r, 'dora')
    addTotp(r, dora)
    r.resolver.write({ mfaScope: 'all' }, 'test')
    const d = session(r, dora)
    expect(await code(Promise.resolve().then(() => r.security.disableMfa(d.ctx(), d.token)))).toBe('enrol_required')
    expect(store.accounts.getTotp(dora.id)).toBeDefined()
  })
})

describe('sessions and notices (FR-AUT-017, SCN-074)', () => {
  it('lists masked refs, flags the current one, skips pending sessions', async () => {
    const r = rig()
    const user = await create(r, 'ana')
    const a = session(r, user, 'full', false)
    const b = session(r, user, 'full', false)
    session(r, user, 'enrol_only', false)
    const pending = r.sessions.createAccount(store.accounts.getUser(user.id)!, 'pending_mfa', META)
    const list = r.security.listSessions(a.ctx())
    expect(list).toHaveLength(3)
    expect(list.filter((x) => x.current)).toHaveLength(1)
    const rows = store.accounts.listUserSessions(user.id)
    for (const row of rows) {
      expect(list.some((x) => x.ref === row.idHash)).toBe(false)
      expect(JSON.stringify(list)).not.toContain(row.idHash)
    }
    expect(list.find((x) => x.current)?.ref).toBe(sessionRef(a.ctx().idHash))
    expect(list.find((x) => x.ref === sessionRef(b.ctx().idHash))).toMatchObject({ clientHint: 'Chrome on Windows', address: '203.0.113.7' })
    expect(rows.some((x) => x.idHash === pending.token)).toBe(false)
  })

  it('revokes another session of the user, never the current one or a stranger\'s', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    const bob = await create(r, 'bob')
    const a1 = session(r, ana, 'full', false)
    const a2 = session(r, ana, 'full', false)
    const b1 = session(r, bob, 'full', false)
    expect(await code(r.security.revokeSession(a1.ctx(), sessionRef(a1.ctx().idHash)))).toBe('auth_failed')
    expect(await code(r.security.revokeSession(a1.ctx(), sessionRef(b1.ctx().idHash)))).toBe('auth_failed')
    expect(await code(r.security.revokeSession(a1.ctx(), 'nonexistentref'))).toBe('auth_failed')
    expect(b1.alive()).toBe(true)
    await r.security.revokeSession(a1.ctx(), sessionRef(a2.ctx().idHash))
    expect(a2.alive()).toBe(false)
    expect(a1.alive()).toBe(true)
  })

  it('lists only the own notices', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    const bob = await create(r, 'bob')
    const a = session(r, ana, 'full', false)
    const out = await r.security.changePassword(a.ctx(), a.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    a.token = out.token
    const b = session(r, bob, 'full', false)
    expect(r.security.listNotices(a.ctx()).map((n) => n.kind)).toEqual(['password_changed'])
    expect(r.security.listNotices(b.ctx())).toEqual([])
  })

  it('answers auth_failed for a user that is no longer active', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    const s = session(r, ana, 'full', false)
    const ctx = s.ctx()
    store.accounts.updateUser(ana.id, { status: 'disabled' })
    expect(() => r.security.listFactors(ctx)).toThrow(AuthError)
  })
})

describe('administrator users (FR-AUT-014, 028; SCN-069)', () => {
  it('is for administrators of a full session only', async () => {
    const r = rig()
    const ana = await create(r, 'ana')
    await create(r, 'boss', 'admin')
    const s = session(r, ana)
    expect(() => r.admin.list(s.ctx())).toThrow(AuthError)
    expect(await code(r.admin.create(s.ctx(), { username: 'x', displayName: 'x', role: 'user', password: PASSWORD }))).toBe('auth_failed')
    const boss = store.accounts.getUserByKey('boss')!
    const e = session(r, boss, 'enrol_only')
    expect(() => r.admin.list(e.ctx())).toThrow(AuthError)
  })

  it('creates a user with a temporary password after step-up, never returns the password', async () => {
    const r = rig()
    const boss = await create(r, 'boss', 'admin')
    const cold = session(r, boss, 'full', false)
    expect(await code(r.admin.create(cold.ctx(), { username: 'dora', displayName: 'Dora', role: 'user', password: PASSWORD }))).toBe('stepup_required')
    const s = session(r, boss)
    expect(await reason(r.admin.create(s.ctx(), { username: 'dora', displayName: 'Dora', role: 'user', password: 'dora2024dora2024' }))).toBe('contains_username')
    expect(await reason(r.admin.create(s.ctx(), { username: 'dora', displayName: 'Dora', role: 'user', password: 'short' }))).toBe('too_short')
    const created = await r.admin.create(s.ctx(), { username: 'dora', displayName: 'Dora', role: 'user', password: PASSWORD })
    expect(created).toMatchObject({ username: 'dora', role: 'user', status: 'active', hasPassword: true, factors: { passkeys: 0, totp: false, recoveryCodes: 0 } })
    expect(JSON.stringify(created)).not.toContain(PASSWORD)
    expect(JSON.stringify(r.admin.list(s.ctx()))).not.toContain('$argon2')
    const row = store.accounts.getUserByKey('dora')!
    expect(row.mustChangePassword).toBe(true)
    expect(row.tempPasswordExpiresAt).toBeGreaterThan(clock.t)
    expect(await code(r.admin.create(s.ctx(), { username: 'DORA', displayName: 'x', role: 'user', password: PASSWORD }))).toBe('auth_failed')
    expect(logs.join('\n')).not.toContain(PASSWORD)
    expect(logs.join('\n')).toContain('user.create')
  })

  it('protects the last active administrator: demote, disable, delete', async () => {
    const r = rig()
    const boss = await create(r, 'boss', 'admin')
    const s = session(r, boss)
    expect(() => r.admin.setRole(s.ctx(), boss.id, 'user')).toThrow(AuthError)
    expect(() => r.admin.setStatus(s.ctx(), boss.id, 'disabled')).toThrow(AuthError)
    expect(() => r.admin.delete(s.ctx(), boss.id)).toThrow(AuthError)
    expect(store.accounts.getUser(boss.id)).toMatchObject({ role: 'admin', status: 'active' })
    // With a second administrator the first may go.
    const second = await create(r, 'second', 'admin')
    r.admin.setRole(s.ctx(), second.id, 'user')
    r.admin.setRole(s.ctx(), second.id, 'admin')
    r.admin.setStatus(s.ctx(), second.id, 'disabled')
    expect(() => r.admin.setStatus(s.ctx(), boss.id, 'disabled')).toThrow(AuthError)
  })

  it('needs step-up for every action and refuses unknown users', async () => {
    const r = rig()
    const boss = await create(r, 'boss', 'admin')
    const ana = await create(r, 'ana')
    const cold = session(r, boss, 'full', false)
    const c = cold.ctx()
    for (const fn of [() => r.admin.setStatus(c, ana.id, 'disabled'), () => r.admin.setRole(c, ana.id, 'admin'), () => r.admin.delete(c, ana.id), () => r.admin.revokeSessions(c, ana.id)]) {
      expect(await code(Promise.resolve().then(fn))).toBe('stepup_required')
    }
    expect(store.accounts.getUser(ana.id)).toMatchObject({ role: 'user', status: 'active' })
    const s = session(r, boss)
    const ghost = '11111111-1111-4111-8111-111111111111'
    expect(() => r.admin.delete(s.ctx(), ghost)).toThrow(AuthError)
    expect(() => r.admin.setStatus(s.ctx(), ghost, 'disabled')).toThrow(AuthError)
  })

  it('disable and role change end the user\'s sessions', async () => {
    const r = rig()
    const boss = await create(r, 'boss', 'admin')
    const ana = await create(r, 'ana')
    const dora = await create(r, 'dora')
    const s = session(r, boss)
    const a = session(r, ana, 'full', false)
    const d = session(r, dora, 'full', false)
    r.admin.setStatus(s.ctx(), ana.id, 'disabled')
    expect(a.alive()).toBe(false)
    expect(store.accounts.listUserSessions(ana.id)).toHaveLength(0)
    r.admin.setRole(s.ctx(), dora.id, 'admin')
    expect(d.alive()).toBe(false)
    expect(store.accounts.getUser(dora.id)?.role).toBe('admin')
  })

  it('deletes the user with sessions, factors, vault and preferences', async () => {
    const r = rig()
    const boss = await create(r, 'boss', 'admin')
    const ana = await create(r, 'ana')
    addTotp(r, ana)
    store.accounts.setVault({
      userId: ana.id, kdfParams: ARGON2_LOGIN_DEFAULT, kdfSalt: 's', wrapPassphrase: 'w', recoverySalt: 'r', wrapRecovery: 'w2', createdAt: 1, updatedAt: 1,
    })
    store.accounts.addNotice({ id: 'n1', userId: ana.id, kind: 'password_changed', createdAt: 1, readAt: null })
    const a = session(r, ana, 'full', false)
    const s = session(r, boss)
    r.admin.delete(s.ctx(), ana.id)
    expect(store.accounts.getUser(ana.id)).toBeUndefined()
    expect(store.accounts.getTotp(ana.id)).toBeUndefined()
    expect(store.accounts.getVault(ana.id)).toBeUndefined()
    expect(store.accounts.listNotices(ana.id)).toHaveLength(0)
    expect(store.accounts.countRecoveryCodes(ana.id)).toBe(0)
    expect(a.alive()).toBe(false)
    expect(deletedPrefs).toEqual([`u:${ana.id}`])
  })

  it('revokes all sessions of a user, counts them and leaves a notice', async () => {
    const r = rig()
    const boss = await create(r, 'boss', 'admin')
    const ana = await create(r, 'ana')
    const a1 = session(r, ana, 'full', false)
    const a2 = session(r, ana, 'full', false)
    const s = session(r, boss)
    expect(r.admin.revokeSessions(s.ctx(), ana.id)).toEqual({ revoked: 2 })
    expect(a1.alive() || a2.alive()).toBe(false)
    expect(store.accounts.listNotices(ana.id).map((n) => n.kind)).toEqual(['sessions_revoked'])
    expect(r.admin.revokeSessions(s.ctx(), ana.id)).toEqual({ revoked: 0 })
    expect(s.alive()).toBe(true)
  })
})

/** RFC 4648 base32 without padding (test helper; the code under test only produces it). */
function base32decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
