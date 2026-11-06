/**
 * Package D (`connections.ts`, FR-AUT-018 to 020): connect rules, per-session connections, held credentials.
 *
 * The connection map itself lives in the session runtime (`AccountSessions.addConnection` ...); this module opens
 * the pools. A typed credential stays in session memory as a property of the `ConnectionEntry` object, so it
 * dies with the session without a hook. A profile connection holds no password: a reconnect (G5) reads the unlocked
 * vault again (`vault_locked` otherwise).
 */
import { randomBytes } from 'node:crypto'
import { audit } from '../audit'
import { LoginFailedError } from '../auth'
import type { Config, TlsMode } from '../config'
import { openTargetPool, type TargetPool, type TargetPoolExtras } from '../db/target-pool'
import { quoteIdent } from '../db/identifiers'
import { resolveAllowedAddress } from '../host-policy'
import { cellHandles, uploads } from '../rows/blob'
import { runRegistry } from '../sql/registry'
import { planStore } from '../structure/plans'
import { normaliseTarget, type TargetKey } from '../target'
import { clampTls, createProfileService, type ProfileServiceImpl } from './profiles'
import { createVaultService, peekVaultKey, requireFullUser, type VaultServiceImpl, type VaultSessions } from './vault'
import { vaultCryptoService } from './vault-crypto'
import {
  AuthError,
  type TargetTlsReason,
  CONNECTION_ID_BYTES,
  MAX_CONNECTIONS_PER_SESSION,
  SCOPE_KEY_SEPARATOR,
  type AccountContext,
  type AccountLiveSession,
  type AccountSessions,
  type AccountStore,
  type BreachedList,
  type ConnectionEntry,
  type ConnectionInfo,
  type ConnectionService,
  type OpenConnectionInput,
  type ProfileOptions,
  type ResolvedAuthSettings,
  type TargetConnectRules,
  type Throttle,
  type VaultCrypto,
} from './types'

// ---- Connect rules (FR-AUT-020) -----------------------------------------------------------------------------

export type AfterConnectOptions = { collation?: string | null; activateRoles?: boolean; database?: string | null }
export type AfterConnectResult = {
  database: string | null
  /** Collation actually applied (null = none asked, or unknown to the server and skipped). */
  collation: string | null
  /** `skipped_mariadb`: MariaDB has no `SET ROLE ALL`; its default roles are active at login (owner decision 15.3). */
  roles: 'off' | 'applied' | 'skipped_mariadb'
}

const COLLATION_NAME = /^[A-Za-z0-9_]{1,64}$/

type RawConnection = { query(sql: string, values: unknown[], cb: (error: Error | null) => void): void }

/**
 * Session settings of a pool. `collation_connection`, the default database and active roles belong to one
 * connection, not the pool, so they are applied to every connection the pool opens from now on (event
 * `connection`) and to the one in hand; the idle connection from the first `SELECT 1` is replaced.
 */
async function applyToPool(pool: TargetPool, statements: Array<[string, unknown[]]>): Promise<void> {
  pool.on('connection', ((raw: RawConnection) => {
    for (const [sql, values] of statements) raw.query(sql, values, () => undefined)
  }) as never)
  const stale = await pool.getConnection()
  stale.destroy()
  const fresh = await pool.getConnection()
  try {
    for (const [sql, values] of statements) await fresh.query(sql, values) // surfaces a failure now
  } finally {
    fresh.release()
  }
}

export type ConnectRules = Pick<TargetConnectRules, 'checkPolicy'> & {
  afterConnect(pool: TargetPool, opts: AfterConnectOptions): Promise<AfterConnectResult>
}

export function createTargetConnectRules(): ConnectRules {
  return {
    checkPolicy(target, password, settings) {
      if (settings.denyRootTarget && target.username.toLowerCase() === 'root') throw new AuthError('target_policy', { reason: 'root_denied' })
      if (!settings.allowEmptyTargetPassword && password === '') throw new AuthError('target_policy', { reason: 'empty_password' })
    },

    async afterConnect(pool, opts) {
      const statements: Array<[string, unknown[]]> = []
      const result: AfterConnectResult = { database: null, collation: null, roles: 'off' }
      if (opts.collation && COLLATION_NAME.test(opts.collation)) {
        const [rows] = await pool.query('SHOW COLLATION WHERE Collation = ?', [opts.collation])
        if ((rows as unknown[]).length > 0) {
          result.collation = opts.collation
          statements.push(['SET collation_connection = ?', [opts.collation]])
        }
      }
      if (opts.database) {
        const [rows] = await pool.query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [opts.database])
        if ((rows as unknown[]).length > 0) {
          result.database = opts.database
          statements.push([`USE ${quoteIdent(opts.database)}`, []])
        }
      }
      if (opts.activateRoles) {
        const [rows] = await pool.query('SELECT VERSION() AS v')
        const version = String((rows as Array<{ v?: unknown }>)[0]?.v ?? '')
        if (/mariadb/i.test(version)) result.roles = 'skipped_mariadb'
        else {
          result.roles = 'applied'
          statements.push(['SET ROLE ALL', []])
        }
      }
      if (statements.length > 0) await applyToPool(pool, statements)
      return result
    },
  }
}

// ---- Connector: policy, throttle, host policy, pool, post-connect ---------------------------------------------

export type ConnectRequest = {
  userId: string
  target: TargetKey
  password: string
  tls: TlsMode
  options: Pick<ProfileOptions, 'compress' | 'caPem' | 'clientCertPem' | 'activateRoles'> & { database?: string | null; collation?: string | null }
  clientKey?: string
}

export type ConnectorDeps = {
  config: Config
  throttle: Throttle
  settings: () => Pick<ResolvedAuthSettings, 'allowEmptyTargetPassword' | 'denyRootTarget'>
  rules?: ConnectRules
  openPool?: typeof openTargetPool
  resolveAddress?: typeof resolveAllowedAddress
}

export type Connector = {
  /** Policy, throttle, host policy, pool and post-connect. Throws `AuthError` for policy and throttle, anything else for a failed connect. */
  connect(req: ConnectRequest): Promise<{ pool: TargetPool; result: AfterConnectResult }>
  /** Same rules, then the pool is closed again. */
  test(req: ConnectRequest): Promise<void>
}

export function createConnector(deps: ConnectorDeps): Connector {
  const rules = deps.rules ?? createTargetConnectRules()
  const openPool = deps.openPool ?? openTargetPool
  const resolveAddress = deps.resolveAddress ?? resolveAllowedAddress
  const throttleKey = (req: ConnectRequest) => `tgt:${req.userId}:${req.target.host}${req.target.zone ?? ''}:${req.target.port}:${req.target.username}` as const

  const connect: Connector['connect'] = async (req) => {
    // Before any network contact (FR-AUT-020).
    const { allowEmptyTargetPassword, denyRootTarget } = deps.settings()
    rules.checkPolicy(req.target, req.password, { allowEmptyTargetPassword, denyRootTarget })
    const key = throttleKey(req)
    const delay = deps.throttle.delayMs(key)
    if (delay > 0) throw new AuthError('auth_throttled', { retryAfterSeconds: Math.ceil(delay / 1000) })
    let pool: TargetPool | undefined
    try {
      const address = await resolveAddress(req.target, deps.config)
      const extras: TargetPoolExtras = {
        tls: clampTls(req.tls, deps.config.tls),
        compress: req.options.compress,
        ...(req.options.caPem ? { ca: req.options.caPem } : {}),
        ...(req.options.clientCertPem ? { cert: req.options.clientCertPem } : {}),
        ...(req.clientKey ? { key: req.clientKey } : {}),
      }
      pool = await openPool(req.target, address, req.password, deps.config, extras)
      const result = await rules.afterConnect(pool, {
        collation: req.options.collation,
        database: req.options.database,
        activateRoles: req.options.activateRoles,
      })
      deps.throttle.reset(key)
      return { pool, result }
    } catch (error) {
      await pool?.end().catch(() => undefined)
      deps.throttle.fail(key)
      throw error
    }
  }

  return {
    connect,
    async test(req) {
      const { pool } = await connect(req)
      await pool.end().catch(() => undefined)
    },
  }
}

// ---- Connection service ---------------------------------------------------------------------------------------

/** Non-secret reopen parameters; the typed password is the only secret and lives only here (session memory). */
type Held = {
  tls: TlsMode
  password?: string
  options: ConnectRequest['options']
}
type HeldEntry = ConnectionEntry & { held: Held; label?: string; userId: string }

export type ConnectionSessions = Pick<AccountSessions, 'addConnection' | 'getConnection' | 'listConnections' | 'closeConnection'> & VaultSessions

export type ConnectionDeps = {
  sessions: ConnectionSessions
  store: AccountStore
  profiles: ProfileServiceImpl
  connector: Connector
  /** The user's saved default collation (FR-CFG-018, preference `collation`). */
  userCollation?: (ownerKey: string) => string | null | undefined
  /** Registries of the scope (plans, handles, uploads, runs) go with the connection; overridable for tests. */
  onClose?: (scopeKey: string, pool: TargetPool) => Promise<void>
  now?: () => number
}

const defaultOnClose = async (scopeKey: string, pool: TargetPool) => {
  await runRegistry.cancelSession(pool, scopeKey).catch(() => undefined)
  planStore.dropSession(scopeKey)
  cellHandles.dropSession(scopeKey)
  uploads.dropSession(scopeKey)
}

const asContext = (s: AccountLiveSession): AccountContext => ({
  idHash: s.idHash, csrf: s.csrf, kind: s.kind, state: 'full', user: s.user, ownerKey: s.user ? `u:${s.user.id}` : s.idHash, mfaAt: null, stepupAt: null,
})

const TLS_CODES: Record<string, TargetTlsReason> = {
  SELF_SIGNED_CERT_IN_CHAIN: 'untrusted_ca', DEPTH_ZERO_SELF_SIGNED_CERT: 'untrusted_ca', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'untrusted_ca',
  UNABLE_TO_GET_ISSUER_CERT: 'untrusted_ca', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'untrusted_ca', CERT_UNTRUSTED: 'untrusted_ca',
  ERR_TLS_CERT_ALTNAME_INVALID: 'hostname_mismatch', CERT_HAS_EXPIRED: 'cert_expired', CERT_NOT_YET_VALID: 'cert_not_yet_valid',
  EPROTO: 'handshake_failed', ERR_TLS_HANDSHAKE_TIMEOUT: 'handshake_failed', ERR_SSL_WRONG_VERSION_NUMBER: 'handshake_failed',
  ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: 'handshake_failed', ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: 'handshake_failed',
}

/** Fixed TLS reason category of a failed connect (SEC-ISS-001); undefined for every other failure. Reads only the error code, never the text. */
export function tlsReasonOf(error: unknown): TargetTlsReason | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && Object.hasOwn(TLS_CODES, code)) return TLS_CODES[code]
  }
  return undefined
}

/**
 * Account mode: policy and throttle refusals keep their code, a TLS failure names a fixed reason category (`target_tls`), every
 * other failure is the one generic message (SEC-TGT-018). Direct mode (`DirectAuth.login`) stays uniform and never calls this.
 */
const generic = (error: unknown): never => {
  if (error instanceof AuthError) throw error
  const reason = tlsReasonOf(error)
  if (reason) throw new AuthError('target_tls', { reason })
  throw new LoginFailedError()
}

export function createConnectionService(deps: ConnectionDeps): ConnectionService {
  const { sessions, store, profiles, connector } = deps
  const now = deps.now ?? Date.now
  const onClose = deps.onClose ?? defaultOnClose
  const inflight = new Map<string, Promise<TargetPool>>()

  const infoOf = (e: ConnectionEntry): ConnectionInfo => ({
    connectionId: e.connectionId, host: `${e.target.host}${e.target.zone ?? ''}`, port: e.target.port, targetUser: e.target.username,
    source: e.source, ...(e.profileId ? { profileId: e.profileId } : {}), ...((e as Partial<HeldEntry>).label ? { label: (e as HeldEntry).label } : {}),
    readOnly: e.readOnly, openedAt: e.openedAt,
  })

  /** Reopen request of an existing entry (typed: held credential; profile: unlocked vault). */
  const requestFor = (entry: HeldEntry, ctx: AccountContext): ConnectRequest => {
    if (entry.source === 'typed') {
      return { userId: entry.userId, target: entry.target, password: entry.held.password ?? '', tls: entry.held.tls, options: entry.held.options }
    }
    const { profile, secret } = profiles.secretFor(ctx, entry.profileId!)
    return {
      userId: entry.userId,
      target: normaliseTarget(profile.host, profile.port, secret.user),
      password: secret.password,
      tls: profile.tls,
      options: { ...entry.held.options, caPem: profile.options.caPem, clientCertPem: profile.options.clientCertPem, compress: profile.options.compress },
      clientKey: secret.clientKey,
    }
  }

  return {
    async open(ctx, input: OpenConnectionInput, meta) {
      const user = requireFullUser(ctx)
      if (sessions.listConnections(ctx.idHash).length >= MAX_CONNECTIONS_PER_SESSION) throw new AuthError('connection_limit')
      let req: ConnectRequest
      let label: string | undefined
      let profileId: string | undefined
      try {
        if (input.source === 'typed') {
          const target = normaliseTarget(input.host, input.port, input.username)
          req = {
            userId: user.id, target, password: input.password, tls: input.tls ?? 'verify',
            options: { compress: false, caPem: null, clientCertPem: null, activateRoles: false, database: input.database ?? null, collation: input.collation ?? deps.userCollation?.(ctx.ownerKey) ?? null },
          }
        } else {
          const { profile, secret } = profiles.secretFor(ctx, input.profileId)
          profileId = profile.id
          label = profile.name
          req = {
            userId: user.id, target: normaliseTarget(profile.host, profile.port, secret.user), password: secret.password, tls: profile.tls,
            // A database named in the request wins over the profile's (FR-ISS-102).
            options: { ...profile.options, database: input.database ?? profile.options.database, collation: profile.options.collation ?? deps.userCollation?.(ctx.ownerKey) ?? null },
            clientKey: secret.clientKey,
          }
        }
      } catch (error) {
        // Vault problems keep their code (the UI asks for the passphrase); a malformed target is the generic failure.
        if (error instanceof AuthError) throw error
        audit('connection.failed', { actor: user.id, outcome: 'failed', reason: 'target' })
        throw new LoginFailedError()
      }
      let opened: Awaited<ReturnType<Connector['connect']>>
      try {
        opened = await connector.connect(req)
      } catch (error) {
        audit('connection.failed', { actor: user.id, outcome: error instanceof AuthError ? 'refused' : 'failed', host: req.target.host, port: req.target.port, targetUser: req.target.username, reason: error instanceof AuthError ? error.code : tlsReasonOf(error) ? `tls_${tlsReasonOf(error)}` : 'connect' })
        return generic(error)
      }
      // The limit is checked again: two parallel opens must not pass the first check together.
      if (sessions.listConnections(ctx.idHash).length >= MAX_CONNECTIONS_PER_SESSION) {
        await opened.pool.end().catch(() => undefined)
        throw new AuthError('connection_limit')
      }
      const entry: HeldEntry = {
        connectionId: randomBytes(CONNECTION_ID_BYTES).toString('base64url'), target: req.target, pool: opened.pool, readOnly: false,
        source: input.source, ...(profileId ? { profileId } : {}), openedAt: now(), userId: user.id, label,
        held: { tls: req.tls, ...(input.source === 'typed' ? { password: req.password } : {}), options: { ...req.options, database: opened.result.database, collation: opened.result.collation } },
      }
      sessions.addConnection(ctx.idHash, entry)
      if (profileId) {
        const p = store.getProfile(user.id, profileId)
        if (p) store.saveProfile({ ...p, lastUsedAt: now() })
      }
      audit('connection.open', { actor: user.id, outcome: 'ok', host: req.target.host, port: req.target.port, targetUser: req.target.username, connectionId: entry.connectionId, reason: input.source, subject: meta.address })
      return infoOf(entry)
    },

    async close(ctx, connectionId) {
      const entry = sessions.getConnection(ctx.idHash, connectionId)
      if (!entry) throw new AuthError('connection_unknown')
      await onClose(`${ctx.idHash}${SCOPE_KEY_SEPARATOR}${connectionId}`, entry.pool)
      await sessions.closeConnection(ctx.idHash, connectionId)
      audit('connection.close', { actor: ctx.user?.id, outcome: 'ok', connectionId })
    },

    list(ctx) {
      return sessions.listConnections(ctx.idHash).map(infoOf)
    },

    reconnect(session) {
      const existing = inflight.get(session.scopeKey)
      if (existing) return existing
      const run = (async () => {
        const entry = sessions.getConnection(session.idHash, session.connectionId) as HeldEntry | undefined
        if (!entry?.held) throw new AuthError('connection_unknown')
        const req = requestFor(entry, asContext(session))
        try {
          const { pool } = await connector.connect(req)
          const old = entry.pool
          entry.pool = pool
          await old.end().catch(() => undefined)
          return pool
        } catch (error) {
          return generic(error)
        }
      })().finally(() => inflight.delete(session.scopeKey))
      inflight.set(session.scopeKey, run)
      return run
    },

    updateHeldCredential(scopeKey, password) {
      const at = scopeKey.indexOf(SCOPE_KEY_SEPARATOR)
      if (at < 0) return { profileUpdateOffered: false }
      const entry = sessions.getConnection(scopeKey.slice(0, at), scopeKey.slice(at + 1)) as HeldEntry | undefined
      if (!entry?.held) return { profileUpdateOffered: false }
      if (entry.source === 'typed') {
        entry.held.password = password
        return { profileUpdateOffered: false }
      }
      // Profile connection: offered only while the vault is unlocked; the UI then saves the profile (`saveProfile`).
      const unlocked = !!peekVaultKey(sessions, scopeKey.slice(0, at), now())
      return { profileUpdateOffered: unlocked }
    },
  }
}

// ---- Wiring helper ---------------------------------------------------------------------------------------------

export type AccountServicesDeps = {
  store: AccountStore
  sessions: ConnectionSessions
  config: Config
  throttle: Throttle
  settings: () => ResolvedAuthSettings
  breached?: BreachedList
  userCollation?: ConnectionDeps['userCollation']
  crypto?: VaultCrypto
  openPool?: typeof openTargetPool
  resolveAddress?: typeof resolveAllowedAddress
  now?: () => number
}
export type AccountServices = {
  vault: VaultServiceImpl
  profiles: ProfileServiceImpl
  connections: ConnectionService
  rules: ConnectRules
  connector: Connector
}

/** One call builds the three services of package D on the same store, sessions, settings and throttle. */
export function createAccountServices(d: AccountServicesDeps): AccountServices {
  const crypto = d.crypto ?? vaultCryptoService
  const rules = createTargetConnectRules()
  const connector = createConnector({ config: d.config, throttle: d.throttle, settings: d.settings, rules, openPool: d.openPool, resolveAddress: d.resolveAddress })
  const vault = createVaultService({ store: d.store, sessions: d.sessions, crypto, throttle: d.throttle, settings: d.settings, breached: d.breached, now: d.now })
  const profiles = createProfileService({ store: d.store, sessions: d.sessions, crypto, settings: d.settings, config: d.config, rules, test: (req) => connector.test({ ...req, options: req.options }), now: d.now })
  const connections = createConnectionService({ sessions: d.sessions, store: d.store, profiles, connector, userCollation: d.userCollation, now: d.now })
  return { vault, profiles, connections, rules, connector }
}

