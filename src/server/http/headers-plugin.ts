import { definePlugin } from 'nitro'
import { log, redactUrl } from '../log'
import { gateConfig } from '../net/gate-config'
import { applySecurityHeaders } from './headers'

type Meta = { requestId?: string; startedAt?: number; clientAddress?: string }

/**
 * Nitro `response` hook: runs for every response the app produces (SSR pages, assets, server functions, server
 * routes, gate refusals, error pages). The hook mutates the outgoing `Response` headers in place: the central
 * security headers and `X-Request-Id`; it also writes the access log line (FR-SVR-020; path with redacted query,
 * no headers, no bodies; assets and probes at debug level).
 */
export default definePlugin((nitro) => {
  nitro.hooks.hook('response', (res, event) => {
    const config = gateConfig()
    if (!config) return
    const url = new URL(event.req.url)
    const meta = ((event.req.context as { dbloom?: Meta } | undefined)?.dbloom ?? {}) as Meta
    try {
      applySecurityHeaders(res.headers, url.pathname, config)
      if (meta.requestId) res.headers.set('x-request-id', meta.requestId)
    } catch {
      // Immutable headers (a response passed through unchanged): replace is not possible here; the header-diff test
      // would catch such a route class.
    }
    if (!meta.requestId) return
    const quiet = url.pathname.startsWith('/assets/') || url.pathname === '/api/health' || url.pathname === '/api/ready'
    const fields = {
      requestId: meta.requestId,
      method: event.req.method,
      path: redactUrl(`${url.pathname}${url.search}`),
      status: res.status,
      ms: meta.startedAt ? Date.now() - meta.startedAt : undefined,
    }
    if (quiet) log.debug('request', fields)
    else log.info('request', fields)
  })
})
