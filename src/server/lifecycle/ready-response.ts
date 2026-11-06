import { sessionCookieOf } from '../session-cookie'
import { getRuntime } from '../runtime'
import { CidrList } from '../net/cidr'
import { peerAddress } from '../net/peer'
import { isAdministratorRequest } from './ready-admin'
import { checkReady, NOT_READY_BODY, READY_BODY, type ReadyResult } from './readiness'

const LOOPBACK = new CidrList(['127.0.0.0/8', '::1/128'])

/** Detail shown to loopback peers and to an administrator session (SPEC/31 FR-AEX-006). */
export function readyDetail(result: ReadyResult, version: string): Record<string, unknown> {
  return { ready: result.ready, state: result.state, ...(result.mode ? { mode: result.mode } : {}), ...(result.stateless !== undefined ? { store: result.stateless ? 'none' : result.state === 'store' ? 'unavailable' : 'ok' } : {}), version }
}

export function readyResponse(request: Request): Response {
  const result = checkReady({
    runtime: () => {
      const rt = getRuntime()
      const startup = rt.setup.startupState()
      const mode = startup.kind === 'ready' ? startup.mode : startup.kind
      return { stateless: rt.statelessPrefs !== undefined, mode, ping: () => void rt.store.db.prepare('SELECT 1').get() }
    },
  })
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  const status = result.ready ? 200 : 503
  const detail =
    LOOPBACK.contains(peerAddress(request)) ||
    isAdministratorRequest(request, sessionCookieOf(request), {
      resolve: (cookie) => getRuntime().sessions.resolveAccount(cookie, { background: true }),
      getUser: (id) => getRuntime().store.accounts.getUser(id),
    })
  const body = detail ? JSON.stringify(readyDetail(result, process.env.npm_package_version ?? 'unknown')) : result.ready ? READY_BODY : NOT_READY_BODY
  return new Response(body, { status, headers })
}
