/**
 * Request limits (FR-SVR-009, SEC-TGT-131). Body caps only (see reviews/server-limits.md). Gate (`gate.ts` -> `checkBodyLimit`): cap per
 * route class from the declared `Content-Length`; a body of unknown length (chunked) on a capped route is refused
 * too, because the size cannot be proven. Header size, connection and timeout limits are left to Node defaults and
 * the reverse proxy (owner decision 2026-11-03).
 */
/** Server functions are served under this prefix (same value as `SERVER_FN_BASE` in `net/gate.ts`, kept free of an import cycle). */
const SERVER_FN_BASE = '/_serverFn/'

export type Limits = {
  functionBodyKiB: number
  otherBodyKiB: number
}

/** Routes that enforce their own (larger) upload limit: the io limit and the rows upload limit. */
export const OWN_LIMIT_PATHS: readonly string[] = ['/api/io/upload', '/api/rows/upload']

export const BODY_REFUSAL = 'payload_too_large'

export type BodyCap = { bytes: number } | 'own'

/** Cap for a path: server functions, other routes, or the route's own limit. */
export function bodyCapOf(pathname: string, limits: Pick<Limits, 'functionBodyKiB' | 'otherBodyKiB'>): BodyCap {
  if (OWN_LIMIT_PATHS.includes(pathname)) return 'own'
  if (pathname.startsWith(SERVER_FN_BASE)) return { bytes: limits.functionBodyKiB * 1024 }
  return { bytes: limits.otherBodyKiB * 1024 }
}

/** True when the request must be answered 413. */
export function checkBodyLimit(
  pathname: string,
  headers: Headers,
  limits: Pick<Limits, 'functionBodyKiB' | 'otherBodyKiB'>,
): boolean {
  const cap = bodyCapOf(pathname, limits)
  if (cap === 'own') return false
  const length = headers.get('content-length')
  if (length !== null) {
    if (!/^\d+$/.test(length.trim())) return true
    return Number(length.trim()) > cap.bytes
  }
  // No length: a chunked body cannot be bounded here.
  const te = headers.get('transfer-encoding')
  return te !== null && te.trim() !== ''
}
