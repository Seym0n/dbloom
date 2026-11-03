import { definePlugin } from 'nitro'
import { log } from './log'
import { createShutdownController, exitAfterFlush, installSignalHandlers } from './lifecycle/shutdown'
import { INTERNAL_REQUEST } from './net/gate-middleware'

/**
 * Refuses to start on a bad configuration (SEC-TGT-018) instead of failing on the first request. The runtime is created
 * by `/api/startup` in the server-render bundle (see that route), not here.
 */
export default definePlugin((nitro) => {
  if (process.env.NODE_ENV === 'production') installShutdown(nitro)
  setImmediate(() => {
    void (async () => {
      let ok = false
      try {
        // In-process request: the gate skips it (no peer, Host is not on the allow-list of a deployed instance).
        const request = new Request('http://localhost/api/startup') as Request & { context?: Record<symbol, unknown> }
        request.context = { [INTERNAL_REQUEST]: true }
        ok = (await nitro.fetch(request)).ok
      } catch (error) {
        log.error('DBLoom cannot start', { error: error instanceof Error ? error.message : String(error) })
      }
      // In dev the error stays visible in the log and on each request; killing the worker only hangs the socket.
      if (!ok && process.env.NODE_ENV === 'production') process.exit(1)
    })()
  })
})

/** `DBLOOM_SHUTDOWN_SECONDS` (1 to 300, default 25); the config module validates it again at startup. */
function graceSeconds(): number {
  const n = Number.parseInt(process.env.DBLOOM_SHUTDOWN_SECONDS ?? '', 10)
  return Number.isInteger(n) && n >= 1 && n <= 300 ? n : 25
}

/**
 * Graceful shutdown (FR-SVR-014). srvx (the Nitro node server) already listens for SIGTERM and SIGINT: it stops
 * accepting connections, lets in-flight requests finish and closes idle keep-alive connections, forces the rest after
 * `SERVER_SHUTDOWN_TIMEOUT` seconds, then Nitro fires its `close` hook. No wrapper is needed: this plugin only sets
 * that timeout from `DBLOOM_SHUTDOWN_SECONDS` (plugins run before the server is created, and srvx reads it then), flips
 * readiness on the first signal, and runs the cleanup steps in the `close` hook. See reviews/server-lifecycle.md.
 */
function installShutdown(nitro: Parameters<Parameters<typeof definePlugin>[0]>[0]): void {
  const seconds = graceSeconds()
  process.env.SERVER_SHUTDOWN_TIMEOUT = String(seconds)
  // srvx skips its handler when `CI` or `TEST` is set; then nothing closes the server, so the steps run without draining.
  const drains = !(process.env.CI || process.env.TEST)
  const controller = createShutdownController({ graceMs: seconds * 1000, drains, exit: exitAfterFlush })
  installSignalHandlers(controller)
  nitro.hooks.hook('close', () => controller.onServerClosed())
}
