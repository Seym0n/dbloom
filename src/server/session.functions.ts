import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { audit } from './audit'
import { getAccountServices } from './auth/account-runtime'
import { throwAuthError } from './auth/error-transport'
import { getPrefsService } from './auth/prefs/runtime'
import { AuthError } from './auth/types'
import { currentClientAddress } from './net/current'
import { SESSION_COOKIE, publicMiddleware, sessionMiddleware } from './middleware'
import { getRuntime } from './runtime'
import { buildSessionInfo } from './session-info'
import { isStateless } from './sql/state'

const loginInput = z.object({
  host: z.string().max(300),
  port: z.number().int().optional(),
  username: z.string().max(200),
  password: z.string().max(1000),
})

/** Direct-mode login. Account installs sign in through `passwordSignIn`; here they answer like a failed sign-in. */
export const login = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(loginInput)
  .handler(async ({ data }) => {
    const { auth, sessions, config, setup } = getRuntime()
    const state = setup.startupState()
    // Direct login only exists in direct (and stateless) installs.
    if (state.kind === 'ready' && state.mode === 'account') throwAuthError(new AuthError('auth_failed'))
    const address = currentClientAddress()
    // A new token on every login; an old cookie is never reused (SEC-TGT-040).
    await sessions.destroy(getCookie(SESSION_COOKIE))
    let result: { token: string; csrf: string }
    try {
      result = await auth.login(data, address)
    } catch (error) {
      // Policy refusals (root, empty password) name their reason (FR-AUT-020); every other failure stays generic.
      if (error instanceof AuthError) return throwAuthError(error)
      throw error
    }
    const { token, csrf } = result
    setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor(config.sessionAbsoluteMs / 1000),
    })
    return { csrf }
  })

/**
 * Never throws for a missing session: the login page uses it to decide what to show. Direct mode answers
 * `{mode:'direct', csrf, readOnly, target, theme, language}`, account mode the `AccountSessionInfo` (any session
 * state; connections, vault, theme and language only for a `full` one). `mode` tells the two apart.
 */
export const getSessionInfo = createServerFn({ method: 'GET' })
  .middleware([publicMiddleware])
  .handler(async () => {
    const runtime = getRuntime()
    const info = buildSessionInfo({
      runtime,
      token: getCookie(SESSION_COOKIE),
      stateless: isStateless(),
      settings: runtime.settings,
      prefs: getPrefsService,
      connections: (ctx) => getAccountServices().connections.list(ctx),
      vaultStatus: (ctx) => getAccountServices().vault.status(ctx),
    })
    return info
  })

export const logout = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const { sessions } = getRuntime()
    audit('logout', { user: context.session.target.username })
    await sessions.destroy(getCookie(SESSION_COOKIE))
    deleteCookie(SESSION_COOKIE, { path: '/', secure: true })
    return { ok: true }
  })
