/** Request helpers of the invite and recovery server functions (kept out of the `*.functions.ts` files, which export server functions only). */
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { randomBytes } from 'node:crypto'
import { currentClientAddress } from '../net/current'
import { AuthError, PRE_AUTH_COOKIE, PRE_AUTH_TTL_MS, type AuthUser } from './types'

/** Cookie owner of anonymous passkey ceremonies (`__Host-dbloom-pre`); created when absent. */
export function preAuthOwner(): string {
  const existing = getCookie(PRE_AUTH_COOKIE)
  if (existing) return existing
  const fresh = randomBytes(32).toString('base64url')
  setCookie(PRE_AUTH_COOKIE, fresh, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: Math.floor(PRE_AUTH_TTL_MS / 1000) })
  return fresh
}

export const requestAddress = () => currentClientAddress()

/** Administrator of a full session; anything else is `auth_failed`. */
export function requireAdminUser(user: AuthUser | null): AuthUser {
  if (!user || user.role !== 'admin') throw new AuthError('auth_failed')
  return user
}
