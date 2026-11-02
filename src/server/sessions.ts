import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from './config'
import type { TargetPool } from './db/target-pool'
import { cellHandles, uploads } from './rows/blob'
import { runRegistry } from './sql/registry'
import { memorySqlState } from './sql/state'
import type { Store } from './store/store'
import { planStore } from './structure/plans'
import type { TargetKey } from './target'
import {
  ADMIN_SESSION_ABSOLUTE_DEFAULT_MS,
  ADMIN_SESSION_IDLE_DEFAULT_MS,
  AUTH_SETTINGS,
  type AccountContext,
  type AccountLiveSession,
  type AccountStore,
  type ConnectionEntry,
  type ResolvedAuthSettings,
  type Role,
  type SessionInfo,
  SCOPE_KEY_SEPARATOR,
  type SessionState,
  type StoreWithAccounts,
  type User,
} from './auth/types'

/** The settings the session manager reads: limits (ST-069 to 071) and the vault auto-lock (ST-089). */
export type SessionSettings = Pick<ResolvedAuthSettings, 'sessionsPerUser' | 'sessionsPerAdmin' | 'adminSessionIdleMs' | 'adminSessionAbsoluteMs' | 'vaultAutoLockMs'>
const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  sessionsPerUser: AUTH_SETTINGS.sessionsPerUser.default,
  sessionsPerAdmin: AUTH_SETTINGS.sessionsPerAdmin.default,
  adminSessionIdleMs: ADMIN_SESSION_IDLE_DEFAULT_MS,
  adminSessionAbsoluteMs: ADMIN_SESSION_ABSOLUTE_DEFAULT_MS,
  vaultAutoLockMs: AUTH_SETTINGS.vaultAutoLockMs.default,
}

/** Per user, sessions in `pending_mfa` (password proven, second factor open). */
export const MAX_PENDING_MFA_SESSIONS = 5

export type LiveSession = {
  /**
   * Scope key of the per-session registries (plans, cell handles, uploads, SQL runs, io jobs): the session id hash in
   * direct mode, `idHash/connectionId` in account mode (FR-AUT-018; `session-context.ts` fills it).
   */
  idHash: string
  csrf: string
  target: TargetKey
  pool: TargetPool
  readOnly: boolean
  /** Account mode: `u:<user id>`. Absent in direct mode (owner key by target) and stateless mode (id hash). */
  ownerKey?: string
}

/** Scope key of one connection of an account session; direct sessions use the id hash itself. */
export const scopeKeyOf = (idHash: string, connectionId?: string): string =>
  connectionId ? `${idHash}${SCOPE_KEY_SEPARATOR}${connectionId}` : idHash

/** Live part of a session. Account sessions have no pool of their own: they hold connections (FR-AUT-018) and a vault key. */
type Runtime = {
  csrf: string
  target: TargetKey
  pool?: TargetPool
  readOnly: boolean
  connections?: Map<string, ConnectionEntry>
  vaultKey?: Buffer
  /** Last vault use; the key is dropped ST-089 minutes after it (FR-AUT-021). */
  vaultSeenAt?: number
}
const NO_TARGET: TargetKey = { host: '', port: 0, username: '' }

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Session metadata lives in the store; the target credentials (inside the pool) live in process
 * memory only, so a restart ends every direct-mode session (DEP-TGT-125, G10).
 */
export class SessionManager {
  private live = new Map<string, Runtime>()
  private endHooks: Array<(idHash: string) => void> = []

  /** Runs after a session ended (row gone, pools closed); stateless mode drops its in-memory preferences here. */
  onEnd(hook: (idHash: string) => void): void {
    this.endHooks.push(hook)
  }

  constructor(
    private store: Store,
    private config: Pick<Config, 'sessionIdleMs' | 'sessionAbsoluteMs'>,
    private now: () => number = Date.now,
    private settings: () => SessionSettings = () => DEFAULT_SESSION_SETTINGS,
  ) {}

  /** Account tables; only a store that went through migration 5 has them, direct mode never calls this. */
  private get accounts(): AccountStore {
    const accounts = (this.store as Partial<StoreWithAccounts>).accounts
    if (!accounts) throw new Error('account store unavailable')
    return accounts
  }

  /** Idle and absolute limits of a role: the administrator values (ST-069, ST-070) or the Config ones. */
  private limits(role: Role): { idleMs: number; absoluteMs: number } {
    if (role !== 'admin') return { idleMs: this.config.sessionIdleMs, absoluteMs: this.config.sessionAbsoluteMs }
    const { adminSessionIdleMs, adminSessionAbsoluteMs } = this.settings()
    return { idleMs: adminSessionIdleMs, absoluteMs: adminSessionAbsoluteMs }
  }

  create(target: TargetKey, pool: TargetPool): { token: string; csrf: string } {
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(32).toString('base64url')
    const now = this.now()
    const idHash = hash(token)
    this.store.createSession({
      idHash,
      targetKey: `${target.host}${target.zone ?? ''}:${target.port}`,
      userName: target.username,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionAbsoluteMs,
    })
    this.live.set(idHash, { csrf, target, pool, readOnly: false })
    return { token, csrf }
  }

  /** Returns the live session, or `undefined` for every kind of invalid one (G10). */
  resolve(token: string | undefined): LiveSession | undefined {
    if (!token) return undefined
    const idHash = hash(token)
    const record = this.store.getSession(idHash)
    const runtime = this.live.get(idHash)
    if (!record || !runtime?.pool) {
      void this.end(idHash)
      return undefined
    }
    const now = this.now()
    if (now >= record.expiresAt || now - record.lastSeenAt >= this.config.sessionIdleMs) {
      void this.end(idHash)
      return undefined
    }
    this.store.touchSession(idHash, now)
    return { idHash, csrf: runtime.csrf, target: runtime.target, pool: runtime.pool, readOnly: runtime.readOnly }
  }

  setReadOnly(idHash: string, value: boolean): void {
    const runtime = this.live.get(idHash)
    if (runtime) runtime.readOnly = value
  }

  verifyCsrf(session: { csrf: string }, presented: string | undefined): boolean {
    if (!presented) return false
    const a = Buffer.from(session.csrf)
    const b = Buffer.from(presented)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async destroy(token: string | undefined): Promise<void> {
    if (token) await this.end(hash(token))
  }

  private async end(idHash: string): Promise<void> {
    const runtime = this.live.get(idHash)
    this.live.delete(idHash)
    this.store.deleteSession(idHash)
    planStore.dropSession(idHash)
    cellHandles.dropSession(idHash)
    uploads.dropSession(idHash)
    // Running SQL of this session is stopped while the pool can still send KILL QUERY; the in-memory
    // history and bookmarks of stateless mode (owner key = session id hash) go with the session.
    if (runtime?.pool) await runRegistry.cancelSession(runtime.pool, idHash).catch(() => undefined)
    memorySqlState.dropOwner(idHash)
    await runtime?.pool?.end().catch(() => undefined)
    // Account sessions: close every connection pool and wipe the vault key (best effort in a GC runtime).
    runtime?.vaultKey?.fill(0)
    // Per-connection registries are keyed by the scope key; their runs stop while the pool can still send KILL QUERY.
    for (const entry of runtime?.connections?.values() ?? []) {
      const scope = scopeKeyOf(idHash, entry.connectionId)
      planStore.dropSession(scope)
      cellHandles.dropSession(scope)
      uploads.dropSession(scope)
      await runRegistry.cancelSession(entry.pool, scope).catch(() => undefined)
      await entry.pool.end().catch(() => undefined)
    }
    runtime?.connections?.clear()
    for (const hook of this.endHooks) {
      try {
        hook(idHash)
      } catch {
        // a failing hook never keeps a session alive
      }
    }
  }

  async sweep(): Promise<void> {
    const now = this.now()
    for (const [idHash] of this.live) {
      const record = this.store.getSession(idHash)
      if (
        !record ||
        now >= record.expiresAt ||
        now - record.lastSeenAt >= this.config.sessionIdleMs
      ) {
        await this.end(idHash)
      }
    }
    this.store.purgeSessions(now)
  }

  createAccount(user: User, state: SessionState, meta: { clientHint: string; address: string }): { token: string; csrf: string; evicted: string[] } {
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(32).toString('base64url')
    const now = this.now()
    const idHash = hash(token)
    const settings = this.settings()
    const limit = user.role === 'admin' ? settings.sessionsPerAdmin : settings.sessionsPerUser
    const { absoluteMs } = this.limits(user.role)
    const accounts = this.accounts
    const all = accounts.listUserSessions(user.id).sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    // Half-signed-in sessions (password only) are capped on their own and never count against or evict real ones.
    const pending = all.filter((r) => r.state === 'pending_mfa')
    const existing = all.filter((r) => r.state !== 'pending_mfa')
    const evicted = state === 'pending_mfa'
      ? pending.slice(0, Math.max(0, pending.length - MAX_PENDING_MFA_SESSIONS + 1)).map((r) => r.idHash)
      : existing.slice(0, Math.max(0, existing.length - limit + 1)).map((r) => r.idHash)
    // `end` removes the row and the live entry and closes pools; it touches only the evicted session.
    for (const id of evicted) void this.end(id)
    const base = { idHash, targetKey: '', userName: '', createdAt: now, lastSeenAt: now, expiresAt: now + absoluteMs }
    this.store.createSession(base)
    accounts.createAccountSession({ ...base, kind: 'account', userId: user.id, state, mfaAt: null, stepupAt: null, securityVersion: user.securityVersion, clientHint: meta.clientHint, address: meta.address })
    this.live.set(idHash, { csrf, target: NO_TARGET, readOnly: false })
    return { token, csrf, evicted }
  }

  resolveAccount(token: string | undefined, opts: { background: boolean }): AccountContext | undefined {
    if (!token) return undefined
    const idHash = hash(token)
    const accounts = this.accounts
    const row = accounts.getAccountSession(idHash)
    if (!row || row.kind !== 'account' || !row.userId) return undefined
    const user = accounts.getUser(row.userId)
    const now = this.now()
    const idleMs = user ? this.limits(user.role).idleMs : 0
    if (!user || user.status !== 'active' || user.securityVersion !== row.securityVersion || now >= row.expiresAt || now - row.lastSeenAt >= idleMs) {
      void this.end(idHash)
      return undefined
    }
    if (!opts.background) accounts.updateAccountSession(idHash, { lastSeenAt: now })
    const runtime = this.live.get(idHash)
    return {
      idHash, csrf: runtime?.csrf ?? '', kind: 'account', state: row.state,
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, securityVersion: user.securityVersion },
      ownerKey: `u:${user.id}`, mfaAt: row.mfaAt, stepupAt: row.stepupAt,
    }
  }

  /**
   * New token for the same session (SEC-TGT-040). A session that stops being half-signed-in (`pending_mfa` to anything
   * else) starts to count against the user's limit (ST-071): the oldest others are ended and returned (FR-AUT-017).
   */
  transition(token: string, patch: { state?: SessionState; mfaAt?: number; stepupAt?: number }): { token: string; evicted: string[] } {
    const old = hash(token)
    const next = randomBytes(32).toString('base64url')
    const accounts = this.accounts
    const before = accounts.getAccountSession(old)
    accounts.updateAccountSession(old, patch)
    accounts.renameSession(old, hash(next))
    const runtime = this.live.get(old)
    if (runtime) {
      this.live.delete(old)
      this.live.set(hash(next), runtime)
    }
    let evicted: string[] = []
    const user = before?.userId ? accounts.getUser(before.userId) : undefined
    if (user && before?.state === 'pending_mfa' && patch.state && patch.state !== 'pending_mfa') {
      const limit = user.role === 'admin' ? this.settings().sessionsPerAdmin : this.settings().sessionsPerUser
      const others = accounts
        .listUserSessions(user.id)
        .filter((r) => r.state !== 'pending_mfa' && r.idHash !== hash(next))
        .sort((x, y) => x.lastSeenAt - y.lastSeenAt)
      evicted = others.slice(0, Math.max(0, others.length - limit + 1)).map((r) => r.idHash)
      for (const id of evicted) void this.end(id)
    }
    return { token: next, evicted }
  }

  addConnection(idHash: string, entry: ConnectionEntry) {
    const runtime = this.live.get(idHash)
    if (!runtime) return
    runtime.connections ??= new Map()
    runtime.connections.set(entry.connectionId, entry)
  }

  getConnection(idHash: string, connectionId: string): ConnectionEntry | undefined {
    return this.live.get(idHash)?.connections?.get(connectionId)
  }

  listConnections(idHash: string): ConnectionEntry[] {
    return [...(this.live.get(idHash)?.connections?.values() ?? [])]
  }

  async closeConnection(idHash: string, connectionId: string) {
    const entry = this.getConnection(idHash, connectionId)
    if (!entry) return false
    await entry.pool.end().catch(() => undefined)
    this.live.get(idHash)?.connections?.delete(connectionId)
    return true
  }

  resolveTarget(token: string | undefined, connectionId: string | undefined, opts: { background: boolean }): AccountLiveSession | undefined {
    const context = this.resolveAccount(token, opts)
    if (!context) return undefined
    const entry = connectionId ? this.getConnection(context.idHash, connectionId) : undefined
    if (!entry) return undefined
    // Only a fully signed-in session reaches a target (STATE_ALLOWED_FUNCTIONS has no target function).
    if (context.state !== 'full') return undefined
    return { ...context, target: entry.target, pool: entry.pool, readOnly: entry.readOnly, connectionId: entry.connectionId, scopeKey: scopeKeyOf(context.idHash, entry.connectionId) }
  }

  setVaultKey(idHash: string, key: Buffer | undefined) {
    const runtime = this.live.get(idHash)
    if (!runtime) return
    runtime.vaultKey?.fill(0)
    runtime.vaultKey = key
    runtime.vaultSeenAt = key ? this.now() : undefined
  }

  /**
   * Returns the key and counts as vault activity. The key lives ST-089 minutes after the last use (default 15), at most
   * as long as the user's session idle limit; an expired key is zeroed and dropped (FR-AUT-021).
   */
  getVaultKey(idHash: string, now: number): Buffer | undefined {
    const key = this.peekVaultKey(idHash, now)
    if (key) this.live.get(idHash)!.vaultSeenAt = now
    return key
  }

  /** Same expiry as `getVaultKey` (expired key is dropped) but leaves the activity time alone. */
  peekVaultKey(idHash: string, now: number): Buffer | undefined {
    const runtime = this.live.get(idHash)
    const key = runtime?.vaultKey
    if (!runtime || !key) return undefined
    if (now >= this.vaultLockAtOf(idHash, runtime)) {
      this.setVaultKey(idHash, undefined)
      return undefined
    }
    return key
  }

  vaultLockAt(idHash: string): number | undefined {
    const runtime = this.live.get(idHash)
    return runtime?.vaultKey ? this.vaultLockAtOf(idHash, runtime) : undefined
  }

  private vaultLockAtOf(idHash: string, runtime: Runtime): number {
    return (runtime.vaultSeenAt ?? 0) + Math.min(this.settings().vaultAutoLockMs, this.idleMsOf(idHash))
  }

  /** Idle limit of the user who owns the session; the Config one when the row or user is gone. */
  private idleMsOf(idHash: string): number {
    const userId = this.accounts.getAccountSession(idHash)?.userId
    const user = userId ? this.accounts.getUser(userId) : undefined
    return user ? this.limits(user.role).idleMs : this.config.sessionIdleMs
  }

  listUserSessions(userId: string, currentIdHash: string): SessionInfo[] {
    // Half-signed-in sessions (password proven, factor open) are not the user's sessions yet (FR-AUT-017).
    return this.accounts.listUserSessions(userId).filter((r) => r.state !== 'pending_mfa').map((r) => ({ ref: r.idHash, clientHint: r.clientHint, address: r.address, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.idHash === currentIdHash }))
  }

  async endSession(idHash: string): Promise<void> {
    await this.end(idHash)
  }
}
