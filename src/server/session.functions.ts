import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, getRequestIP, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { audit } from './audit'
import { SESSION_COOKIE, sameOriginMiddleware, sessionMiddleware } from './middleware'
import { getRuntime } from './runtime'

const loginInput = z.object({
  host: z.string().max(300),
  port: z.number().int().optional(),
  username: z.string().max(200),
  password: z.string().max(1000),
})

export const login = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware])
  .validator(loginInput)
  .handler(async ({ data }) => {
    const { auth, sessions, config } = getRuntime()
    const address = getRequestIP({ xForwardedFor: config.trustProxy }) ?? 'unknown'
    // A new token on every login; an old cookie is never reused (SEC-TGT-040).
    await sessions.destroy(getCookie(SESSION_COOKIE))
    const { token, csrf } = await auth.login(data, address)
    setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor(config.sessionAbsoluteMs / 1000),
    })
    return { csrf }
  })

/** Never throws for a missing session: the login page uses it to decide what to show. */
export const getSessionInfo = createServerFn({ method: 'GET' })
  .middleware([sameOriginMiddleware])
  .handler(async () => {
    const { sessions, config } = getRuntime()
    const session = sessions.resolve(getCookie(SESSION_COOKIE))
    if (!session) return null
    return {
      csrf: session.csrf,
      readOnly: config.readOnly || session.readOnly,
      target: {
        host: session.target.host,
        port: session.target.port,
        username: session.target.username,
      },
    }
  })

export const logout = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const { sessions } = getRuntime()
    audit('logout', { user: context.session.target.username })
    await sessions.destroy(getCookie(SESSION_COOKIE))
    deleteCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })
