/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from './config'
import type { TargetPool } from './db/target-pool'
import { cellHandles, uploads } from './rows/blob'
import { runRegistry } from './sql/registry'
import { memorySqlState } from './sql/state'
import type { Store } from './store/store'
import { planStore } from './structure/plans'
import type { TargetKey } from './target'
import type { AccountContext, AccountLiveSession, AccountSessionRecord, ConnectionEntry, SessionInfo, SessionState, User } from './auth/types'

export type LiveSession = {
  idHash: string
  csrf: string
  target: TargetKey
  pool: TargetPool
  readOnly: boolean
}

type Runtime = { csrf: string; target: TargetKey; pool: TargetPool; readOnly: boolean }

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Session metadata lives in the store; the target credentials (inside the pool) live in process
 * memory only, so a restart ends every direct-mode session (DEP-TGT-125, G10).
 */
export class SessionManager {
  private live = new Map<string, Runtime>()

  constructor(
    private store: Store,
    private config: Pick<Config, 'sessionIdleMs' | 'sessionAbsoluteMs'>,
    private now: () => number = Date.now,
  ) {}

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
    if (!record || !runtime) {
      void this.end(idHash)
      return undefined
    }
    const now = this.now()
    if (now >= record.expiresAt || now - record.lastSeenAt >= this.config.sessionIdleMs) {
      void this.end(idHash)
      return undefined
    }
    this.store.touchSession(idHash, now)
    return { idHash, ...runtime }
  }

  setReadOnly(idHash: string, value: boolean): void {
    const runtime = this.live.get(idHash)
    if (runtime) runtime.readOnly = value
  }

  verifyCsrf(session: LiveSession, presented: string | undefined): boolean {
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
    const account = runtime as { connections?: Map<string, { pool: { end(): Promise<unknown> } }>; vaultKey?: Buffer } | undefined
    account?.vaultKey?.fill(0)
    for (const entry of account?.connections?.values() ?? []) await entry.pool.end().catch(() => undefined)
    account?.connections?.clear()
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
        const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url'), now = this.now(), idHash = hash(token)
        const accounts = (this.store as any).accounts
        const limit = user.role === 'admin' ? 2 : 5
        const existing = (accounts.listUserSessions(user.id) as AccountSessionRecord[]).sort((a, b) => a.lastSeenAt - b.lastSeenAt)
        const evicted = existing.slice(0, Math.max(0, existing.length - limit + 1)).map((r) => r.idHash)
        // `end` removes the row and the live entry and closes pools; it touches only the evicted session.
        for (const id of evicted) void this.end(id)
        this.store.createSession({ idHash, targetKey: '', userName: '', createdAt: now, lastSeenAt: now, expiresAt: now + this.config.sessionAbsoluteMs })
        accounts.createAccountSession({ idHash, targetKey: '', userName: '', createdAt: now, lastSeenAt: now, expiresAt: now + this.config.sessionAbsoluteMs, kind: 'account', userId: user.id, state, mfaAt: null, stepupAt: null, securityVersion: user.securityVersion, clientHint: meta.clientHint, address: meta.address })
        this.live.set(idHash, { csrf, target: { host: '', port: 0, username: '' } as TargetKey, pool: undefined as any, readOnly: false })
        return { token, csrf, evicted }
  }
  resolveAccount(token: string | undefined, opts: { background: boolean }): AccountContext | undefined {
        if (!token) return undefined
        const idHash=hash(token), accounts=(this.store as any).accounts, row=accounts.getAccountSession(idHash) as AccountSessionRecord|undefined
        if (!row || row.kind !== 'account') return undefined
        const user=accounts.getUser(row.userId!)
        const now=this.now()
        if (!user || user.status !== 'active' || user.securityVersion !== row.securityVersion || now >= row.expiresAt || now-row.lastSeenAt >= this.config.sessionIdleMs) { void this.end(idHash); return undefined }
        if (!opts.background) accounts.updateAccountSession(idHash,{lastSeenAt:now})
        const runtime=this.live.get(idHash)
        return { idHash, csrf: runtime?.csrf ?? '', kind:'account', state:row.state, user:{id:user.id,username:user.username,displayName:user.displayName,role:user.role,securityVersion:user.securityVersion}, ownerKey:`u:${user.id}`, mfaAt:row.mfaAt, stepupAt:row.stepupAt }
  }
  transition(token: string, patch: { state?: SessionState; mfaAt?: number; stepupAt?: number }): { token: string } {
        const old=hash(token), next=randomBytes(32).toString('base64url'), nextHash=hash(next), accounts=(this.store as any).accounts
        accounts.updateAccountSession(old,patch); accounts.renameSession(old,nextHash); const runtime=this.live.get(old); if(runtime){this.live.delete(old);this.live.set(nextHash,runtime)} return {token:next}
  }
  addConnection(idHash: string, entry: ConnectionEntry) { const r=(this.live as any).get(idHash); if(r){r.connections ??= new Map(); r.connections.set(entry.connectionId,entry)} }
  getConnection(idHash: string, connectionId: string) { return (this.live.get(idHash) as any)?.connections?.get(connectionId) }
  listConnections(idHash: string) { return [...((this.live.get(idHash) as any)?.connections?.values() ?? [])] }
  async closeConnection(idHash: string, connectionId: string) { const e=this.getConnection(idHash,connectionId); if(!e)return false; await e.pool.end().catch(()=>undefined); (this.live.get(idHash) as any)?.connections.delete(connectionId); return true }
  resolveTarget(token: string|undefined, connectionId: string|undefined, opts:{background:boolean}): AccountLiveSession|undefined { const c=this.resolveAccount(token,opts); if(!c)return undefined; const e=connectionId?this.getConnection(c.idHash,connectionId):undefined; if(!e)return undefined; return {...c,target:e.target,pool:e.pool,readOnly:e.readOnly,connectionId:e.connectionId,scopeKey:`${c.idHash}/${e.connectionId}`} }
  setVaultKey(idHash:string,key:Buffer|undefined){const r:any=this.live.get(idHash); if(r?.vaultKey)r.vaultKey.fill(0); if(r)r.vaultKey=key}
  getVaultKey(idHash:string,_now:number){return (this.live.get(idHash) as any)?.vaultKey}
  listUserSessions(userId:string,currentIdHash:string):SessionInfo[]{return ((this.store as any).accounts.listUserSessions(userId) as AccountSessionRecord[]).map(r=>({ref:r.idHash,clientHint:r.clientHint,address:r.address,createdAt:r.createdAt,lastSeenAt:r.lastSeenAt,current:r.idHash===currentIdHash}))}
  async endSession(idHash:string,_reason:'signout'|'evicted'|'security'|'expired'|'revoked'){await this.end(idHash)}
}
