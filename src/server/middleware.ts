import { createMiddleware } from '@tanstack/react-start'
import { getCookie, getRequestHeader, setResponseHeader } from '@tanstack/react-start/server'
import { CONNECTION_HEADER, CSRF_HEADER, SESSION_ENDED, getConnectionId, getCsrfToken } from '~/lib/csrf'
import { throwAuthError } from './auth/error-transport'
import { BACKGROUND_HEADER } from './auth/types'
import { assertNotInMaintenance } from './maintenance'
import { getRuntime } from './runtime'
import { sessionCookie } from './session-cookie-request'
import { assertSetupDone, resolveTargetSession, stateGate } from './session-context'

/** Browsers announce cross-site requests; refuse them (SEC-TGT-042). Non-browser clients send no header. */
export const sameOriginMiddleware = createMiddleware({ type: 'function' }).server(({ next }) => {
  const site = getRequestHeader('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') throw new Error('forbidden')
  return next()
})

/**
 * Setup gate (FR-AUT-001): while the first-run wizard is pending every function except the setup ones answers
 * `setup_pending`. The setup functions use `sameOriginMiddleware` only; everything else goes through this.
 */
export const setupGateMiddleware = createMiddleware({ type: 'function' }).server(({ next }) => {
  try {
    assertSetupDone(getRuntime())
  } catch (error) {
    return throwAuthError(error)
  }
  return next()
})

export const csrfClientMiddleware = createMiddleware({ type: 'function' }).client(({ next }) => {
  const token = getCsrfToken()
  return next({ headers: token ? { [CSRF_HEADER]: token, [CONNECTION_HEADER]: getConnectionId() ?? '' } : {} })
})

/**
 * Account-mode context. `fn` names the server function for the per-state allow-list (STATE_ALLOWED_FUNCTIONS, 5.5):
 * only `full` sessions pass unless the state lists the function. The default (`accountMiddleware`) is `full` only.
 */
export const accountStateMiddleware = (fn?: string) =>
  createMiddleware({ type: 'function' })
    .middleware([sameOriginMiddleware, csrfClientMiddleware, setupGateMiddleware])
    .server(({ next }) => {
      // Never cached: GET calls of different connections share one URL, and a shared browser cache would hand the answer
      // of one connection to another tab (found by e2e/auth-live-connections.spec.ts).
      setResponseHeader('Cache-Control', 'no-store')
      const { sessions } = getRuntime()
      const context = sessions.resolveAccount(getCookie(sessionCookie()), { background: getRequestHeader(BACKGROUND_HEADER) === '1' })
      if (!context || !sessions.verifyCsrf(context, getRequestHeader(CSRF_HEADER))) throw new Error(SESSION_ENDED)
      try {
        stateGate(context.state, fn)
        // Maintenance mode (ST-218): users are refused, administrators pass. `signOut` is a public function and stays open.
        assertNotInMaintenance(getRuntime(), context.user)
      } catch (error) {
        return throwAuthError(error)
      }
      return next({ context: { account: context } })
    })

export const accountMiddleware = accountStateMiddleware()

/**
 * Valid session plus matching CSRF header, or the one "session ended" response for every failure (G10).
 * Direct mode: the session of the cookie. Account mode: the connection of `x-dbloom-connection` (checked against the
 * session's connections; a closed pool is reopened once with the held credential, G5), in a `full` session only.
 * The `session` context keeps the `LiveSession` shape; its `idHash` is the scope key (see `session-context.ts`).
 */
export const sessionMiddleware = createMiddleware({ type: 'function' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware, setupGateMiddleware])
  .server(async ({ next }) => {
    setResponseHeader('Cache-Control', 'no-store')
    const session = await resolveTargetSession(getRuntime(), {
      token: getCookie(sessionCookie()),
      connectionId: getRequestHeader(CONNECTION_HEADER),
      csrf: getRequestHeader(CSRF_HEADER),
      background: getRequestHeader(BACKGROUND_HEADER) === '1',
    })
    if (!session) throw new Error(SESSION_ENDED)
    return next({ context: { session } })
  })

/** Public (no session) functions after setup: same-origin check plus the setup gate. */
export const publicMiddleware = createMiddleware({ type: 'function' }).middleware([sameOriginMiddleware, setupGateMiddleware])
