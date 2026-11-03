/**
 * Request-bound wrappers: the only callers of the framework's request-address and forwarded-header helpers.
 * Peer finding (reviews/server-nitro-peer.md): TanStack `getRequest()` is the srvx Node request; the TCP peer is
 * `runtime.node.req.socket.remoteAddress`, and `request.ip` equals it because Nitro sets no srvx `trustProxy`.
 */
import { getRequest } from '@tanstack/react-start/server'
import { getRuntime } from '../runtime'
import { clientAddress, UNKNOWN_ADDRESS } from './client-address'
import { effectiveScheme } from './origin'
import { peerAddress } from './peer'

/** Effective client address of the current request (FR-SVR-005). */
export function currentClientAddress(): string {
  const request = getRequest()
  // The gate (gate.ts) computes the address once per request and stores it on the request context.
  const stored = (request as { context?: { dbloom?: { clientAddress?: string } } }).context?.dbloom?.clientAddress
  if (stored) return stored
  return clientAddress(peerAddress(request), request.headers, getRuntime().config) || UNKNOWN_ADDRESS
}

/** `scheme://Host` of the current request with the effective scheme; for comparison with the configured origin only. */
export function currentRequestOrigin(): string {
  const request = getRequest()
  const { config } = getRuntime()
  const fallback = new URL(request.url).protocol === 'https:' ? 'https' : 'http'
  const { scheme } = effectiveScheme(peerAddress(request), request.headers, config, fallback)
  const host = request.headers.get('host') ?? new URL(request.url).host
  return `${scheme}://${host}`
}
