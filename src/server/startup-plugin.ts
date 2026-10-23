import { definePlugin } from 'nitro'
import { getRuntime } from './runtime'

/** Refuses to start on a bad configuration (SEC-TGT-018) instead of failing on the first request. */
export default definePlugin(() => {
  try {
    getRuntime()
  } catch (error) {
    console.error(`DBLoom cannot start: ${error instanceof Error ? error.message : String(error)}`)
    // In dev the error stays visible in the log and on each request; killing the worker only hangs the socket.
    if (process.env.NODE_ENV === 'production') process.exit(1)
  }
})
