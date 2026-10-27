import { randomBytes, randomUUID } from 'node:crypto'
import { audit } from '../audit'
/* eslint-disable @typescript-eslint/no-unused-vars */
import { AuthError, USERNAME_MAX_CHARS, USERNAME_PATTERN, type AccountStore, type AuthUser, type User, type UserService } from './types'

export function createUserService(store: AccountStore, passwordHash: (password: string) => Promise<string>, now = Date.now): UserService {
  const usernameKey = (name: string) => name.normalize('NFKC').toLocaleLowerCase('en-US')
  const actorId = (a: AuthUser | 'setup' | 'cli') => typeof a === 'string' ? a : a.id
  const service: UserService = {
    usernameKey,
    async create(input, actor, opts = { temporary: false }) {
      const username = input.username.normalize('NFKC')
      if ([...username].length < 1 || [...username].length > USERNAME_MAX_CHARS || !USERNAME_PATTERN.test(username)) throw new AuthError('password_rejected')
      const key = usernameKey(username)
      if (store.getUserByKey(key)) throw new AuthError('auth_failed')
      const at = now()
      const user: User = { id: randomUUID(), username, usernameKey: key, displayName: input.displayName, role: input.role, status: 'active', securityVersion: 0, mustChangePassword: !!opts.temporary, tempPasswordExpiresAt: opts.temporary ? at + 7 * 86400000 : null, webauthnUserId: randomBytes(32).toString('base64url'), createdAt: at, updatedAt: at, createdBy: actorId(actor), lastSignInAt: null }
      store.transaction(() => { store.createUser(user); return store.setPassword({ userId: user.id, phc: '', changedAt: at }) })
      const phc = await passwordHash(input.password)
      store.setPassword({ userId: user.id, phc, changedAt: at })
      audit('account.user.created', { userId: user.id, actor: actorId(actor) })
      return user
    },
    list: () => store.listUsers(),
    setStatus: (id,status,actor) => { if (status === 'disabled' && store.getUser(id)?.role === 'admin' && store.countActiveAdmins() <= 1) throw new AuthError('auth_failed'); store.updateUser(id,{status,updatedAt:now()}); audit('account.user.status',{id,status,actor:actor.id}) },
    setRole: (id,role,actor) => { if (role !== 'admin' && store.getUser(id)?.role === 'admin' && store.countActiveAdmins() <= 1) throw new AuthError('auth_failed'); store.updateUser(id,{role,updatedAt:now()}); audit('account.user.role',{id,role,actor:actor.id}) },
    delete: (id,actor) => { if (store.getUser(id)?.role === 'admin' && store.countActiveAdmins() <= 1) throw new AuthError('auth_failed'); store.deleteUser(id); audit('account.user.deleted',{id,actor:actor.id}) },
    revokeSessions: (id,actor) => { const n=store.deleteUserSessions(id); audit('account.sessions.revoked',{id,actor:actorId(actor),count:n.length}); return n.length },
    bumpSecurityVersion: (id,keep) => { const u=store.getUser(id); if(!u)return; store.updateUser(id,{securityVersion:u.securityVersion+1,updatedAt:now()}); store.deleteUserSessions(id,keep) },
    mfaRequirement: (u,_at) => ({ required: u.role === 'admin', graceEnded: true }),
  }
  return service
}
