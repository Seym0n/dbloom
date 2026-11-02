/** Package C (`stepup.ts`, FR-AUT-013, SCN-076): the step-up primitive.
 *
 * `requireRecentFactor` passes while `stepup_at` is inside the window (default 5 min, ST-034); the step-up dialog
 * proves a passkey assertion with user verification, a TOTP code, or (only for a user without any factor) the
 * password. A recovery code is never accepted. `verify` regenerates the session token; the client resends the
 * original request deliberately.
 */
import { audit } from '../audit'
import { hasFactor, retryAfterSeconds, verifyTotpFactor, type SignInDeps } from './signin'
import { AuthError, type AccountContext, type StepUp, type StepUpMethod, type User } from './types'

export function createStepUp(deps: SignInDeps): StepUp {
  const now = () => (deps.now ?? Date.now)()
  const { store, throttle, challenges } = deps

  function fullUser(ctx: AccountContext): User {
    if (ctx.state !== 'full' || !ctx.user) throw new AuthError('stepup_required')
    const user = store.getUser(ctx.user.id)
    if (!user || user.status !== 'active') throw new AuthError('stepup_required')
    return user
  }

  /** Which methods this user may use: a user with a factor never steps up with the password. */
  function methodsFor(user: User): StepUpMethod[] {
    const settings = deps.settings.resolve()
    if (!hasFactor(store, user.id)) return ['password']
    const methods: StepUpMethod[] = []
    if (settings.mfaFactors.includes('passkey') && store.listPasskeys(user.id).length > 0) methods.push('passkey')
    if (settings.mfaFactors.includes('totp') && store.getTotp(user.id)) methods.push('totp')
    return methods
  }

  return {
    requireRecentFactor(ctx, purpose) {
      const window = deps.settings.resolve().stepUpWindowMs
      const at = now()
      if (ctx.state === 'full' && ctx.stepupAt !== null && at - ctx.stepupAt >= 0 && at - ctx.stepupAt < window) return
      audit('auth.stepup', { outcome: 'refused', reason: 'stepup_required', purpose, ...(ctx.user ? { subject: ctx.user.id } : {}) })
      throw new AuthError('stepup_required')
    },

    async options(ctx, method) {
      const user = fullUser(ctx)
      if (!methodsFor(user).includes(method)) throw new AuthError('mfa_failed')
      if (method === 'passkey') return deps.webauthn.authenticationOptions(ctx.idHash, 'stepup', store.listPasskeys(user.id))
      challenges.create(ctx.idHash, 'stepup', { userId: user.id })
      return { method }
    },

    async verify(ctx, token, input) {
      const user = fullUser(ctx)
      const at = now()
      const acct = `acct:${user.usernameKey}` as const
      const delay = throttle.delayMs(acct)
      if (delay > 0) throw new AuthError('auth_throttled', { retryAfterSeconds: retryAfterSeconds(delay) })
      if (!methodsFor(user).includes(input.method)) {
        challenges.dropOwner(ctx.idHash)
        throw new AuthError('mfa_failed')
      }
      const settings = deps.settings.resolve()
      const reject = (code: 'mfa_failed' | 'auth_failed'): never => {
        throttle.fail(acct)
        audit('auth.stepup', { outcome: 'failed', method: input.method, subject: user.id })
        throw new AuthError(code)
      }

      if (input.method === 'passkey') {
        const credential = store.getPasskey(input.response.id)
        if (!credential || credential.userId !== user.id) {
          challenges.dropOwner(ctx.idHash)
          return reject('mfa_failed')
        }
        try {
          // Step-up always requires user verification (FR-AUT-009).
          const result = await deps.webauthn.verifyAuthentication(ctx.idHash, 'stepup', input.response, credential, { requireUserVerification: true })
          if (!result.userVerified) return reject('mfa_failed')
          store.updatePasskey(credential.id, { counter: result.newCounter, lastUsedAt: at, backedUp: result.backedUp })
        } catch (error) {
          if (error instanceof AuthError) throttle.fail(acct)
          throw error
        }
      } else {
        const held = challenges.countTry(ctx.idHash, 'stepup')
        if (!held) throw new AuthError('mfa_failed')
        let ok: boolean
        if (input.method === 'totp') {
          ok = verifyTotpFactor(deps, user, input.code, settings, at)
        } else {
          const record = store.getPassword(user.id)
          ok = record ? await deps.password.verify(record.phc, input.password) : await deps.password.dummyVerify(input.password)
        }
        if (!ok) return reject(input.method === 'password' ? 'auth_failed' : 'mfa_failed')
      }

      challenges.dropOwner(ctx.idHash)
      throttle.reset(acct)
      const next = deps.sessions.transition(token, { stepupAt: at })
      audit('auth.stepup', { outcome: 'ok', method: input.method, subject: user.id })
      return { token: next.token, stepUpUntil: at + settings.stepUpWindowMs }
    },
  }
}
