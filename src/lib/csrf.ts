/** CSRF token of the current browser session; kept in memory only, never in browser storage. */
let token: string | undefined

export const setCsrfToken = (value: string | undefined) => {
  token = value
}
export const getCsrfToken = () => token

export const CSRF_HEADER = 'x-dbloom-csrf'
export const SESSION_ENDED = 'session_ended'

/** Account mode: id of the connection a tab works on (SPEC/26 FR-AUT-018); same value as `CONNECTION_HEADER` in auth/types. */
export const CONNECTION_HEADER = 'x-dbloom-connection'
/** Query parameter that carries the connection id where a header cannot be set (links that download a file). */
export const CONNECTION_PARAM = 'connection'

/** The tab's connection id from session storage (identifier only, G6); undefined in direct mode and on any storage error. */
export function getConnectionId(): string | undefined {
  try {
    return (typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(CONNECTION_HEADER)) || undefined
  } catch {
    return undefined
  }
}

/** Adds the CSRF and connection headers of the raw routes (upload, download) to `headers`. */
export function withSessionHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const csrf = getCsrfToken()
  if (csrf) headers[CSRF_HEADER] = csrf
  const connection = getConnectionId()
  if (connection) headers[CONNECTION_HEADER] = connection
  return headers
}

/** `url` with the connection id appended as a query parameter (downloads by link, `a.href`). */
export function withConnectionParam(url: string): string {
  const connection = getConnectionId()
  if (!connection) return url
  return `${url}${url.includes('?') ? '&' : '?'}${CONNECTION_PARAM}=${encodeURIComponent(connection)}`
}
