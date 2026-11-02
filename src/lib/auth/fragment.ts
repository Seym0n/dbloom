/**
 * Link tokens (invite, recovery) travel in the URL fragment, so they never reach a server log or a Referer header.
 * The page reads the fragment once and removes it from the address bar and the history entry at once (FR-AUT-015).
 */
import { LINK_TOKEN_CHARS } from '~/server/auth/types'

const TOKEN = new RegExp(`^[A-Za-z0-9_-]{${LINK_TOKEN_CHARS}}$`)

/** Accepts `#<token>` and `#token=<token>`; anything else is not a token. */
export function parseFragmentToken(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const value = raw.startsWith('token=') ? raw.slice('token='.length) : raw
  return TOKEN.test(value) ? value : undefined
}

/** Reads the token and replaces the current history entry with the same path and query, without the fragment. */
export function takeFragmentToken(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const { hash, pathname, search } = window.location
  const token = parseFragmentToken(hash)
  if (hash) window.history.replaceState(window.history.state, '', pathname + search)
  return token
}
