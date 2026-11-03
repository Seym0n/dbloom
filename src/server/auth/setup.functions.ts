/** Setup server functions (FR-AUT-003): thin handlers over `getRuntime().setup`; 404 once setup is complete. */
import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, getRequestHeader, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { CSRF_HEADER } from '~/lib/csrf'
import { csrfClientMiddleware, sameOriginMiddleware } from '../middleware'
import { currentClientAddress, currentRequestOrigin } from '../net/current'
import { getRuntime } from '../runtime'
import { SetupError } from './setup'
import {
  SETUP_COOKIE,
  setupCompleteInput,
  setupPasskeyVerifyInput,
  setupSaveStepInput,
  setupTotpVerifyInput,
  setupVerifyTokenInput,
} from './types'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type JsonObject = { [k: string]: Json }
const empty = z.object({}).strict()
const address = currentClientAddress

/** Maps a setup failure to a bare HTTP response: 404 when gone, 401 without a session, 409 for a wrong step. */
function fail(error: unknown): never {
  if (error instanceof SetupError) {
    if (error.code === 'gone') throw new Response(null, { status: 404 })
    if (error.code === 'session') throw new Response(null, { status: 401 })
    throw new Response(error.message, { status: 409 })
  }
  throw error
}

/** Reachability (404), cookie and CSRF header; returns the cookie. */
function guard(): string {
  const { setup } = getRuntime()
  if (!setup.reachable(address())) throw new Response(null, { status: 404 })
  const cookie = getCookie(SETUP_COOKIE)
  if (!cookie || !setup.csrfOk(cookie, getRequestHeader(CSRF_HEADER))) throw new Response(null, { status: 401 })
  return cookie
}

async function run<T>(fn: (cookie: string) => T | Promise<T>): Promise<T> {
  const cookie = guard()
  try {
    return await fn(cookie)
  } catch (error) {
    return fail(error)
  }
}

export const setupGetState = createServerFn({ method: 'GET' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(empty)
  .handler(() => {
    const { setup } = getRuntime()
    // Before the token is accepted the page learns only the pending state, nothing else (DEP-TGT-123).
    if (!setup.reachable(address())) throw new Response(null, { status: 404 })
    const cookie = getCookie(SETUP_COOKIE)
    const state = cookie ? setup.state(cookie, { origin: currentRequestOrigin() }) : undefined
    return state ? { pending: true as const, ...state } : { pending: true as const }
  })

export const setupVerifyToken = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(setupVerifyTokenInput)
  .handler(({ data }) => {
    const { setup } = getRuntime()
    try {
      const { cookie, csrf } = setup.verifyToken(data.token, address())
      const maxAge = Math.max(1, Math.floor(((setup.tokenExpiresAt() ?? Date.now()) - Date.now()) / 1000))
      setCookie(SETUP_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge })
      return { ok: true as const, csrf }
    } catch (error) {
      // A wrong token is the same page with one fixed message; throttling and 404 propagate.
      if (error instanceof SetupError && error.code === 'invalid_token') return { ok: false as const }
      return fail(error)
    }
  })

export const setupSaveStep = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(setupSaveStepInput)
  .handler(({ data }) => run((cookie) => getRuntime().setup.saveStep(cookie, data)))

export const setupPasskeyOptions = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(empty)
  .handler(() => run(async (cookie) => (await getRuntime().setup.passkeyOptions(cookie)) as unknown as JsonObject))

export const setupPasskeyVerify = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(setupPasskeyVerifyInput)
  .handler(({ data }) => run(async (cookie) => ({ ok: true as const, ...(await getRuntime().setup.passkeyVerify(cookie, data.response, data.name)) })))

export const setupTotpStart = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(empty)
  .handler(() => run((cookie) => getRuntime().setup.totpStart(cookie)))

export const setupTotpVerify = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(setupTotpVerifyInput)
  .handler(({ data }) => run((cookie) => getRuntime().setup.totpVerify(cookie, data.code)))

export const setupComplete = createServerFn({ method: 'POST' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware])
  .validator(setupCompleteInput)
  .handler(({ data }) =>
    run((cookie) => {
      getRuntime().setup.complete(cookie, data)
      deleteCookie(SETUP_COOKIE, { path: '/', secure: true })
      return { ok: true as const }
    }),
  )
