import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from './config'
import type { TargetPool } from './db/target-pool'
import { runRegistry } from './sql/registry'
import { memorySqlState } from './sql/state'
import type { Store } from './store/store'
import { planStore } from './structure/plans'
import type { TargetKey } from './target'

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
    // Running SQL of this session is stopped while the pool can still send KILL QUERY; the in-memory
    // history and bookmarks of stateless mode (owner key = session id hash) go with the session.
    if (runtime) await runRegistry.cancelSession(runtime.pool, idHash).catch(() => undefined)
    memorySqlState.dropOwner(idHash)
    await runtime?.pool.end().catch(() => undefined)
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
}
