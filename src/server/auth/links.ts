/** Package C shared parts of invites and recovery links (FR-AUT-015, 016, ST-081, ST-082, ST-084). */
import { createHash, randomUUID } from 'node:crypto'
import { AuthError, USERNAME_MAX_CHARS, USERNAME_PATTERN, type AccountStore, type LinkTokenRecord, type NoticeKind, type PasswordService, type PasskeyRecord, type ResolvedAuthSettings, type Throttle, type TokenKind, type TokenService, type UserService, type WebAuthnService } from './types'

export type LinkDeps = {
  store: AccountStore
  tokens: Pick<TokenService, 'newLinkToken' | 'hashToken'>
  users: Pick<UserService, 'usernameKey'>
  passwords: Pick<PasswordService, 'check' | 'hash'>
  webauthn: Pick<WebAuthnService, 'registrationOptions' | 'verifyRegistration'>
  throttle: Throttle
  settings: () => Pick<ResolvedAuthSettings, 'publicOrigin' | 'inviteLifetimeMs' | 'recoveryLinkLifetimeMs' | 'passwordMinLength' | 'breachedCheck' | 'argon2Login'>
  now?: () => number
  /** Called with the id hashes of sessions the store dropped, so the owner can close their in-memory connections. */
  onSessionsEnded?: (idHashes: string[]) => void
}

export const nowOf = (d: LinkDeps) => (d.now ?? Date.now)()

/** Throws `auth_throttled` while the address is in backoff (checked before any hash). */
export function checkAddress(d: LinkDeps, address: string): void {
  const wait = d.throttle.delayMs(`ip:${address}`)
  if (wait > 0) throw new AuthError('auth_throttled', { retryAfterSeconds: Math.ceil(wait / 1000) })
}

/** The token record when it is of `kind` and open; otherwise undefined (one outcome for every failure). */
export function openToken(d: LinkDeps, kind: TokenKind, token: string): LinkTokenRecord | undefined {
  const r = d.store.getTokenByHash(d.tokens.hashToken(token))
  if (!r || r.kind !== kind || r.usedAt !== null || r.revokedAt !== null || r.expiresAt <= nowOf(d)) return undefined
  return r
}

export function link(d: LinkDeps, path: 'invite' | 'recover', token: string): string {
  const origin = d.settings().publicOrigin
  if (!origin) throw new AuthError('auth_failed')
  return `${origin.replace(/\/+$/, '')}/${path}#${token}`
}

/** Lifetime: the setting is the ceiling, the issuer may only choose shorter (ST-081, ST-084). */
export const lifetime = (max: number, asked?: number) => (asked && asked > 0 ? Math.min(asked, max) : max)

export function validUsername(d: LinkDeps, raw: string): { username: string; key: string } {
  const username = raw.normalize('NFKC')
  if ([...username].length < 1 || [...username].length > USERNAME_MAX_CHARS || !USERNAME_PATTERN.test(username)) throw new AuthError('auth_failed')
  return { username, key: d.users.usernameKey(username) }
}

export async function checkNewPassword(d: LinkDeps, password: string, username: string): Promise<void> {
  const s = d.settings()
  const { reason } = await d.passwords.check(password, { username, minLength: s.passwordMinLength, breachedCheck: s.breachedCheck, failClosed: true })
  if (reason) throw new AuthError('password_rejected', { reason })
}

/** Handle of a passkey for a user that does not exist yet: stable per invite, 43 base64url characters, not the user name. */
export const inviteWebauthnUserId = (tokenHash: string) => createHash('sha256').update(`webauthn-user/${tokenHash}`).digest('base64url')

export function passkeyRecord(
  verified: Omit<PasskeyRecord, 'userId' | 'name' | 'createdAt' | 'lastUsedAt'>,
  userId: string,
  name: string,
  at: number,
): PasskeyRecord {
  return { ...verified, userId, name, createdAt: at, lastUsedAt: null }
}

/** One notice per active administrator (plus the extra user ids), without duplicates. */
export function notify(store: AccountStore, kind: NoticeKind, at: number, extra: string[] = []): void {
  const ids = new Set([...store.listUsers().filter((u) => u.role === 'admin' && u.status === 'active').map((u) => u.id), ...extra])
  for (const userId of ids) store.addNotice({ id: randomUUID(), userId, kind, createdAt: at, readAt: null })
}

export type { LinkTokenRecord }
