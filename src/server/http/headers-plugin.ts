import { definePlugin } from 'nitro'
import { gateConfig } from '../net/gate-config'
import { applySecurityHeaders } from './headers'

/**
 * Nitro `response` hook: runs for every response the app produces (SSR pages, assets, server functions, server
 * routes, gate refusals, error pages). The hook mutates the outgoing `Response` headers in place.
 */
export default definePlugin((nitro) => {
  nitro.hooks.hook('response', (res, event) => {
    const config = gateConfig()
    if (!config) return
    try {
      applySecurityHeaders(res.headers, new URL(event.req.url).pathname, config)
    } catch {
      // Immutable headers (a response passed through unchanged): replace is not possible here; the header-diff test
      // would catch such a route class.
    }
  })
})
