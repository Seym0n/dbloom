/** Administrator user functions (SPEC/26 FR-AUT-014, 028; SCN-069, 074).
 *
 * Thin policy layer over `UserService` (which owns the last-administrator guard and the audit lines): administrator
 * role check first, then step-up, then the action. Disabling a user and role changes end that user's sessions
 * (ST-075). Deleting removes sessions, factors, vault, profiles and notices through the store cascade and the
 * preferences through the service hook. The initial password is temporary (ST-068) and never returned.
 */
import { randomUUID } from 'node:crypto'
import { audit } from '../audit'
import { AuthError, type AccountContext, type AccountStore, type AuthSettingsResolver, type PasswordService, type Role, type StepUp, type UserService, type UserStatus, type UserSummary } from './types'

export type AdminUsersDeps = {
  store: AccountStore
  users: Pick<UserService, 'create' | 'list' | 'setStatus' | 'setRole' | 'delete' | 'revokeSessions' | 'bumpSecurityVersion'>
  password: Pick<PasswordService, 'check'>
  settings: Pick<AuthSettingsResolver, 'resolve'>
  stepUp: Pick<StepUp, 'requireRecentFactor'>
  now?: () => number
}

export interface AdminUsersService {
  list(ctx: AccountContext): UserSummary[]
  create(ctx: AccountContext, input: { username: string; displayName: string; role: Role; password: string }): Promise<UserSummary>
  setStatus(ctx: AccountContext, userId: string, status: UserStatus): void
  setRole(ctx: AccountContext, userId: string, role: Role): void
  delete(ctx: AccountContext, userId: string): void
  revokeSessions(ctx: AccountContext, userId: string): { revoked: number }
}

export function createAdminUsers(d: AdminUsersDeps): AdminUsersService {
  const now = () => (d.now ?? Date.now)()
  const { store, users } = d

  /** Administrator of a `full` session whose row is still an active administrator; else `auth_failed`. */
  function adminOf(ctx: AccountContext) {
    const actor = ctx.user
    const row = actor ? store.getUser(actor.id) : undefined
    if (ctx.state !== 'full' || !actor || actor.role !== 'admin' || !row || row.role !== 'admin' || row.status !== 'active') throw new AuthError('auth_failed')
    return actor
  }
  const target = (userId: string) => {
    const user = store.getUser(userId)
    if (!user) throw new AuthError('auth_failed')
    return user
  }

  return {
    list(ctx) {
      adminOf(ctx)
      return users.list()
    },

    async create(ctx, input) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'user.create')
      const s = d.settings.resolve()
      const { reason } = await d.password.check(input.password, { username: input.username, minLength: s.passwordMinLength, breachedCheck: s.breachedCheck, failClosed: false })
      if (reason) throw new AuthError('password_rejected', { reason })
      const user = await users.create(input, actor, { temporary: true })
      const found = store.listUsers().find((u) => u.id === user.id)
      if (!found) throw new AuthError('auth_failed')
      return found
    },

    setStatus(ctx, userId, status) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'user.status')
      target(userId)
      users.setStatus(userId, status, actor)
      // A disabled user's sessions end now, not at their next request (SCN-074).
      if (status === 'disabled') users.revokeSessions(userId, actor)
    },

    setRole(ctx, userId, role) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'user.role')
      const before = target(userId)
      users.setRole(userId, role, actor)
      // ST-075: a role change ends the user's sessions (a changed role must not live on in an old one).
      if (before.role !== role) users.bumpSecurityVersion(userId)
    },

    delete(ctx, userId) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'user.delete')
      target(userId)
      users.delete(userId, actor)
    },

    revokeSessions(ctx, userId) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'user.revoke_sessions')
      target(userId)
      const revoked = users.revokeSessions(userId, actor)
      if (revoked > 0) store.addNotice({ id: randomUUID(), userId, kind: 'sessions_revoked', createdAt: now(), readAt: null })
      audit('user.sessions_revoked', { actor: actor.id, subject: userId, count: revoked, reason: 'revoke_all' })
      return { revoked }
    },
  }
}
