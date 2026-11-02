/**
 * Package D (`profiles.ts`, FR-AUT-022): personal connection profiles. Name, host, port, TLS flag and options are
 * plain (Q10); target user, password and client key are sealed under the vault key (AAD binds record to owner).
 * Secrets never leave the server: `ProfileInfo` has the user name only while the vault is unlocked.
 */
import { randomUUID } from 'node:crypto'
import { audit } from '../audit'
import { LOGIN_FAILED } from '../auth'
import type { Config, TlsMode } from '../config'
import { InvalidTargetError, normaliseTarget, type TargetKey } from '../target'
import { peekVaultKey, requireFullUser, type VaultSessions } from './vault'
import {
  AuthError,
  MAX_PROFILES_PER_USER,
  type AccountContext,
  type AccountStore,
  type AuthErrorBody,
  type ProfileId,
  type ProfileInfo,
  type ProfileOptions,
  type ProfileRecord,
  type ProfileSecret,
  type ProfileService,
  type ResolvedAuthSettings,
  type SaveProfileInput,
  type TargetConnectRules,
  type VaultCrypto,
} from './types'

export type ProfileSettings = Pick<ResolvedAuthSettings, 'personalProfiles' | 'allowEmptyTargetPassword' | 'denyRootTarget'>

/** What the connection test needs; implemented by `connections.ts` (same rules as a real connect, FR-AUT-020). */
export type ProfileConnectTest = (
  req: { userId: string; target: TargetKey; password: string; tls: TlsMode; options: ProfileOptions; clientKey?: string },
) => Promise<void>

export type ProfileDeps = {
  store: AccountStore
  sessions: VaultSessions
  crypto: VaultCrypto
  settings: () => ProfileSettings
  config: Pick<Config, 'tls'>
  rules: Pick<TargetConnectRules, 'checkPolicy'>
  test: ProfileConnectTest
  now?: () => number
  newId?: () => string
}

export type ProfileServiceImpl = ProfileService

const TLS_STRICTNESS: Record<TlsMode, number> = { off: 0, 'skip-verify': 1, verify: 2 }
/** `.env` is the floor: a profile may be stricter, never weaker (FR-AUT-022). */
export const clampTls = (requested: TlsMode, envMode: TlsMode): TlsMode =>
  TLS_STRICTNESS[requested] >= TLS_STRICTNESS[envMode] ? requested : envMode

const PEM = /^\s*-----BEGIN [A-Z0-9 ]+-----[A-Za-z0-9+/=\s]+-----END [A-Z0-9 ]+-----\s*$/
const badInput = (message: string) => new AuthError('profile_test_failed', { targetMessage: message })

/** Host as stored: the normalised host name or address, zone kept (`fe80::1%eth0`). */
const hostOf = (target: TargetKey) => `${target.host}${target.zone ?? ''}`

export function createProfileService(deps: ProfileDeps): ProfileServiceImpl {
  const { store, sessions, crypto } = deps
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID

  const requireEnabled = () => {
    if (!deps.settings().personalProfiles) throw new AuthError('vault_absent')
  }
  const peek = (idHash: string) => peekVaultKey(sessions, idHash, now())
  const requireKey = (ctx: AccountContext, userId: string): Buffer => {
    const key = sessions.getVaultKey(ctx.idHash, now())
    if (key) return key
    throw new AuthError(store.getVault(userId) ? 'vault_locked' : 'vault_absent')
  }
  const info = (p: ProfileRecord, secret?: ProfileSecret): ProfileInfo => {
    const rest: Omit<ProfileRecord, 'userId' | 'sealed'> & { userId?: string; sealed?: string } = { ...p }
    delete rest.userId
    delete rest.sealed
    return secret ? { ...rest, targetUser: secret.user, hasClientKey: !!secret.clientKey } : rest
  }

  /** Validates the input and builds what a save or test needs. Throws before any network contact. */
  const prepare = (ctx: AccountContext, input: SaveProfileInput) => {
    const user = requireFullUser(ctx)
    requireEnabled()
    const key = requireKey(ctx, user.id)
    const existing = input.id ? store.getProfile(user.id, input.id) : undefined
    if (input.id && !existing) throw new AuthError('connection_unknown')
    let old: ProfileSecret | undefined
    if (existing) {
      old = crypto.openProfile(key, user.id, existing.id, existing.sealed)
      if (!old) throw new AuthError('vault_locked') // sealed under another key (rotated elsewhere)
    }
    const c = input.credentials
    const secret: ProfileSecret | undefined = c
      ? {
          user: c.user,
          password: c.password ?? old?.password ?? '',
          ...(c.clientKeyPem === '' ? {} : c.clientKeyPem !== undefined ? { clientKey: c.clientKeyPem } : old?.clientKey ? { clientKey: old.clientKey } : {}),
        }
      : old
    if (!secret) throw badInput('User name and password are required.')
    for (const pem of [input.options.caPem, input.options.clientCertPem, secret.clientKey]) {
      if (pem && !PEM.test(pem)) throw badInput('A certificate or key is not valid PEM text.')
    }
    if (!!input.options.clientCertPem !== !!secret.clientKey) throw badInput('Client certificate and client key go together.')
    let target: TargetKey
    try {
      target = normaliseTarget(input.host, input.port, secret.user)
    } catch (error) {
      if (error instanceof InvalidTargetError) throw badInput(LOGIN_FAILED)
      throw error
    }
    // Policy refusals name their reason and are not bypassed by "save anyway" (FR-SAU-004).
    const { allowEmptyTargetPassword, denyRootTarget } = deps.settings()
    deps.rules.checkPolicy(target, secret.password, { allowEmptyTargetPassword, denyRootTarget })
    const tls = clampTls(input.tls, deps.config.tls)
    return { user, key, existing, secret, target, tls, options: input.options as ProfileOptions }
  }

  const runTest = async (userId: string, p: ReturnType<typeof prepare>): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      await deps.test({ userId, target: p.target, password: p.secret.password, tls: p.tls, options: p.options, clientKey: p.secret.clientKey })
      return { ok: true }
    } catch (error) {
      // Throttle and policy refusals are not "the server said no".
      if (error instanceof AuthError) throw error
      return { ok: false, message: LOGIN_FAILED }
    }
  }

  const sameConnection = (e: ProfileRecord, host: string, input: SaveProfileInput, tls: TlsMode) =>
    e.host === host && e.port === input.port && e.tls === tls && JSON.stringify(e.options) === JSON.stringify(input.options)

  return {
    list(ctx) {
      const user = requireFullUser(ctx)
      const key = peek(ctx.idHash)
      return store.listProfiles(user.id).map((p) => info(p, key ? crypto.openProfile(key, user.id, p.id, p.sealed) : undefined))
    },

    async save(ctx, input) {
      const p = prepare(ctx, input)
      const { user, key, existing, secret } = p
      const host = hostOf(p.target)
      let test: 'ok' | 'failed' | 'skipped' = 'skipped'
      if (!(existing && !input.credentials && sameConnection(existing, host, input, p.tls))) {
        const result = await runTest(user.id, p)
        if (result.ok) test = 'ok'
        else if (input.saveAnyway) test = 'failed'
        else throw new AuthError('profile_test_failed', { targetMessage: result.message })
      }
      const id = existing?.id ?? newId()
      const at = now()
      const record: ProfileRecord = {
        id, userId: user.id, name: input.name, host, port: p.target.port, tls: p.tls, options: p.options,
        sealed: crypto.sealProfile(key, user.id, id, secret), createdAt: existing?.createdAt ?? at, updatedAt: at, lastUsedAt: existing?.lastUsedAt ?? null,
      }
      store.transaction(() => {
        // Re-checked inside the transaction: two saves of one name end in one refusal, not a raw UNIQUE error.
        const clash = store.listProfiles(user.id).some((o) => o.id !== id && o.name.toLowerCase() === input.name.toLowerCase())
        if (clash) throw new AuthError('profile_name_taken')
        if (!existing && store.countProfiles(user.id) >= MAX_PROFILES_PER_USER) throw new AuthError('profile_limit')
        store.saveProfile(record)
      })
      audit('profile.save', { actor: user.id, subject: id, outcome: 'ok', host, port: p.target.port, reason: test })
      return { profile: info(record, secret), test }
    },

    async test(ctx, input) {
      let p: ReturnType<typeof prepare>
      try {
        p = prepare(ctx, input)
      } catch (error) {
        if (error instanceof AuthError && (error.code === 'profile_test_failed' || error.code === 'target_policy')) {
          return { ok: false, error: { code: error.code, ...error.detail } satisfies AuthErrorBody }
        }
        throw error
      }
      const result = await runTest(p.user.id, p)
      return result.ok ? { ok: true } : { ok: false, error: { code: 'profile_test_failed', targetMessage: result.message } }
    },

    delete(ctx, id: ProfileId) {
      const user = requireFullUser(ctx)
      if (!store.deleteProfile(user.id, id)) throw new AuthError('connection_unknown')
      audit('profile.delete', { actor: user.id, subject: id, outcome: 'ok' })
    },

    secretFor(ctx, id) {
      const user = requireFullUser(ctx)
      requireEnabled()
      const profile = store.getProfile(user.id, id)
      if (!profile) throw new AuthError('connection_unknown')
      const key = requireKey(ctx, user.id)
      const secret = crypto.openProfile(key, user.id, id, profile.sealed)
      if (!secret) throw new AuthError('vault_locked')
      return { profile, secret }
    },
  }
}
