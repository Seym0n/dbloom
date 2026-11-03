import { definePlugin } from 'nitro'
import { INTERNAL_REQUEST } from './net/gate-middleware'

/**
 * Refuses to start on a bad configuration (SEC-TGT-018) instead of failing on the first request. The runtime is created
 * by `/api/startup` in the server-render bundle (see that route), not here.
 */
export default definePlugin((nitro) => {
  setImmediate(() => {
    void (async () => {
      let ok = false
      try {
        // In-process request: the gate skips it (no peer, Host is not on the allow-list of a deployed instance).
        const request = new Request('http://localhost/api/startup') as Request & { context?: Record<symbol, unknown> }
        request.context = { [INTERNAL_REQUEST]: true }
        ok = (await nitro.fetch(request)).ok
      } catch (error) {
        console.error(
          `DBLoom cannot start: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // In dev the error stays visible in the log and on each request; killing the worker only hangs the socket.
      if (!ok && process.env.NODE_ENV === 'production') process.exit(1)
    })()
  })
})
