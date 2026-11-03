/**
 * The one place that decides the effective client address (FR-SVR-005, SEC-TGT-127). Nothing else reads
 * `X-Forwarded-For`, `Forwarded` or `getRequestIP` (lint rule + tests/net-no-forwarded-readers.test.ts).
 */
import { CidrList, PRIVATE_RANGES, normaliseAddress } from './cidr'

export type NetConfig = {
  trustedProxies: readonly string[]
  /** Legacy `DBLOOM_TRUST_PROXY=true`: any private or loopback peer is a trusted proxy. */
  trustProxyLegacy: boolean
  /** 0 = rightmost untrusted entry; N > 0 = the entry N positions from the right. */
  proxyHops: number
}

export const UNKNOWN_ADDRESS = 'unknown'

const cache = new WeakMap<object, CidrList>()
function trustedList(cfg: NetConfig): CidrList {
  const key = cfg.trustedProxies as object
  let list = cache.get(key)
  if (!list) {
    list = new CidrList(cfg.trustedProxies)
    cache.set(key, list)
  }
  return list
}

/** Is the (TCP) peer a declared proxy? */
export function isTrustedPeer(peer: string | undefined | null, cfg: NetConfig): boolean {
  if (!normaliseAddress(peer)) return false
  if (trustedList(cfg).contains(peer)) return true
  return cfg.trustProxyLegacy && PRIVATE_RANGES.contains(peer)
}

/** Entries of every `X-Forwarded-For` line, in order. */
export function forwardedForChain(headers: Headers): string[] {
  // `Headers.get` joins repeated lines with ", ", so one split covers all lines.
  const value = headers.get('x-forwarded-for')
  if (!value) return []
  return value.split(',').map((s) => s.trim())
}

/**
 * Effective client address. Untrusted peer: the peer itself, headers ignored. Trusted peer: rightmost untrusted entry
 * of the combined chain (never the leftmost); with `proxyHops` the entry that many positions from the right.
 * Malformed chain: `unknown`. An all-trusted chain gives the peer (no client can be told apart).
 */
export function clientAddress(peer: string | undefined | null, headers: Headers, cfg: NetConfig): string {
  const p = normaliseAddress(peer)
  if (!p) return UNKNOWN_ADDRESS
  if (!isTrustedPeer(p.address, cfg)) return p.address
  const chain = forwardedForChain(headers)
  if (chain.length === 0) return p.address
  const parsed: string[] = []
  for (const entry of chain) {
    const a = normaliseAddress(entry)
    if (!a) return UNKNOWN_ADDRESS
    parsed.push(a.address)
  }
  if (cfg.proxyHops > 0) return parsed[parsed.length - cfg.proxyHops] ?? UNKNOWN_ADDRESS
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (!isTrustedPeer(parsed[i], cfg)) return parsed[i]!
  }
  return p.address
}
