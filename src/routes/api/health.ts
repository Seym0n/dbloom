import { createFileRoute } from '@tanstack/react-router'

/**
 * Liveness (FR-SVR-010): fixed body, 200 while the process serves, no version or detail. The gate lets only probe
 * hosts and probe peers reach it (`DBLOOM_PROBE_HOSTS`, `DBLOOM_PROBE_ALLOW`); everyone else gets 404.
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () =>
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
    },
  },
})
