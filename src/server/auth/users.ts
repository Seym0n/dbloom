import { randomBytes, randomUUID } from 'node:crypto'
import { audit } from '../audit'
import { createAuthSettingsResolver } from './settings'
import { AuthError, USERNAME_MAX_CHARS, USERNAME_PATTERN, type AccountStore, type AuthUser, type ResolvedAuthSettings, type User, type UserService } from './types'

/** The settings this service reads: 2FA policy (ST-054, ST-055) and the temporary password lifetime (ST-068). */
export type UserServiceSettings = Pick<ResolvedAuthSettings, 'mfaScope' | 'mfaRoles' | 'mfaGraceMs' | 'tempPasswordMs'>

/** Side effects the store cannot do: closing in-memory connections of dropped sessions, removing a deleted user's preferences. */
export type UserServiceHooks = {
  onSessionsEnded?: (idHashes: string[]) => void
  onUserDeleted?: (userId: string) => void
}

export function createUserService(
  store: AccountStore,
  passwordHash: (password: string) => Promise<string>,
  now = Date.now,
  settings: () => UserServiceSettings = () => createAuthSettingsResolver(store).resolve(),
  hooks: UserServiceHooks = {},
): UserService {
  const usernameKey = (name: string) => name.normalize('NFKC').toLocaleLowerCase('en-US')
  const actorId = (a: AuthUser | 'setup' | 'cli') => typeof a === 'string' ? a : a.id
  /** Only an active admin counts towards the last-admin guard; a disabled one may be demoted or deleted. */
  const isLastActiveAdmin = (id: string) => {
    const u = store.getUser(id)
    return u?.role === 'admin' && u.status === 'active' && store.countActiveAdmins() <= 1
  }
  const service: UserService = {
    usernameKey,
    async create(input, actor, opts = { temporary: false }) {
      const username = input.username.normalize('NFKC')
      if ([...username].length < 1 || [...username].length > USERNAME_MAX_CHARS || !USERNAME_PATTERN.test(username)) throw new AuthError('password_rejected')
      const key = usernameKey(username)
      if (store.getUserByKey(key)) throw new AuthError('auth_failed')
      const at = now()
      // Hash first: a throttled or failed hash must not leave a user without a password behind.
      const phc = await passwordHash(input.password)
      const user: User = { id: randomUUID(), username, usernameKey: key, displayName: input.displayName, role: input.role, status: 'active', securityVersion: 0, mustChangePassword: !!opts.temporary, tempPasswordExpiresAt: opts.temporary ? at + settings().tempPasswordMs : null, webauthnUserId: randomBytes(32).toString('base64url'), createdAt: at, updatedAt: at, createdBy: actorId(actor), lastSignInAt: null }
      store.transaction(() => {
        // Re-check inside the transaction: two concurrent creates of one name end in one `auth_failed`, not a raw UNIQUE error.
        if (store.getUserByKey(key)) throw new AuthError('auth_failed')
        store.createUser(user)
        store.setPassword({ userId: user.id, phc, changedAt: at })
      })
      audit('user.create', { subject: user.id, actor: actorId(actor) })
      return user
    },
    list: () => store.listUsers(),
    setStatus: (id,status,actor) => { if (status === 'disabled' && isLastActiveAdmin(id)) throw new AuthError('auth_failed'); store.updateUser(id,{status,updatedAt:now()}); audit('user.status',{subject:id,status,actor:actor.id}) },
    setRole: (id,role,actor) => { if (role !== 'admin' && isLastActiveAdmin(id)) throw new AuthError('auth_failed'); store.updateUser(id,{role,updatedAt:now()}); audit('user.role',{subject:id,role,actor:actor.id}) },
    delete: (id,actor) => { if (isLastActiveAdmin(id)) throw new AuthError('auth_failed'); const ended = store.listUserSessions(id).map((r) => r.idHash); store.deleteUser(id); hooks.onSessionsEnded?.(ended); hooks.onUserDeleted?.(id); audit('user.delete',{subject:id,actor:actor.id}) },
    revokeSessions: (id,actor) => { const n=store.deleteUserSessions(id); hooks.onSessionsEnded?.(n); audit('user.sessions_revoked',{subject:id,actor:actorId(actor),count:n.length}); return n.length },
    bumpSecurityVersion: (id,keep) => { const u=store.getUser(id); if(!u)return; store.updateUser(id,{securityVersion:u.securityVersion+1,updatedAt:now()}); const ended=store.deleteUserSessions(id,keep); hooks.onSessionsEnded?.(ended) },
    mfaRequirement: (u, at) => {
      const { mfaScope, mfaRoles, mfaGraceMs } = settings()
      // FR-AUT-012: administrators always; otherwise the scope (ST-054) decides.
      const required = u.role === 'admin' || mfaScope === 'all' || (mfaScope === 'roles' && mfaRoles.includes(u.role))
      // No grace for administrators, and none to wait out when 2FA is not required (ST-055).
      if (!required || u.role === 'admin') return { required, graceEnded: true }
      // The grace period runs from the later of account creation and the last change of the policy.
      const changed = store.getSettings().filter((r) => r.key === 'mfaScope' || r.key === 'mfaRoles').map((r) => r.updatedAt)
      const start = Math.max(u.createdAt, ...changed)
      return { required, graceEnded: at >= start + mfaGraceMs }
    },
  }
  return service
}
