/**
 * Central response headers (FR-SVR-007, 008), applied to EVERY response by the Nitro `response` hook
 * (`headers-plugin.ts`): pages, assets, server functions, server routes, gate refusals and framework errors.
 * Not in scope here: CSP and frame rules (module `hardening`, Q5).
 *
 * Cache rule. `Cache-Control: no-store` is added to every response that has no `Cache-Control` of its own, except
 * the content-hashed build files under `/assets/` (cacheable, they never depend on identity). A `Cache-Control`
 * set by a handler is kept (server functions and downloads already say `no-store`). So the answer to "depends on
 * identity" is deny by default: pages carry the boot and session state, so they are no-store too.
 */
import { parsePublicOrigin } from '../net/origin'

export type HeaderConfig = {
  publicOrigin?: string | undefined
  hsts: { enabled: boolean; maxAgeSeconds: number; includeSubDomains: boolean }
}

export const FIXED_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Robots-Tag', 'noindex, nofollow'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
]

export function hstsValue(cfg: HeaderConfig): string | undefined {
  const origin = cfg.publicOrigin ? parsePublicOrigin(cfg.publicOrigin) : null
  if (!origin?.ok || !origin.value.https || !cfg.hsts.enabled) return undefined
  return `max-age=${cfg.hsts.maxAgeSeconds}${cfg.hsts.includeSubDomains ? '; includeSubDomains' : ''}`
}

/** Hashed build output; safe to cache because the file name changes with the content. */
export function isHashedAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/')
}

/** Sets the central headers on `headers` in place. Removes any `Access-Control-*` header (CORS is off). */
export function applySecurityHeaders(headers: Headers, pathname: string, cfg: HeaderConfig): void {
  for (const [name, value] of FIXED_HEADERS) headers.set(name, value)
  const hsts = hstsValue(cfg)
  if (hsts) headers.set('Strict-Transport-Security', hsts)
  else headers.delete('Strict-Transport-Security')
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('access-control-')) headers.delete(name)
  if (!headers.has('Cache-Control') && !isHashedAsset(pathname)) headers.set('Cache-Control', 'no-store')
}
