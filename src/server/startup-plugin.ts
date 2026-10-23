import { definePlugin } from 'nitro'
import { getRuntime } from './runtime'

/** Refuses to start on a bad configuration (SEC-TGT-018) instead of failing on the first request. */
export default definePlugin(() => {
  try {
    getRuntime()
  } catch (error) {
    console.error(`DBLoom cannot start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
})
