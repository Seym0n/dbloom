/**
 * Package D (`vault.ts`, FR-AUT-021): per-user vault service. The unwrapped vault key lives only in the session
 * runtime (`AccountSessions.setVaultKey`); this module never stores it. Wrong passphrases count on the account
 * throttle (`acct:<username key>`). Neither passphrase nor recovery key is logged.
 */
import { audit } from '../audit'
import { checkPasswordPolicy, normalisePassword } from './password'
import {
  AuthError,
  type AccountContext,
  type AccountSessions,
  type AccountStore,
  type AuthUser,
  type BreachedList,
  type ProfileSecret,
  type ResolvedAuthSettings,
  type Throttle,
  type UserId,
  type VaultCrypto,
  type VaultRecord,
  type VaultService,
  type VaultStatus,
} from './types'

export type VaultSettings = Pick<ResolvedAuthSettings, 'personalProfiles' | 'vaultPassphraseMin' | 'vaultAutoLockMs' | 'argon2Vault' | 'breachedCheck'>

/** The session runtime part this service needs; `peekVaultKey` (optional) reads without counting as vault activity. */
export type VaultSessions = Pick<AccountSessions, 'setVaultKey' | 'getVaultKey'> & {
  peekVaultKey?: (idHash: string, now: number) => Buffer | undefined
  vaultLockAt?: (idHash: string) => number | undefined
}

/** Reads the vault key without counting as activity when the session runtime offers `peekVaultKey`; keeps `this`. */
export function peekVaultKey(sessions: VaultSessions, idHash: string, now: number): Buffer | undefined {
  return sessions.peekVaultKey ? sessions.peekVaultKey(idHash, now) : sessions.getVaultKey(idHash, now)
}

export type VaultDeps = {
  store: AccountStore
  sessions: VaultSessions
  crypto: VaultCrypto
  throttle: Throttle
  settings: () => VaultSettings
  breached?: BreachedList
  now?: () => number
}

export type VaultServiceImpl = VaultService

/** Same formula as `UserService.usernameKey`. */
export const accountKeyOf = (username: string) => `acct:${username.normalize('NFKC').toLocaleLowerCase('en-US')}` as const

export function requireFullUser(ctx: AccountContext): AuthUser {
  if (ctx.kind !== 'account' || ctx.state !== 'full' || !ctx.user) throw new AuthError('auth_failed')
  return ctx.user
}

export function createVaultService(deps: VaultDeps): VaultServiceImpl {
  const { store, sessions, crypto, throttle } = deps
  const now = deps.now ?? Date.now

  const requireEnabled = () => {
    if (!deps.settings().personalProfiles) throw new AuthError('vault_absent')
  }
  const getRecord = (userId: UserId): VaultRecord => {
    const record = store.getVault(userId)
    if (!record) throw new AuthError('vault_absent')
    return record
  }
  /** Checks the throttle before any Argon2 work (FR-AUT-007). */
  const checkThrottle = (user: AuthUser) => {
    const delay = throttle.delayMs(accountKeyOf(user.username))
    if (delay > 0) throw new AuthError('auth_throttled', { retryAfterSeconds: Math.ceil(delay / 1000) })
  }
  const failed = (user: AuthUser, why: string): never => {
    throttle.fail(accountKeyOf(user.username))
    audit('vault.unlock', { actor: user.id, outcome: 'failed', reason: why })
    throw new AuthError('vault_locked')
  }
  const checkPassphrase = async (passphrase: string): Promise<string> => {
    const s = deps.settings()
    const normal = normalisePassword(passphrase)
    const verdict = await checkPasswordPolicy(normal, deps.breached ?? { contains: async () => 'unavailable', source: () => ({ kind: 'none', entries: 0 }) }, {
      username: '',
      minLength: s.vaultPassphraseMin,
      breachedCheck: s.breachedCheck && !!deps.breached,
      failClosed: false,
    })
    if (verdict.reason) throw new AuthError('password_rejected', { reason: verdict.reason })
    return normal
  }
  /** Passphrase proof for sensitive steps: unwraps with the throttle; returns a fresh key copy. */
  const proveWithPassphrase = async (user: AuthUser, record: VaultRecord, passphrase: string): Promise<Buffer> => {
    checkThrottle(user)
    const key = await crypto.unwrapWithPassphrase(record, normalisePassword(passphrase))
    if (!key) return failed(user, 'passphrase')
    return key
  }
  const peek = (idHash: string) => peekVaultKey(sessions, idHash, now())
  const requireKey = (ctx: AccountContext, user: AuthUser): Buffer => {
    const key = sessions.getVaultKey(ctx.idHash, now())
    if (key) return key
    throw new AuthError(store.getVault(user.id) ? 'vault_locked' : 'vault_absent')
  }

  return {
    status(ctx): VaultStatus {
      const user = requireFullUser(ctx)
      const s = deps.settings()
      const exists = !!store.getVault(user.id)
      const unlocked = exists && !!peek(ctx.idHash)
      const lockAt = unlocked ? sessions.vaultLockAt?.(ctx.idHash) : undefined
      return { exists, unlocked, autoLockAt: unlocked ? (lockAt ?? now() + s.vaultAutoLockMs) : null, enabled: s.personalProfiles }
    },

    async create(ctx, passphrase) {
      const user = requireFullUser(ctx)
      requireEnabled()
      if (store.getVault(user.id)) throw new AuthError('auth_failed')
      const normal = await checkPassphrase(passphrase)
      const made = await crypto.create(user.id, normal, deps.settings().argon2Vault)
      const at = now()
      try {
        store.transaction(() => {
          if (store.getVault(user.id)) throw new AuthError('auth_failed')
          store.setVault({ ...made.record, createdAt: at, updatedAt: at })
        })
      } catch (error) {
        made.vaultKey.fill(0)
        throw error
      }
      sessions.setVaultKey(ctx.idHash, made.vaultKey) // ownership passes to the session runtime
      audit('vault.create', { actor: user.id, outcome: 'ok' })
      return { recoveryKey: made.recoveryKey }
    },

    async unlock(ctx, passphrase) {
      const user = requireFullUser(ctx)
      const record = getRecord(user.id)
      const key = await proveWithPassphrase(user, record, passphrase)
      sessions.setVaultKey(ctx.idHash, key)
      audit('vault.unlock', { actor: user.id, outcome: 'ok' })
    },

    lock(ctx) {
      const user = requireFullUser(ctx)
      sessions.setVaultKey(ctx.idHash, undefined)
      audit('vault.lock', { actor: user.id, outcome: 'ok' })
    },

    async changePassphrase(ctx, current, next) {
      const user = requireFullUser(ctx)
      const record = getRecord(user.id)
      const key = await proveWithPassphrase(user, record, current)
      try {
        const normal = await checkPassphrase(next)
        const wrap = await crypto.rewrapPassphrase(user.id, key, normal, deps.settings().argon2Vault)
        store.setVault({ ...record, ...wrap, updatedAt: now() })
      } catch (error) {
        key.fill(0)
        throw error
      }
      sessions.setVaultKey(ctx.idHash, key)
      audit('vault.passphrase', { actor: user.id, outcome: 'ok' })
    },

    async useRecoveryKey(ctx, recoveryKey, newPassphrase) {
      const user = requireFullUser(ctx)
      const record = getRecord(user.id)
      checkThrottle(user)
      const key = crypto.unwrapWithRecoveryKey(record, recoveryKey)
      if (!key) return failed(user, 'recovery_key')
      try {
        const normal = await checkPassphrase(newPassphrase)
        const pass = await crypto.rewrapPassphrase(user.id, key, normal, deps.settings().argon2Vault)
        const rec = crypto.rewrapRecovery(user.id, key)
        // Both wraps in one write: the old recovery key stops working together with the old passphrase.
        store.setVault({ ...record, ...pass, ...rec.fields, updatedAt: now() })
        sessions.setVaultKey(ctx.idHash, key)
        audit('vault.recovery_key', { actor: user.id, outcome: 'ok', reason: 'used' })
        return { recoveryKey: rec.recoveryKey }
      } catch (error) {
        key.fill(0)
        throw error
      }
    },

    regenerateRecoveryKey(ctx) {
      const user = requireFullUser(ctx)
      const record = getRecord(user.id)
      const key = requireKey(ctx, user)
      const rec = crypto.rewrapRecovery(user.id, key)
      store.setVault({ ...record, ...rec.fields, updatedAt: now() })
      audit('vault.recovery_key', { actor: user.id, outcome: 'ok', reason: 'regenerated' })
      return { recoveryKey: rec.recoveryKey }
    },

    async rotateKey(ctx, passphrase) {
      const user = requireFullUser(ctx)
      const record = getRecord(user.id)
      const oldKey = await proveWithPassphrase(user, record, passphrase)
      const fresh = await crypto.create(user.id, normalisePassword(passphrase), deps.settings().argon2Vault)
      try {
        // Fresh key, fresh wraps from `create`; every profile is re-sealed under it in one transaction.
        store.transaction(() => {
          for (const p of store.listProfiles(user.id)) {
            const secret: ProfileSecret | undefined = crypto.openProfile(oldKey, user.id, p.id, p.sealed)
            if (!secret) throw new Error('profile unreadable under the vault key')
            store.saveProfile({ ...p, sealed: crypto.sealProfile(fresh.vaultKey, user.id, p.id, secret) })
          }
          store.setVault({ ...fresh.record, createdAt: record.createdAt, updatedAt: now() })
        })
      } catch (error) {
        fresh.vaultKey.fill(0)
        throw error
      } finally {
        oldKey.fill(0)
      }
      sessions.setVaultKey(ctx.idHash, fresh.vaultKey)
      audit('vault.rotate', { actor: user.id, outcome: 'ok' })
      return { recoveryKey: fresh.recoveryKey }
    },
  }
}
