/** Package C recovery links (FR-AUT-016, ST-084, ST-085): issue, passkey options, redeem in one transaction. */
import { randomUUID } from 'node:crypto'
import { audit } from '../audit'
import { checkAddress, checkNewPassword, link, lifetime, nowOf, notify, openToken, passkeyRecord, type LinkDeps } from './links'
import { AuthError, type LinkTokenRecord, type RecoveryService } from './types'

export function createRecoveryService(d: LinkDeps): RecoveryService {
  const { store } = d
  /** An open recovery token whose user still exists and is active; else undefined. */
  const resolve = (token: string) => {
    const rec = openToken(d, 'recovery', token)
    const user = rec?.userId ? store.getUser(rec.userId) : undefined
    return rec && user && user.status === 'active' ? { rec, user } : undefined
  }
  return {
    issue(actor, userId) {
      // Step-up is the caller's job (FR-AUT-013); the CLI is trusted by host access (ST-079).
      if (actor !== 'cli' && actor.role !== 'admin') throw new AuthError('auth_failed')
      const user = store.getUser(userId)
      if (!user) throw new AuthError('auth_failed')
      const at = nowOf(d)
      const token = d.tokens.newLinkToken()
      const url = link(d, 'recover', token)
      const rec: LinkTokenRecord = {
        id: randomUUID(), kind: 'recovery', tokenHash: d.tokens.hashToken(token), userId, role: null,
        createdBy: actor === 'cli' ? 'cli' : actor.id, createdAt: at, expiresAt: at + lifetime(d.settings().recoveryLinkLifetimeMs), usedAt: null, revokedAt: null,
      }
      // One live link per user: earlier open links are revoked with the new one.
      store.transaction(() => {
        for (const old of store.listOpenRecoveryTokens(userId, at)) store.revokeToken(old.id, at)
        store.addToken(rec)
      })
      audit('recovery.issue', { id: rec.id, userId, actor: actor === 'cli' ? 'cli' : actor.id, expiresAt: rec.expiresAt })
      return { link: url, expiresAt: rec.expiresAt }
    },

    async passkeyOptions(token, preAuthOwner) {
      const found = resolve(token)
      if (!found) throw new AuthError('recovery_invalid')
      // Old passkeys are deleted on redemption, so none is excluded.
      return d.webauthn.registrationOptions(found.user, [], 'recovery_passkey', preAuthOwner)
    },

    async redeem(input, meta) {
      checkAddress(d, meta.address)
      const found = resolve(input.token)
      if (!found) {
        d.throttle.fail(`ip:${meta.address}`)
        audit('recovery.redeem', { outcome: 'invalid' })
        throw new AuthError('recovery_invalid')
      }
      const { rec, user } = found
      const at = nowOf(d)

      let phc: string | undefined
      let passkey: ReturnType<typeof passkeyRecord> | undefined
      if (input.credential.kind === 'password') {
        await checkNewPassword(d, input.credential.password, user.username)
        phc = await d.passwords.hash(input.credential.password, d.settings().argon2Login)
      } else {
        if (!meta.preAuthOwner) throw new AuthError('mfa_failed')
        const verified = await d.webauthn.verifyRegistration(meta.preAuthOwner, 'recovery_passkey', input.credential.response, { requireUserVerification: true })
        passkey = passkeyRecord(verified, user.id, input.credential.name, at)
      }

      let ended: string[] = []
      store.transaction(() => {
        if (!store.markTokenUsed(rec.id, at, user.id)) throw new AuthError('recovery_invalid')
        // ST-085: every old factor goes; the vault and profiles are not touched.
        store.deletePasskeys(user.id)
        store.deleteTotp(user.id)
        store.deleteRecoveryCodes(user.id)
        if (phc) store.setPassword({ userId: user.id, phc, changedAt: at })
        else store.deletePassword(user.id)
        if (passkey) store.addPasskey(passkey)
        store.updateUser(user.id, { securityVersion: user.securityVersion + 1, mustChangePassword: false, tempPasswordExpiresAt: null, updatedAt: at })
        ended = store.deleteUserSessions(user.id)
        notify(store, 'recovery_redeemed', at, [user.id])
      })
      d.throttle.reset(`acct:${user.usernameKey}`)
      d.onSessionsEnded?.(ended)
      audit('recovery.redeem', { id: rec.id, userId: user.id, outcome: 'ok', method: input.credential.kind, sessionsEnded: ended.length })
      return { userId: user.id }
    },
  }
}
