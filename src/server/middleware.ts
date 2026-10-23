import { createMiddleware } from '@tanstack/react-start'
import { getCookie, getRequestHeader } from '@tanstack/react-start/server'
import { CSRF_HEADER, SESSION_ENDED, getCsrfToken } from '~/lib/csrf'
import { getRuntime } from './runtime'

export const SESSION_COOKIE = '__Host-dbloom-session'

/** Browsers announce cross-site requests; refuse them (SEC-TGT-042). Non-browser clients send no header. */
export const sameOriginMiddleware = createMiddleware({ type: 'function' }).server(({ next }) => {
  const site = getRequestHeader('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') throw new Error('forbidden')
  return next()
})

export const csrfClientMiddleware = createMiddleware({ type: 'function' }).client(({ next }) => {
  const token = getCsrfToken()
  return next({ headers: token ? { [CSRF_HEADER]: token } : {} })
})

/** Valid session plus matching CSRF header, or the one "session ended" response for every failure (G10). */
export const sessionMiddleware = createMiddleware({ type: 'function' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .server(({ next }) => {
    const { sessions } = getRuntime()
    const session = sessions.resolve(getCookie(SESSION_COOKIE))
    if (!session || !sessions.verifyCsrf(session, getRequestHeader(CSRF_HEADER))) {
      throw new Error(SESSION_ENDED)
    }
    return next({ context: { session } })
  })
