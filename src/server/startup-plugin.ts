import { definePlugin } from 'nitro'

/**
 * Refuses to start on a bad configuration (SEC-TGT-018) instead of failing on the first request. The runtime is created
 * by `/api/startup` in the server-render bundle (see that route), not here.
 */
export default definePlugin((nitro) => {
  setImmediate(() => {
    void (async () => {
      let ok = false
      try {
        ok = (await nitro.fetch(new Request('http://localhost/api/startup'))).ok
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
