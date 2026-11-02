/** Package C invites (FR-AUT-015, FR-TGT-104, ST-081, ST-082): issue, list, revoke, passkey options, redeem. */
import { randomUUID } from 'node:crypto'
import { audit } from '../audit'
import { checkAddress, checkNewPassword, inviteWebauthnUserId, link, lifetime, nowOf, notify, openToken, passkeyRecord, validUsername, type LinkDeps } from './links'
import { AuthError, type AuthUser, type InviteService, type LinkTokenRecord, type User } from './types'

export function createInviteService(d: LinkDeps): InviteService {
  const { store } = d
  const requireAdmin = (actor: AuthUser) => {
    if (actor.role !== 'admin') throw new AuthError('auth_failed')
  }
  return {
    issue(actor, input) {
      // Step-up is the caller's job (FR-AUT-013, `requireRecentFactor`); the role is checked here.
      requireAdmin(actor)
      const at = nowOf(d)
      const token = d.tokens.newLinkToken()
      const url = link(d, 'invite', token) // fails before anything is stored when no public origin exists
      const rec: LinkTokenRecord = {
        id: randomUUID(), kind: 'invite', tokenHash: d.tokens.hashToken(token), userId: null, role: input.role,
        createdBy: actor.id, createdAt: at, expiresAt: at + lifetime(d.settings().inviteLifetimeMs, input.lifetimeMs), usedAt: null, revokedAt: null,
      }
      store.transaction(() => {
        store.addToken(rec)
        if (input.role === 'admin') notify(store, 'admin_invite_issued', at)
      })
      audit('invite.issue', { id: rec.id, role: input.role, actor: actor.id, expiresAt: rec.expiresAt })
      return { id: rec.id, link: url, expiresAt: rec.expiresAt }
    },

    list: () => store.listOpenInvites(nowOf(d)).map(({ id, role, createdBy, createdAt, expiresAt }) => ({ id, role, createdBy, createdAt, expiresAt })),

    revoke(actor, id) {
      requireAdmin(actor)
      const ok = store.revokeToken(id, nowOf(d))
      audit('invite.revoke', { id, actor: actor.id, outcome: ok ? 'ok' : 'noop' })
    },

    async passkeyOptions(token, username, preAuthOwner) {
      const rec = openToken(d, 'invite', token)
      if (!rec) throw new AuthError('invite_invalid')
      const { username: name, key } = validUsername(d, username)
      if (store.getUserByKey(key)) throw new AuthError('auth_failed')
      return d.webauthn.registrationOptions(transientUser(rec, name, key, nowOf(d)), [], 'invite_passkey', preAuthOwner)
    },

    async redeem(input, meta) {
      checkAddress(d, meta.address)
      const ipKey = `ip:${meta.address}` as const
      const rec = openToken(d, 'invite', input.token)
      if (!rec || !rec.role) {
        d.throttle.fail(ipKey)
        audit('invite.redeem', { outcome: 'invalid' })
        throw new AuthError('invite_invalid')
      }
      const { username, key } = validUsername(d, input.username)
      if (store.getUserByKey(key)) throw new AuthError('auth_failed') // the invite stays usable
      const at = nowOf(d)
      const user = transientUser(rec, username, key, at)
      user.displayName = input.displayName?.trim() || username

      // Credential first (slow, may fail): the token is consumed only together with the account.
      let phc: string | undefined
      let passkey: ReturnType<typeof passkeyRecord> | undefined
      if (input.credential.kind === 'password') {
        await checkNewPassword(d, input.credential.password, username)
        phc = await d.passwords.hash(input.credential.password, d.settings().argon2Login)
      } else {
        if (!meta.preAuthOwner) throw new AuthError('mfa_failed')
        const verified = await d.webauthn.verifyRegistration(meta.preAuthOwner, 'invite_passkey', input.credential.response, { requireUserVerification: true })
        passkey = passkeyRecord(verified, user.id, input.credential.name, at)
      }

      store.transaction(() => {
        // Re-check inside the transaction: a concurrent redemption or revocation ends in one `invite_invalid`.
        if (store.getUserByKey(key)) throw new AuthError('auth_failed')
        store.createUser(user)
        if (phc) store.setPassword({ userId: user.id, phc, changedAt: at })
        if (passkey) store.addPasskey(passkey)
        if (!store.markTokenUsed(rec.id, at, user.id)) throw new AuthError('invite_invalid')
      })
      audit('invite.redeem', { id: rec.id, userId: user.id, role: user.role, outcome: 'ok', method: input.credential.kind })
      return { userId: user.id }
    },
  }
}

function transientUser(rec: LinkTokenRecord, username: string, usernameKey: string, at: number): User {
  return {
    id: randomUUID(), username, usernameKey, displayName: username, role: rec.role!, status: 'active', securityVersion: 0,
    mustChangePassword: false, tempPasswordExpiresAt: null, webauthnUserId: inviteWebauthnUserId(rec.tokenHash),
    createdAt: at, updatedAt: at, createdBy: `invite:${rec.id}`, lastSignInAt: null,
  }
}
