/**
 * Name of the session cookie, one source for every user (SEC-ISS-001). Browsers ignore the port when they store and send
 * cookies, so two instances on one host and different ports would overwrite each other's cookie. The default public
 * port (443, or none in the origin) keeps `__Host-dbloom-session`; any other port gets `__Host-dbloom-session-<port>`.
 * The port comes from `DBLOOM_PUBLIC_ORIGIN`; without it, from the request's `Host` header (then its URL).
 * `__Host-` rules stay: Secure, Path=/, no Domain.
 */
export const SESSION_COOKIE_BASE = '__Host-dbloom-session'

let configuredPort: string | undefined

/** Called once at runtime start with `config.publicOrigin`; `undefined` falls back to the request. */
export function configureSessionCookie(publicOrigin: string | undefined): void {
  try {
    configuredPort = publicOrigin ? new URL(publicOrigin).port : undefined
  } catch {
    configuredPort = undefined
  }
}

function portOfHost(host: string | null | undefined): string | undefined {
  const m = /^(?:\[[^\]]*\]|[^:]*):(\d{1,5})$/.exec((host ?? '').trim())
  const n = m ? Number(m[1]) : NaN
  return n >= 1 && n <= 65535 ? String(n) : undefined
}

function portOfUrl(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).port || undefined : undefined
  } catch {
    return undefined
  }
}

export function sessionCookieName(host?: string | null, url?: string): string {
  const port = configuredPort ?? portOfHost(host) ?? portOfUrl(url)
  return port && port !== '443' ? `${SESSION_COOKIE_BASE}-${port}` : SESSION_COOKIE_BASE
}

export const sessionCookieOf = (request: Request): string => sessionCookieName(request.headers.get('host'), request.url)
