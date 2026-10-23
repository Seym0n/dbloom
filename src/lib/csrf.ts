/** CSRF token of the current browser session; kept in memory only, never in browser storage. */
let token: string | undefined

export const setCsrfToken = (value: string | undefined) => {
  token = value
}
export const getCsrfToken = () => token

export const CSRF_HEADER = 'x-dbloom-csrf'
export const SESSION_ENDED = 'session_ended'
