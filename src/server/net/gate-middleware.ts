import { randomUUID } from 'node:crypto'
import { defineMiddleware } from 'nitro'
import { log, redactUrl } from '../log'
import { evaluateGate } from './gate'
import { gateConfig } from './gate-config'
import { peerAddress } from './peer'

/** Marker for in-process requests made by the startup plugin (a symbol on the request context; no header can set it). */
export const INTERNAL_REQUEST = Symbol.for('dbloom.internal-request')

/**
 * Nitro middleware, first in the chain for every request (FR-SVR-006). Registered in vite.config.ts as
 * `{ route: '/**', middleware: true }`. The decision is `evaluateGate`; refusals are plain `Response`s, and the
 * response hook (`headers-plugin.ts`) adds the central headers to them as to every other response.
 */
export default defineMiddleware((event) => {
  const request = event.req
  const context = (request.context ??= {}) as Record<string | symbol, unknown>
  if (context[INTERNAL_REQUEST] === true) return
  const config = gateConfig()
  if (!config) return new Response(null, { status: 500 })
  const url = new URL(request.url)
  const requestId = randomUUID()
  const meta = ((context.dbloom as Record<string, unknown> | undefined) ??= {})
  Object.assign(meta, { requestId, startedAt: Date.now() })
  const result = evaluateGate(
    {
      method: request.method.toUpperCase(),
      pathname: url.pathname,
      headers: request.headers,
      peer: peerAddress(request),
      urlScheme: url.protocol === 'https:' ? 'https' : 'http',
    },
    config,
  )
  if (!result.ok) {
    log.warn('gate.refused', { requestId, status: result.status, reason: result.reason, method: request.method, path: redactUrl(url.pathname) })
    return new Response(result.body === '' ? null : result.body, {
      status: result.status,
      headers: result.body === '' ? {} : { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  Object.assign(meta, { clientAddress: result.clientAddress, scheme: result.scheme, routeClass: result.routeClass })
})
