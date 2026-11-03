import { createFileRoute } from '@tanstack/react-router'

/**
 * Readiness (FR-SVR-010): 200 `{"ready":true}` only when the configuration is valid, the store answers `SELECT 1`
 * (stateless mode skips the store) and shutdown has not begun; otherwise 503 `{"ready":false}`. Detail (mode, store
 * state, version) is added for loopback peers only; the administrator-session branch waits for the admin module.
 * The gate already limits the route to probe hosts and probe peers.
 */
export const Route = createFileRoute('/api/ready')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { readyResponse } = await import('../../server/lifecycle/ready-response')
        return readyResponse(request)
      },
    },
  },
})
