/** Package C (`signin.ts`, FR-AUT-006, 009, 011, 012, 027): account sign-in, second factor, passkey sign-in, sign-out.
 *
 * Every security decision of the sign-in functions lives here; `auth.functions.ts` only reads cookies and writes
 * them back. Failures are closed: one `AuthError` per class (`auth_failed`, `mfa_failed`, `mfa_expired`,
 * `auth_throttled`), no detail in the error (SEC-TGT-153). Secrets never reach the audit line.
 */
import { createHash, randomBytes } from 'node:crypto'
import { audit } from '../audit'
import { createNoticeDetector, type NoticeDetector } from './notices'
import {
  AAD,
  CHALLENGE_MAX_TRIES,
  AuthError,
  PENDING_MFA_TTL_MS,
  PRE_AUTH_TTL_MS,
  type AccountContext,
  type AccountSessions,
  type AccountStore,
  type AuthSettingsResolver,
  type ChallengeStore,
  type MfaMethod,
  type PasswordService,
  type PublicKeyCredentialRequestOptionsJSON,
  type RecoveryCodeService,
  type ResolvedAuthSettings,
  type SecretKeyRing,
  type SessionState,
  type SignInResult,
  type SignInService,
  type Throttle,
  type ThrottleKey,
  type TotpService,
  type User,
  type UserService,
  type WebAuthnService,
} from './types'

/** What the sign-in, step-up and (through `getSignInServices`) other packages share. */
export type SignInDeps = {
  store: AccountStore
  sessions: AccountSessions & { destroy(token: string | undefined): Promise<void> }
  users: UserService
  settings: AuthSettingsResolver
  throttle: Throttle
  password: PasswordService
  totp: TotpService
  codes: RecoveryCodeService
  ring: SecretKeyRing
  challenges: ChallengeStore
  webauthn: WebAuthnService
  /** Notice detector; the service makes its own from the store and the settings when absent. */
  notices?: NoticeDetector
  /** Maintenance mode (ST-218): true when this user may not sign in now (a user while maintenance is active). Absent = never. */
  maintenanceBlocks?: (user: User) => boolean
  now?: () => number
}

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Browser and OS family only, never the raw user agent (FR-AUT-017, `client_hint`). */
export function clientHintOf(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : ''
  return (os ? `${browser} on ${os}` : browser).slice(0, 64)
}

export const retryAfterSeconds = (delayMs: number) => Math.max(1, Math.ceil(delayMs / 1000))

/** True when the user holds any second factor (a passkey or a TOTP secret). */
export function hasFactor(store: AccountStore, userId: string): boolean {
  return store.listPasskeys(userId).length > 0 || store.getTotp(userId) !== undefined
}

/**
 * State of a session after the password check (FR-AUT-006, section 5.5): `pending_mfa` when the user holds a factor;
 * else `must_change` (temporary password); else `enrol_only` when 2FA is required, no factor exists and the grace
 * period has ended; else `full`. Also used after `account.changePassword` (without the factor branch) by package D.
 */
export function stateAfterPassword(deps: Pick<SignInDeps, 'store' | 'users'>, user: User, now: number): SessionState {
  if (hasFactor(deps.store, user.id)) return 'pending_mfa'
  if (user.mustChangePassword) return 'must_change'
  const req = deps.users.mfaRequirement(user, now)
  return req.required && req.graceEnded ? 'enrol_only' : 'full'
}

/** Next state after a second factor passed: `must_change` for a temporary password, else `full`. */
export const stateAfterFactor = (user: User): SessionState => (user.mustChangePassword ? 'must_change' : 'full')

/** Verifies a TOTP code for a user: opens the sealed secret, checks the window and swaps `last_step` (replay block). */
export function verifyTotpFactor(deps: SignInDeps, user: User, code: string, settings: Pick<ResolvedAuthSettings, 'totpWindow'>, now: number): boolean {
  const record = deps.store.getTotp(user.id)
  if (!record) return false
  const secret = deps.ring.open('totp', AAD.totp(user.id), record.sealed)
  if (!secret) {
    // SEC-SAU-067: an unreadable secret counts as no TOTP for this sign-in.
    audit('secret.unreadable', { subject: user.id, kind: 'totp' })
    return false
  }
  try {
    const result = deps.totp.verify(secret, code, record.lastStep, settings.totpWindow, now)
    if (!result.ok) return false
    if (!deps.store.advanceTotpStep(user.id, result.step)) return false
    if (deps.ring.isStale(record.sealed)) {
      // Re-seal under the current key on the next write (FR-AUT-023).
      deps.store.setTotp({ ...record, sealed: deps.ring.seal('totp', AAD.totp(user.id), secret), lastStep: result.step })
    }
    return true
  } finally {
    secret.fill(0)
  }
}

export function createSignInService(deps: SignInDeps): SignInService {
  const now = () => (deps.now ?? Date.now)()
  const { store, sessions, throttle, challenges } = deps

  const acctKey = (user: Pick<User, 'usernameKey'>): ThrottleKey => `acct:${user.usernameKey}`

  /** Refuses before any hash when a key is in backoff (FR-AUT-007). Unknown names are throttled the same way. */
  function checkThrottle(keys: ThrottleKey[], reason: 'signin' | 'mfa'): void {
    const delay = Math.max(...keys.map((k) => throttle.delayMs(k)))
    if (delay > 0) {
      audit('auth.signin', { outcome: 'throttled', keyKind: keys[0]!.split(':')[0] as 'acct' | 'ip', reason })
      throw new AuthError('auth_throttled', { retryAfterSeconds: retryAfterSeconds(delay) })
    }
  }

  function notifyEvicted(user: User, evicted: string[]) {
    for (const id of evicted) {
      store.addNotice({ id: randomBytes(16).toString('base64url'), userId: user.id, kind: 'session_evicted', createdAt: now(), readAt: null })
      audit('session.evicted', { subject: user.id, reason: 'limit', ref: id.slice(0, 8) })
    }
  }

  const notices =
    deps.notices ??
    createNoticeDetector({
      store,
      now,
      settings: () => {
        const s = deps.settings.resolve()
        return { noticeBurstFailures: s.noticeBurstFailures, noticeBurstMinutes: s.noticeBurstMinutes, noticeLocationDays: s.noticeLocationDays }
      },
    })
  const markSignedIn = (user: User, address?: string) => {
    store.updateUser(user.id, { lastSignInAt: now() })
    notices.completedSignIn(user, address)
  }

  /** Called after the credential proved the user: a refused sign-in leaves no session and does not count as a failed attempt. */
  const refuseInMaintenance = (user: User, method: 'password' | 'passkey') => {
    if (!deps.maintenanceBlocks?.(user)) return
    audit('auth.signin', { outcome: 'refused', method, reason: 'maintenance', subject: user.id })
    throw new AuthError('maintenance')
  }

  return {
    async passwordSignIn(input, meta) {
      const settings = deps.settings.resolve()
      const usernameKey = deps.users.usernameKey(input.username)
      const keys: ThrottleKey[] = [`acct:${usernameKey}`, `ip:${meta.address}`]
      checkThrottle(keys, 'signin')

      const at = now()
      const found = store.getUserByKey(usernameKey)
      const record = found && found.status === 'active' ? store.getPassword(found.id) : undefined
      const allowed = settings.primaryCredentials.includes('password')
      // One Argon2id computation in every case: the same cost for unknown, disabled, password-less and wrong (FR-AUT-006).
      const user = record && allowed ? found : undefined
      const verified = user && record ? await deps.password.verify(record.phc, input.password) : await deps.password.dummyVerify(input.password)
      const expired = !!user && user.tempPasswordExpiresAt !== null && at >= user.tempPasswordExpiresAt
      if (!user || !record || !verified || expired) {
        for (const key of keys) throttle.fail(key)
        notices.failedAttempt({ ...(found ? { userId: found.id, username: found.username } : {}) }, meta.address)
        audit('auth.signin', { outcome: 'failed', method: 'password', ...(found ? { subject: found.id } : {}) })
        throw new AuthError('auth_failed')
      }

      if (deps.password.needsRehash(record.phc, settings.argon2Login)) {
        // Raise the stored hash to the current parameters; a failure here never blocks the sign-in.
        try {
          store.setPassword({ userId: user.id, phc: await deps.password.hash(input.password, settings.argon2Login), changedAt: record.changedAt })
        } catch {
          audit('auth.signin', { outcome: 'ok', reason: 'rehash_failed', subject: user.id })
        }
      }

      refuseInMaintenance(user, 'password')
      const state = stateAfterPassword(deps, user, at)
      // The account key resets only when no second factor is left to guess (else 5 code guesses per password would be free).
      if (state !== 'pending_mfa') throttle.reset(acctKey(user))
      const session = sessions.createAccount(user, state, { clientHint: meta.clientHint, address: meta.address })
      notifyEvicted(user, session.evicted)
      if (state === 'full') markSignedIn(user, meta.address)
      audit('auth.signin', { outcome: 'ok', method: 'password', subject: user.id, state })
      return { token: session.token, csrf: session.csrf, state }
    },

    async mfaOptions(ctx: AccountContext, method: MfaMethod) {
      const user = pendingUser(ctx)
      const settings = deps.settings.resolve()
      if (method === 'passkey') {
        const passkeys = store.listPasskeys(user.id)
        if (!settings.mfaFactors.includes('passkey') || passkeys.length === 0) throw new AuthError('mfa_failed')
        return (await deps.webauthn.authenticationOptions(ctx.idHash, 'mfa', passkeys)) as PublicKeyCredentialRequestOptionsJSON
      }
      if (method === 'totp') {
        if (!settings.mfaFactors.includes('totp') || !store.getTotp(user.id)) throw new AuthError('mfa_failed')
      } else if (store.countRecoveryCodes(user.id) === 0) {
        throw new AuthError('mfa_failed')
      }
      // A code step holds a challenge that counts its tries (max 5, ST-059).
      challenges.create(ctx.idHash, 'mfa', { userId: user.id })
      return { method }
    },

    async mfaVerify(ctx, token, input): Promise<SignInResult> {
      const user = pendingUser(ctx)
      const at = now()
      const row = store.getAccountSession(ctx.idHash)
      if (!row || at - row.createdAt >= PENDING_MFA_TTL_MS) {
        challenges.dropOwner(ctx.idHash)
        await sessions.endSession(ctx.idHash, 'expired')
        throw new AuthError('mfa_expired')
      }
      checkThrottle([acctKey(user)], 'mfa')
      const settings = deps.settings.resolve()

      const failed = (reason: string): never => {
        // TOTP, recovery-code and passkey failures count on the account key (FR-AUT-007).
        throttle.fail(acctKey(user))
        notices.failedAttempt({ userId: user.id, username: user.username })
        audit('auth.mfa', { outcome: 'failed', method: input.method, subject: user.id, reason })
        throw new AuthError('mfa_failed')
      }

      let ok = false
      if (input.method === 'passkey') {
        const credential = store.getPasskey(input.response.id)
        if (!credential || credential.userId !== user.id || !settings.mfaFactors.includes('passkey')) {
          challenges.dropOwner(ctx.idHash) // burn the held challenge, it is single use
          return failed('unknown_credential')
        }
        try {
          // Second factor after a password: user verification optional (SEC-TGT-014).
          const result = await deps.webauthn.verifyAuthentication(ctx.idHash, 'mfa', input.response, credential, { requireUserVerification: false })
          store.updatePasskey(credential.id, { counter: result.newCounter, lastUsedAt: at, backedUp: result.backedUp })
          ok = true
        } catch (error) {
          if (!(error instanceof AuthError)) throw error
          throttle.fail(acctKey(user))
          notices.failedAttempt({ userId: user.id, username: user.username })
          throw error // already audited by the WebAuthn service
        }
      } else {
        const held = challenges.countTry(ctx.idHash, 'mfa')
        if (!held) {
          challenges.dropOwner(ctx.idHash)
          await sessions.endSession(ctx.idHash, 'expired')
          audit('auth.mfa', { outcome: 'failed', method: input.method, subject: user.id, reason: 'no_challenge' })
          throw new AuthError('mfa_expired')
        }
        if (input.method === 'totp') {
          ok = settings.mfaFactors.includes('totp') && verifyTotpFactor(deps, user, input.code, settings, at)
        } else {
          const normalised = deps.codes.normalise(input.code)
          // Codes are a second factor after a password only (Q7); this session came from a password.
          ok = normalised !== undefined && store.consumeRecoveryCode(user.id, deps.codes.mac(user.id, normalised))
        }
        if (!ok) {
          if (held.tries >= CHALLENGE_MAX_TRIES) {
            // Fifth wrong try: the challenge is gone, sign-in starts over.
            exhausted(user, input.method)
            challenges.dropOwner(ctx.idHash)
            await sessions.endSession(ctx.idHash, 'expired')
            throw new AuthError('mfa_expired')
          }
          return failed('wrong_code')
        }
        challenges.dropOwner(ctx.idHash)
      }

      if (!ok) return failed('rejected')
      const state = stateAfterFactor(user)
      throttle.reset(acctKey(user))
      const next = sessions.transition(token, { state, mfaAt: at, stepupAt: at })
      notifyEvicted(user, next.evicted ?? [])
      challenges.dropOwner(ctx.idHash)
      if (state === 'full') markSignedIn(user, store.getAccountSession(ctx.idHash)?.address)
      audit('auth.mfa', {
        outcome: 'ok',
        method: input.method,
        subject: user.id,
        ...(input.method === 'recovery' ? { count: store.countRecoveryCodes(user.id) } : {}),
      })
      return { token: next.token, csrf: ctx.csrf, state }
    },

    async passkeyBegin(meta) {
      const settings = deps.settings.resolve()
      checkThrottle([`ip:${meta.address}`], 'signin')
      if (!settings.primaryCredentials.includes('passkey') || !settings.mfaFactors.includes('passkey')) throw new AuthError('auth_failed')
      const preAuthCookie = randomBytes(32).toString('base64url')
      const options = await deps.webauthn.authenticationOptions(sha256Hex(preAuthCookie), 'signin_passkey')
      return { preAuthCookie, options }
    },

    async passkeyFinish(preAuthCookie, response, meta): Promise<SignInResult> {
      const owner = sha256Hex(preAuthCookie)
      const at = now()
      const failedOut = (subject?: string): never => {
        throttle.fail(`ip:${meta.address}`)
        notices.failedAttempt({ ...(subject ? { userId: subject } : {}) }, meta.address)
        audit('auth.signin', { outcome: 'failed', method: 'passkey', ...(subject ? { subject } : {}) })
        throw new AuthError('mfa_failed')
      }
      const settings = deps.settings.resolve()
      checkThrottle([`ip:${meta.address}`], 'signin')
      const credential = store.getPasskey(response.id)
      const user = credential ? store.getUser(credential.userId) : undefined
      const userHandle = response.response.userHandle
      if (!credential || !user || user.status !== 'active' || !settings.primaryCredentials.includes('passkey') || !settings.mfaFactors.includes('passkey') || userHandle !== user.webauthnUserId) {
        challenges.dropOwner(owner) // single use even when the lookup fails
        return failedOut(user?.id)
      }
      checkThrottle([acctKey(user)], 'signin')
      let result
      try {
        // Passwordless: user verification required (SEC-TGT-014).
        result = await deps.webauthn.verifyAuthentication(owner, 'signin_passkey', response, credential, { requireUserVerification: true })
      } catch (error) {
        if (error instanceof AuthError) {
          throttle.fail(`ip:${meta.address}`)
          notices.failedAttempt({ userId: user.id, username: user.username }, meta.address)
          audit('auth.signin', { outcome: 'failed', method: 'passkey', subject: user.id })
        }
        throw error
      }
      if (!result.userVerified) return failedOut(user.id)
      store.updatePasskey(credential.id, { counter: result.newCounter, lastUsedAt: at, backedUp: result.backedUp })
      throttle.reset(acctKey(user))
      refuseInMaintenance(user, 'passkey')
      const state = stateAfterFactor(user)
      const session = sessions.createAccount(user, state, { clientHint: meta.clientHint, address: meta.address })
      notifyEvicted(user, session.evicted)
      const next = sessions.transition(session.token, { mfaAt: at, stepupAt: at })
      if (state === 'full') markSignedIn(user, meta.address)
      audit('auth.signin', { outcome: 'ok', method: 'passkey', subject: user.id, state })
      return { token: next.token, csrf: session.csrf, state }
    },

    async signOut(token) {
      if (!token) return
      const ctx = sessions.resolveAccount(token, { background: true })
      if (ctx) challenges.dropOwner(ctx.idHash)
      await sessions.destroy(token)
      audit('auth.signout', { ...(ctx?.user ? { subject: ctx.user.id } : {}) })
    },
  }

  /** The context must be a `pending_mfa` account session; anything else fails closed. */
  function pendingUser(ctx: AccountContext): User {
    if (ctx.state !== 'pending_mfa' || !ctx.user) throw new AuthError('mfa_failed')
    const user = store.getUser(ctx.user.id)
    if (!user || user.status !== 'active') throw new AuthError('mfa_failed')
    return user
  }

  function exhausted(user: User, method: MfaMethod) {
    throttle.fail(acctKey(user))
    notices.failedAttempt({ userId: user.id, username: user.username })
    audit('auth.mfa', { outcome: 'failed', method, subject: user.id, reason: 'tries_exhausted' })
  }
}

/** The pre-authentication cookie lifetime (seconds) for `auth.functions.ts`. */
export const PRE_AUTH_MAX_AGE_SECONDS = Math.floor(PRE_AUTH_TTL_MS / 1000)
