/** Account security services (SPEC/26 FR-AUT-005, 008, 009, 010, 012, 017; SCN-066 to 068, 074, 076).
 *
 * Own password change, second factors (passkeys, TOTP, recovery codes), session list and notices of the signed-in
 * user. Pure over injected dependencies (tests pass a real SQLite store and a soft authenticator). Step-up is
 * enforced here, not in the HTTP layer: a change of a factor needs a recent factor unless the session is `enrol_only`
 * (the user has nothing to prove with yet). Every factor change raises `security_version`, ends the user's other
 * sessions (ST-075) and regenerates the current token; the caller writes the new cookie.
 *
 * Secrets: the TOTP secret exists in the browser answer of `totpStart` and in the challenge store until confirmed;
 * recovery codes leave only as the return of enrolment or regeneration. Nothing here reaches the audit line.
 */
import { createHash, randomUUID } from 'node:crypto'
import { audit } from '../audit'
import { hasFactor, retryAfterSeconds } from './signin'
import {
  AAD,
  AuthError,
  MAX_PASSKEYS,
  type AccountContext,
  type AccountSessions,
  type AccountStore,
  type AuthSettingsResolver,
  type ChallengeStore,
  type NoticeKind,
  type PasskeyInfo,
  type PasswordService,
  type PublicKeyCredentialCreationOptionsJSON,
  type RecoveryCodeService,
  type RegistrationResponseJSON,
  type SecretKeyRing,
  type SessionInfo,
  type SessionState,
  type StepUp,
  type Throttle,
  type TotpService,
  type User,
  type UserNotice,
  type UserService,
  type WebAuthnService,
} from './types'

export type SecurityDeps = {
  store: AccountStore
  sessions: Pick<AccountSessions, 'transition' | 'endSession'>
  users: Pick<UserService, 'mfaRequirement'>
  settings: Pick<AuthSettingsResolver, 'resolve'>
  throttle: Throttle
  password: Pick<PasswordService, 'normalise' | 'check' | 'hash' | 'verify' | 'dummyVerify'>
  totp: TotpService
  codes: Pick<RecoveryCodeService, 'generate' | 'normalise' | 'mac'>
  ring: Pick<SecretKeyRing, 'seal'>
  challenges: ChallengeStore
  webauthn: Pick<WebAuthnService, 'registrationOptions' | 'verifyRegistration'>
  stepUp: Pick<StepUp, 'requireRecentFactor'>
  siteName: () => string
  /** Closes the in-memory connections of sessions the store dropped. */
  onSessionsEnded?: (idHashes: string[]) => void
  now?: () => number
}

export type FactorsView = { passkeys: PasskeyInfo[]; totp: boolean; recoveryCodes: number }
/** `token` is the regenerated session token: the HTTP layer sets the cookie and never returns it. */
export type SessionChange = { token: string }

/** What the browser may hold of a session: a stable reference that is not the id hash the store keys by. */
export const sessionRef = (idHash: string) => createHash('sha256').update(`session-ref/v1/${idHash}`).digest('base64url').slice(0, 32)

export interface AccountSecurityService {
  changePassword(ctx: AccountContext, token: string, input: { currentPassword: string; newPassword: string }): Promise<SessionChange & { csrf: string; state: SessionState }>
  listFactors(ctx: AccountContext): FactorsView
  passkeyRegisterOptions(ctx: AccountContext): Promise<PublicKeyCredentialCreationOptionsJSON>
  passkeyRegisterVerify(ctx: AccountContext, token: string, input: { response: RegistrationResponseJSON; name: string }): Promise<SessionChange & { recoveryCodes?: string[] }>
  passkeyRename(ctx: AccountContext, input: { id: string; name: string }): void
  passkeyRemove(ctx: AccountContext, token: string, id: string): SessionChange
  totpStart(ctx: AccountContext): { uri: string; secret: string; qrSvg: string }
  totpConfirm(ctx: AccountContext, token: string, code: string): SessionChange & { recoveryCodes?: string[] }
  totpRemove(ctx: AccountContext, token: string): SessionChange
  recoveryCodesRegenerate(ctx: AccountContext): { recoveryCodes: string[] }
  disableMfa(ctx: AccountContext, token: string): SessionChange
  listSessions(ctx: AccountContext): SessionInfo[]
  revokeSession(ctx: AccountContext, ref: string): Promise<void>
  listNotices(ctx: AccountContext): UserNotice[]
}

export function createAccountSecurity(d: SecurityDeps): AccountSecurityService {
  const { store, throttle } = d
  const now = () => (d.now ?? Date.now)()

  /** The active user behind a session in a state that may reach these functions; anything else is `auth_failed`. */
  function userOf(ctx: AccountContext): User {
    if (!ctx.user || ctx.state === 'pending_mfa') throw new AuthError('auth_failed')
    const user = store.getUser(ctx.user.id)
    if (!user || user.status !== 'active') throw new AuthError('auth_failed')
    return user
  }

  /** Step-up for everything that changes a factor; `enrol_only` sessions have no factor to prove with (FR-AUT-012, 013). */
  function sensitive(ctx: AccountContext, purpose: string): void {
    if (ctx.state === 'enrol_only') return
    d.stepUp.requireRecentFactor(ctx, purpose)
  }

  function checkThrottle(user: User): void {
    const delay = throttle.delayMs(`acct:${user.usernameKey}`)
    if (delay > 0) throw new AuthError('auth_throttled', { retryAfterSeconds: retryAfterSeconds(delay) })
  }

  const notice = (userId: string, kind: NoticeKind, at: number) => store.addNotice({ id: randomUUID(), userId, kind, createdAt: at, readAt: null })

  /**
   * ST-075 event on the current session: raise `security_version`, drop every other session, keep this one (same
   * row, new version, regenerated token). `state` moves an `enrol_only` or `must_change` session on.
   */
  function securityEvent(ctx: AccountContext, token: string, user: User, at: number, patch: { state?: SessionState; mfaAt?: number } = {}): { token: string; ended: string[] } {
    let ended: string[] = []
    let next = ''
    store.transaction(() => {
      const securityVersion = user.securityVersion + 1
      store.updateUser(user.id, { securityVersion, updatedAt: at })
      ended = store.deleteUserSessions(user.id, ctx.idHash)
      store.updateAccountSession(ctx.idHash, { securityVersion })
      next = d.sessions.transition(token, patch).token
    })
    d.onSessionsEnded?.(ended)
    return { token: next, ended }
  }

  /** A required second factor now exists: an `enrol_only` session becomes `full`. */
  const afterEnrol = (ctx: AccountContext, at: number) => (ctx.state === 'enrol_only' ? { state: 'full' as const, mfaAt: at } : {})

  function factorCount(user: User): number {
    return store.listPasskeys(user.id).length + (store.getTotp(user.id) ? 1 : 0)
  }

  /** FR-AUT-012: the last factor stays while 2FA is required; leaving 2FA altogether is `disableMfa`. */
  function assertNotLast(user: User, after: number): void {
    if (after > 0) return
    throw new AuthError(d.users.mfaRequirement(user, now()).required ? 'enrol_required' : 'auth_failed')
  }

  /** First factor of a user: ten recovery codes in the same transaction (FR-AUT-010). */
  function issueCodes(user: User, at: number): string[] {
    const plain = d.codes.generate()
    store.replaceRecoveryCodes(user.id, plain.map((c) => d.codes.mac(user.id, d.codes.normalise(c) ?? c)), at)
    return plain
  }

  return {
    async changePassword(ctx, token, input) {
      const user = userOf(ctx)
      checkThrottle(user)
      const record = store.getPassword(user.id)
      const ok = record ? await d.password.verify(record.phc, input.currentPassword) : await d.password.dummyVerify(input.currentPassword)
      if (!ok) {
        throttle.fail(`acct:${user.usernameKey}`)
        audit('account.password', { outcome: 'failed', subject: user.id })
        throw new AuthError('auth_failed')
      }
      const s = d.settings.resolve()
      const checked = await d.password.check(input.newPassword, { username: user.username, minLength: s.passwordMinLength, breachedCheck: s.breachedCheck, failClosed: false })
      if (checked.reason) throw new AuthError('password_rejected', { reason: checked.reason })
      if (d.password.normalise(input.newPassword) === d.password.normalise(input.currentPassword)) throw new AuthError('password_rejected', { reason: 'reused' })
      const phc = await d.password.hash(input.newPassword, s.argon2Login)
      const at = now()
      // The session leaves `must_change`; a user who must enrol 2FA and has no factor goes to `enrol_only`.
      let state: SessionState = ctx.state
      if (ctx.state === 'must_change') {
        const req = d.users.mfaRequirement(user, at)
        state = !hasFactor(store, user.id) && req.required && req.graceEnded ? 'enrol_only' : 'full'
      }
      let result!: { token: string; ended: string[] }
      store.transaction(() => {
        store.setPassword({ userId: user.id, phc, changedAt: at })
        store.updateUser(user.id, { mustChangePassword: false, tempPasswordExpiresAt: null })
        result = securityEvent(ctx, token, user, at, { state })
        notice(user.id, 'password_changed', at)
      })
      throttle.reset(`acct:${user.usernameKey}`)
      audit('account.password', { outcome: 'ok', subject: user.id, sessionsEnded: result.ended.length })
      return { token: result.token, csrf: ctx.csrf, state }
    },

    listFactors(ctx) {
      const user = userOf(ctx)
      const passkeys = store.listPasskeys(user.id).map(({ id, name, backedUp, uvInitial, createdAt, lastUsedAt }) => ({ id, name, backedUp, uvInitial, createdAt, lastUsedAt }))
      return { passkeys, totp: !!store.getTotp(user.id), recoveryCodes: store.countRecoveryCodes(user.id) }
    },

    async passkeyRegisterOptions(ctx) {
      const user = userOf(ctx)
      sensitive(ctx, 'passkey.add')
      const existing = store.listPasskeys(user.id)
      if (!d.settings.resolve().mfaFactors.includes('passkey') || existing.length >= MAX_PASSKEYS) throw new AuthError('auth_failed')
      return d.webauthn.registrationOptions(user, existing, 'enrol_passkey', ctx.idHash)
    },

    async passkeyRegisterVerify(ctx, token, input) {
      const user = userOf(ctx)
      sensitive(ctx, 'passkey.add')
      checkThrottle(user)
      if (!d.settings.resolve().mfaFactors.includes('passkey') || store.listPasskeys(user.id).length >= MAX_PASSKEYS) throw new AuthError('auth_failed')
      let verified
      try {
        // As a second factor a passkey need not verify the user (SEC-TGT-014); step-up and sign-in ask for UV themselves.
        verified = await d.webauthn.verifyRegistration(ctx.idHash, 'enrol_passkey', input.response, { requireUserVerification: false })
      } catch (error) {
        if (error instanceof AuthError) throttle.fail(`acct:${user.usernameKey}`)
        throw error
      }
      const at = now()
      if (store.getPasskey(verified.id)) throw new AuthError('mfa_failed')
      let recoveryCodes: string[] | undefined
      let result!: { token: string }
      store.transaction(() => {
        const first = !hasFactor(store, user.id)
        store.addPasskey({ ...verified, userId: user.id, name: input.name, createdAt: at, lastUsedAt: null })
        if (first) recoveryCodes = issueCodes(user, at)
        result = securityEvent(ctx, token, user, at, afterEnrol(ctx, at))
        notice(user.id, 'factor_added', at)
      })
      audit('account.factor', { action: 'passkey_added', subject: user.id, uv: verified.uvInitial })
      return { token: result.token, ...(recoveryCodes ? { recoveryCodes } : {}) }
    },

    passkeyRename(ctx, input) {
      const user = userOf(ctx)
      const credential = store.getPasskey(input.id)
      if (!credential || credential.userId !== user.id) throw new AuthError('auth_failed')
      store.updatePasskey(credential.id, { name: input.name })
    },

    passkeyRemove(ctx, token, id) {
      const user = userOf(ctx)
      sensitive(ctx, 'passkey.remove')
      const credential = store.getPasskey(id)
      if (!credential || credential.userId !== user.id) throw new AuthError('auth_failed')
      assertNotLast(user, factorCount(user) - 1)
      const at = now()
      let result!: { token: string }
      store.transaction(() => {
        store.deletePasskey(user.id, id)
        result = securityEvent(ctx, token, user, at)
        notice(user.id, 'factor_removed', at)
      })
      audit('account.factor', { action: 'passkey_removed', subject: user.id })
      return { token: result.token }
    },

    totpStart(ctx) {
      const user = userOf(ctx)
      sensitive(ctx, 'totp.add')
      if (!d.settings.resolve().mfaFactors.includes('totp')) throw new AuthError('auth_failed')
      checkThrottle(user)
      const secret = d.totp.newSecret()
      // Held in memory for this session only until the first valid code (FR-AUT-008); five tries.
      d.challenges.create(ctx.idHash, 'enrol_totp', { userId: user.id, challenge: secret.toString('base64url') })
      const uri = d.totp.otpauthUri(secret, d.siteName(), user.username)
      return { uri, secret: d.totp.base32(secret), qrSvg: d.totp.qrSvg(uri) }
    },

    totpConfirm(ctx, token, code) {
      const user = userOf(ctx)
      sensitive(ctx, 'totp.add')
      checkThrottle(user)
      const held = d.challenges.countTry(ctx.idHash, 'enrol_totp')
      if (!held?.challenge || held.userId !== user.id) throw new AuthError('mfa_failed')
      const secret = Buffer.from(held.challenge, 'base64url')
      const checked = d.totp.verify(secret, code, 0, d.settings.resolve().totpWindow, now())
      if (!checked.ok) {
        throttle.fail(`acct:${user.usernameKey}`)
        secret.fill(0)
        throw new AuthError('mfa_failed')
      }
      d.challenges.take(ctx.idHash, 'enrol_totp')
      const at = now()
      let recoveryCodes: string[] | undefined
      let result!: { token: string }
      store.transaction(() => {
        const first = !hasFactor(store, user.id)
        // Re-enrolment replaces the secret; the accepted step is stored so the same code cannot be reused.
        store.setTotp({ userId: user.id, sealed: d.ring.seal('totp', AAD.totp(user.id), secret), lastStep: checked.step, createdAt: at })
        if (first) recoveryCodes = issueCodes(user, at)
        result = securityEvent(ctx, token, user, at, afterEnrol(ctx, at))
        notice(user.id, 'factor_added', at)
      })
      secret.fill(0)
      audit('account.factor', { action: 'totp_set', subject: user.id })
      return { token: result.token, ...(recoveryCodes ? { recoveryCodes } : {}) }
    },

    totpRemove(ctx, token) {
      const user = userOf(ctx)
      sensitive(ctx, 'totp.remove')
      if (!store.getTotp(user.id)) throw new AuthError('auth_failed')
      assertNotLast(user, factorCount(user) - 1)
      const at = now()
      let result!: { token: string }
      store.transaction(() => {
        store.deleteTotp(user.id)
        result = securityEvent(ctx, token, user, at)
        notice(user.id, 'factor_removed', at)
      })
      audit('account.factor', { action: 'totp_removed', subject: user.id })
      return { token: result.token }
    },

    recoveryCodesRegenerate(ctx) {
      const user = userOf(ctx)
      sensitive(ctx, 'recovery.regenerate')
      if (!hasFactor(store, user.id)) throw new AuthError('auth_failed')
      const recoveryCodes = issueCodes(user, now())
      audit('account.factor', { action: 'recovery_regenerated', subject: user.id })
      return { recoveryCodes }
    },

    disableMfa(ctx, token) {
      const user = userOf(ctx)
      sensitive(ctx, 'mfa.disable')
      // Enforced 2FA (administrators always, or by policy) cannot be switched off (FR-AUT-012).
      if (d.users.mfaRequirement(user, now()).required) throw new AuthError('enrol_required')
      const at = now()
      let result!: { token: string }
      store.transaction(() => {
        store.deletePasskeys(user.id)
        store.deleteTotp(user.id)
        store.deleteRecoveryCodes(user.id)
        result = securityEvent(ctx, token, user, at)
        notice(user.id, 'factor_removed', at)
      })
      audit('account.factor', { action: 'mfa_disabled', subject: user.id })
      return { token: result.token }
    },

    listSessions(ctx) {
      const user = userOf(ctx)
      // Password-only sessions are not the user's sessions yet; refs are derived, the id hash never leaves the server.
      return store
        .listUserSessions(user.id)
        .filter((r) => r.state !== 'pending_mfa')
        .map((r) => ({ ref: sessionRef(r.idHash), clientHint: r.clientHint, address: r.address, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.idHash === ctx.idHash }))
    },

    async revokeSession(ctx, ref) {
      const user = userOf(ctx)
      const target = store.listUserSessions(user.id).find((r) => sessionRef(r.idHash) === ref)
      // Own sessions only; the current one signs out through `signOut`.
      if (!target || target.idHash === ctx.idHash) throw new AuthError('auth_failed')
      await d.sessions.endSession(target.idHash, 'revoked')
      audit('account.session.revoked', { subject: user.id, ref: ref.slice(0, 8) })
    },

    listNotices(ctx) {
      return store.listNotices(userOf(ctx).id)
    },
  }
}
