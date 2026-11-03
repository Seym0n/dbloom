import { createFileRoute } from '@tanstack/react-router'
import { log } from '~/server/log'
import { getRuntime } from '~/server/runtime'

/**
 * Starts the runtime inside the server-render bundle. The nitro startup plugin lives in a different bundle of the built
 * server, so it must not create the runtime itself: a second copy of the modules would hold a second store connection,
 * a second setup token and classes that fail `instanceof` against the first. The plugin calls this route in process.
 */
export const Route = createFileRoute('/api/startup')({
  server: {
    handlers: {
      GET: () => {
        try {
          getRuntime()
          return Response.json({ ok: true })
        } catch (error) {
          log.error('DBLoom cannot start', { error: error instanceof Error ? error.message : String(error) })
          return Response.json({ ok: false }, { status: 500 })
        }
      },
    },
  },
})
