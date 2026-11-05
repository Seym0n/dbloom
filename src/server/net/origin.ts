/** Public origin, effective scheme and Host allow-list (FR-SVR-003, 004). The only parser of `DBLOOM_PUBLIC_ORIGIN`. */
import { isTrustedPeer, type NetConfig } from './client-address'

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1)$/i

/** Loopback by name or address (`127.0.0.0/8`, `::1`, `localhost`); `0.0.0.0` and `::` are not loopback. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim().replace(/^\[|\]$/g, ''))
}

export type ParsedOrigin = { origin: string; url: URL; host: string; hostname: string; https: boolean }
export type OriginResult = { ok: true; value: ParsedOrigin } | { ok: false; reason: 'invalid' | 'insecure' }

/**
 * `scheme://host[:port]`, no path, query, fragment or credentials. `https`, or `http` on a loopback host only
 * (`insecure` otherwise).
 */
export function parsePublicOrigin(text: string | undefined | null): OriginResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'invalid' }
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { ok: false, reason: 'invalid' }
  }
  const https = url.protocol === 'https:'
  const hostname = url.hostname.toLowerCase()
  if (!https && !isLoopbackHost(hostname)) return { ok: false, reason: 'insecure' }
  return { ok: true, value: { origin: url.origin, url, host: url.host.toLowerCase(), hostname, https } }
}

export type OriginConfig = NetConfig & {
  publicOrigin?: string | undefined
  allowedHosts: readonly string[]
  /** No configured origin on a non-loopback bind: a trusted peer's `X-Forwarded-Proto` decides the scheme. */
  originDerived?: boolean | undefined
}

export type EffectiveScheme = {
  scheme: 'http' | 'https'
  /** `X-Forwarded-Proto` of a trusted peer (rightmost value); undefined when absent, malformed or from an untrusted peer. */
  forwarded?: 'http' | 'https'
  /** A trusted proxy reports a scheme other than the origin's: the later gate refuses credentials (FR-SVR-004). */
  mismatch: boolean
}

/**
 * Scheme of the public origin, confirmed but never overridden by a trusted peer's `X-Forwarded-Proto`. Without a
 * configured origin the scheme is `fallback` (the request URL's) and no mismatch is possible.
 */
export function effectiveScheme(
  peer: string | undefined | null,
  headers: Headers,
  cfg: OriginConfig,
  fallback: 'http' | 'https' = 'http',
): EffectiveScheme {
  const origin = cfg.publicOrigin ? parsePublicOrigin(cfg.publicOrigin) : null
  const scheme: 'http' | 'https' = origin?.ok ? (origin.value.https ? 'https' : 'http') : fallback
  if (!isTrustedPeer(peer, cfg)) return { scheme, mismatch: false }
  const parts = headers.get('x-forwarded-proto')?.split(',')
  const last = parts?.[parts.length - 1]?.trim().toLowerCase()
  const forwarded = last === 'http' || last === 'https' ? last : undefined
  // Derived origin: nothing is configured to disagree with, so the trusted proxy's scheme is the scheme.
  if (cfg.originDerived && !origin) return { scheme: forwarded ?? scheme, ...(forwarded ? { forwarded } : {}), mismatch: false }
  return { scheme, ...(forwarded ? { forwarded } : {}), mismatch: origin?.ok === true && forwarded !== undefined && forwarded !== scheme }
}

/** `Host` header against `DBLOOM_ALLOWED_HOSTS`: exact `host[:port]`, `*.example.com` (subdomains only) or `*`. */
export function isHostAllowed(host: string | undefined | null, cfg: Pick<OriginConfig, 'allowedHosts'>): boolean {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase().replace(/\.(?=$|:)/, '')
  if (!h || /[\s/@?#]/.test(h)) return false
  for (const entry of cfg.allowedHosts) {
    if (entry === '*' || entry === h) return true
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // ".example.com[:port]"
      if (h.length > suffix.length && h.endsWith(suffix)) return true
    }
  }
  return false
}
