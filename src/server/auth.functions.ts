import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, getRequestHeader, setCookie, setResponseStatus } from '@tanstack/react-start/server'
import { currentClientAddress } from './net/current'
import { SESSION_COOKIE, accountMiddleware, accountStateMiddleware, publicMiddleware } from './middleware'
import { getRuntime } from './runtime'
import { clientHintOf, PRE_AUTH_MAX_AGE_SECONDS } from './auth/signin'
import { throwAuthError } from './auth/error-transport'
import { getSignInServices } from './auth/signin-runtime'
import { getSecurityServices } from './auth/security-runtime'
import {
  AuthError,
  PRE_AUTH_COOKIE,
  changePasswordInput,
  createUserInput,
  disableMfaInput,
  dismissNoticeInput,
  passkeyRegisterOptionsInput,
  passkeyRegisterVerifyInput,
  passkeyRemoveInput,
  passkeyRenameInput,
  recoveryCodesRegenerateInput,
  revokeSessionInput,
  setUserRoleInput,
  setUserStatusInput,
  totpConfirmInput,
  totpRemoveInput,
  totpStartInput,
  userIdOnlyInput,
  mfaOptionsInput,
  mfaVerifyInput,
  passkeyBeginInput,
  passkeyFinishInput,
  passwordSignInInput,
  signOutInput,
  stepUpOptionsInput,
  stepUpVerifyInput,
} from './auth/types'

/** WebAuthn option objects are plain JSON; the cast keeps the server-function serialisation check happy (browser side: cast back to the library type). */
type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json }
const wire = (value: unknown) => value as Json

/** Boundary of every function here (FR-AUT-027, SEC-TGT-153): see `error-transport.ts`; `fallback` is the generic code for non-auth errors. */
const boundary = throwAuthError

const requestMeta = () => {
  return {
    address: currentClientAddress(),
    clientHint: clientHintOf(getRequestHeader('user-agent')),
  }
}

const setSessionCookie = (token: string) => {
  const { config } = getRuntime()
  setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: Math.floor(config.sessionAbsoluteMs / 1000) })
}

/** Account mode only: the stored login mode decides; direct and stateless installs answer like a failed sign-in. */
function requireAccountMode(): void {
  if (getRuntime().store.accounts.getSite().loginMode !== 'account') throw new AuthError('auth_failed')
}

/**
 * Whether the first-run wizard is still pending. Never throws: the front page asks this while it renders on the server,
 * where an error (and the status that `throwAuthError` sets) would become the status of the whole page.
 */
export const getBootState = createServerFn({ method: 'GET' }).handler(() => ({ setupPending: getRuntime().setup.startupState().kind === 'setup_pending' }))

/** The setup page after setup is complete answers 404 as a document too (FR-AUT-003); called by the page's server render only. */
export const setupPageStatus = createServerFn({ method: 'GET' }).handler(() => {
  if (getRuntime().setup.startupState().kind !== 'setup_pending') setResponseStatus(404)
  return null
})

/** Public login page facts: mode, offered primary credentials, site name, autofocus (FR-AUT-026). */
export const getLoginPageInfo = createServerFn({ method: 'GET' })
  .middleware([publicMiddleware])
  .handler(async () => {
    const { store } = getRuntime()
    const site = store.accounts.getSite()
    const mode = site.loginMode ?? 'direct'
    if (mode !== 'account') return { mode, siteName: site.siteName ?? 'DBLoom', passwordEnabled: false, passkeyEnabled: false, autofocus: false }
    const settings = getSignInServices().deps.settings.resolve()
    return {
      mode,
      siteName: site.siteName ?? 'DBLoom',
      passwordEnabled: settings.primaryCredentials.includes('password'),
      passkeyEnabled: settings.primaryCredentials.includes('passkey') && settings.mfaFactors.includes('passkey'),
      autofocus: settings.loginAutofocus,
    }
  })

export const passwordSignIn = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(passwordSignInInput)
  .handler(async ({ data }) => {
    try {
      requireAccountMode()
      const { sessions } = getRuntime()
      const { signIn } = getSignInServices()
      // A new token on every sign-in; an old cookie is never reused (SEC-TGT-040).
      await sessions.destroy(getCookie(SESSION_COOKIE))
      const result = await signIn.passwordSignIn(data, requestMeta())
      setSessionCookie(result.token)
      return { csrf: result.csrf, state: result.state }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const mfaOptions = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('mfaOptions')])
  .validator(mfaOptionsInput)
  .handler(async ({ context, data }) => {
    try {
      return wire(await getSignInServices().signIn.mfaOptions(context.account, data.method))
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

export const mfaVerify = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('mfaVerify')])
  .validator(mfaVerifyInput)
  .handler(async ({ context, data }) => {
    try {
      const token = getCookie(SESSION_COOKIE) ?? ''
      const result = await getSignInServices().signIn.mfaVerify(context.account, token, data)
      setSessionCookie(result.token)
      return { csrf: result.csrf, state: result.state }
    } catch (error) {
      // `mfa_expired` ends the session (five wrong tries or the 5 minute window): the browser goes back to sign-in.
      if (error instanceof AuthError && error.code === 'mfa_expired') deleteCookie(SESSION_COOKIE, { path: '/', secure: true })
      return boundary(error, 'mfa_failed')
    }
  })

export const passkeyBegin = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(passkeyBeginInput)
  .handler(async () => {
    try {
      requireAccountMode()
      const { preAuthCookie, options } = await getSignInServices().signIn.passkeyBegin({ address: requestMeta().address })
      setCookie(PRE_AUTH_COOKIE, preAuthCookie, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: PRE_AUTH_MAX_AGE_SECONDS })
      return { options: wire(options) }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const passkeyFinish = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(passkeyFinishInput)
  .handler(async ({ data }) => {
    try {
      requireAccountMode()
      const pre = getCookie(PRE_AUTH_COOKIE)
      deleteCookie(PRE_AUTH_COOKIE, { path: '/', secure: true })
      if (!pre) throw new AuthError('mfa_failed')
      const { sessions } = getRuntime()
      await sessions.destroy(getCookie(SESSION_COOKIE))
      const result = await getSignInServices().signIn.passkeyFinish(pre, data.response, requestMeta())
      setSessionCookie(result.token)
      return { csrf: result.csrf, state: result.state }
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

/** Allowed in every state, also a half-signed-in one; never throws for a missing session. */
export const signOut = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(signOutInput)
  .handler(async () => {
    await getSignInServices().signIn.signOut(getCookie(SESSION_COOKIE))
    deleteCookie(SESSION_COOKIE, { path: '/', secure: true })
    return { ok: true }
  })

export const stepUpOptions = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(stepUpOptionsInput)
  .handler(async ({ context, data }) => {
    try {
      return wire(await getSignInServices().stepUp.options(context.account, data.method))
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

export const stepUpVerify = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(stepUpVerifyInput)
  .handler(async ({ context, data }) => {
    try {
      const result = await getSignInServices().stepUp.verify(context.account, getCookie(SESSION_COOKIE) ?? '', data)
      setSessionCookie(result.token)
      return { stepUpUntil: result.stepUpUntil }
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

// ---- Account security (FR-AUT-005, 008 to 010, 012, 017) and users (FR-AUT-014, 028) ------------------------------
// Handlers read the cookie, call the service and write the regenerated cookie; policy lives in `auth/account-security.ts`
// and `auth/admin-users.ts`. Functions named in STATE_ALLOWED_FUNCTIONS use `accountStateMiddleware(name)`.

const sessionToken = () => getCookie(SESSION_COOKIE) ?? ''
const none = z.object({}).strict()

export const changePassword = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('changePassword')])
  .validator(changePasswordInput)
  .handler(async ({ context, data }) => {
    try {
      const result = await getSecurityServices().security.changePassword(context.account, sessionToken(), data)
      setSessionCookie(result.token)
      return { csrf: result.csrf, state: result.state }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const listFactors = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('listFactors')])
  .validator(none)
  .handler(({ context }) => {
    try {
      return getSecurityServices().security.listFactors(context.account)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const passkeyRegisterOptions = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('passkeyRegisterOptions')])
  .validator(passkeyRegisterOptionsInput)
  .handler(async ({ context }) => {
    try {
      return wire(await getSecurityServices().security.passkeyRegisterOptions(context.account))
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

export const passkeyRegisterVerify = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('passkeyRegisterVerify')])
  .validator(passkeyRegisterVerifyInput)
  .handler(async ({ context, data }) => {
    try {
      const { token, recoveryCodes } = await getSecurityServices().security.passkeyRegisterVerify(context.account, sessionToken(), data)
      setSessionCookie(token)
      return recoveryCodes ? { recoveryCodes } : {}
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

export const passkeyRename = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(passkeyRenameInput)
  .handler(({ context, data }) => {
    try {
      getSecurityServices().security.passkeyRename(context.account, data)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const passkeyRemove = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(passkeyRemoveInput)
  .handler(({ context, data }) => {
    try {
      setSessionCookie(getSecurityServices().security.passkeyRemove(context.account, sessionToken(), data.id).token)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const totpStart = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('totpStart')])
  .validator(totpStartInput)
  .handler(({ context }) => {
    try {
      return getSecurityServices().security.totpStart(context.account)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const totpConfirm = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('totpConfirm')])
  .validator(totpConfirmInput)
  .handler(({ context, data }) => {
    try {
      const { token, recoveryCodes } = getSecurityServices().security.totpConfirm(context.account, sessionToken(), data.code)
      setSessionCookie(token)
      return recoveryCodes ? { recoveryCodes } : {}
    } catch (error) {
      return boundary(error, 'mfa_failed')
    }
  })

export const totpRemove = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(totpRemoveInput)
  .handler(({ context }) => {
    try {
      setSessionCookie(getSecurityServices().security.totpRemove(context.account, sessionToken()).token)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const recoveryCodesRegenerate = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(recoveryCodesRegenerateInput)
  .handler(({ context }) => {
    try {
      return getSecurityServices().security.recoveryCodesRegenerate(context.account)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const disableMfa = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(disableMfaInput)
  .handler(({ context }) => {
    try {
      setSessionCookie(getSecurityServices().security.disableMfa(context.account, sessionToken()).token)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const listSessions = createServerFn({ method: 'POST' })
  .middleware([accountStateMiddleware('listSessions')])
  .validator(none)
  .handler(({ context }) => {
    try {
      return getSecurityServices().security.listSessions(context.account)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const revokeSession = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(revokeSessionInput)
  .handler(async ({ context, data }) => {
    try {
      await getSecurityServices().security.revokeSession(context.account, data.ref)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const listNotices = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(none)
  .handler(({ context }) => {
    try {
      return getSecurityServices().security.listNotices(context.account)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const dismissNotice = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(dismissNoticeInput)
  .handler(({ context, data }) => {
    try {
      getSecurityServices().security.dismissNotice(context.account, data.id)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const listUsers = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(none)
  .handler(({ context }) => {
    try {
      return getSecurityServices().adminUsers.list(context.account)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const createUser = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(createUserInput)
  .handler(async ({ context, data }) => {
    try {
      return await getSecurityServices().adminUsers.create(context.account, data)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const setUserStatus = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(setUserStatusInput)
  .handler(({ context, data }) => {
    try {
      getSecurityServices().adminUsers.setStatus(context.account, data.userId, data.status)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const setUserRole = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(setUserRoleInput)
  .handler(({ context, data }) => {
    try {
      getSecurityServices().adminUsers.setRole(context.account, data.userId, data.role)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const deleteUser = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(userIdOnlyInput)
  .handler(({ context, data }) => {
    try {
      getSecurityServices().adminUsers.delete(context.account, data.userId)
      return { ok: true as const }
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })

export const revokeUserSessions = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(userIdOnlyInput)
  .handler(({ context, data }) => {
    try {
      return getSecurityServices().adminUsers.revokeSessions(context.account, data.userId)
    } catch (error) {
      return boundary(error, 'auth_failed')
    }
  })
