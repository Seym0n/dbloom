import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { log as defaultLog, type Logger } from '../log'

/**
 * Single-instance lock (FR-SVR-013, DEP-TGT-150): one row (`instance_lock`) in the existing `site` table of the store.
 * A row in the store, not a lock file, because the take-over is one `BEGIN IMMEDIATE` transaction (two starters cannot
 * both see a stale lock and both win), the row sits in the same volume as the data it protects, and it needs no
 * migration (`site` is a key/value table). Held by a stateful process only; stateless mode (`DBLOOM_STORE=none`) has no
 * lock.
 *
 * Stale when: the heartbeat is older than `staleMs` (3 intervals), or the holder is on this host and is this very pid
 * (a restarted container: pid 1 again) or a pid that no longer exists. A holder on another host is judged by its
 * heartbeat only (a recreated container has a new host name and the old holder is gone).
 */
const SITE_KEY = 'instance_lock'

export type LockRecord = { pid: number; host: string; startedAt: number; heartbeatAt: number; nonce: string }

export class InstanceLockError extends Error {
  constructor(
    message: string,
    public holder: LockRecord,
  ) {
    super(message)
    this.name = 'InstanceLockError'
  }
}

export type InstanceLockOptions = {
  now?: () => number
  pid?: number
  host?: string
  heartbeatMs?: number
  /** Default 3 heartbeats. */
  staleMs?: number
  /** Is this pid alive on this host? Default: `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean
  log?: Logger
  /** Called when a heartbeat finds the row gone or taken by another process. */
  onLost?: (reason: string) => void
}

export const HEARTBEAT_MS = 10_000

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class InstanceLock {
  private readonly nonce = randomBytes(8).toString('hex')
  private readonly pid: number
  private readonly host: string
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly staleMs: number
  private readonly alive: (pid: number) => boolean
  private readonly logger: Logger
  private timer?: NodeJS.Timeout
  private held = false

  constructor(
    private db: DatabaseSync,
    private opts: InstanceLockOptions = {},
  ) {
    this.pid = opts.pid ?? process.pid
    this.host = opts.host ?? hostname()
    this.now = opts.now ?? Date.now
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
    this.staleMs = opts.staleMs ?? this.heartbeatMs * 3
    this.alive = opts.isPidAlive ?? defaultAlive
    this.logger = opts.log ?? defaultLog
  }

  private read(): LockRecord | undefined {
    const row = this.db.prepare('SELECT value FROM site WHERE key = ?').get(SITE_KEY) as { value: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as LockRecord
    } catch {
      return undefined // unreadable row: treated as no holder
    }
  }

  private write(record: LockRecord): void {
    this.db
      .prepare('INSERT INTO site(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(SITE_KEY, JSON.stringify(record))
  }

  private rollback(): void {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // no open transaction
    }
  }

  /** Why the holder counts as gone, or undefined when it is alive. */
  staleReason(holder: LockRecord): string | undefined {
    if (holder.nonce === this.nonce) return undefined
    if (this.now() - holder.heartbeatAt > this.staleMs) return 'heartbeat expired'
    if (holder.host === this.host) {
      if (holder.pid === this.pid) return 'same pid on this host (earlier run)'
      if (!this.alive(holder.pid)) return 'process no longer exists'
    }
    return undefined
  }

  /** Takes the lock or throws `InstanceLockError` naming the holder. */
  acquire(): void {
    const t = this.now()
    let tookOver: { holder: LockRecord; reason: string } | undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const holder = this.read()
      const reason = holder ? this.staleReason(holder) : undefined
      if (holder && !reason) {
        const age = Math.max(0, Math.round((t - holder.heartbeatAt) / 1000))
        throw new InstanceLockError(
          `Another DBLoom instance uses this store: pid ${holder.pid} on host ${holder.host} (started ${new Date(holder.startedAt).toISOString()}, last heartbeat ${age} s ago). Stop it, or wait ${Math.ceil(this.staleMs / 1000)} s if it died.`,
          holder,
        )
      }
      this.write({ pid: this.pid, host: this.host, startedAt: t, heartbeatAt: t, nonce: this.nonce })
      this.db.exec('COMMIT')
      if (holder && reason) tookOver = { holder, reason }
    } catch (error) {
      this.rollback()
      throw error
    }
    this.held = true
    if (tookOver) this.logger.warn('instance lock taken over', { previousPid: tookOver.holder.pid, previousHost: tookOver.holder.host, reason: tookOver.reason })
    this.timer = setInterval(() => this.beat(), this.heartbeatMs)
    this.timer.unref()
  }

  /** Refreshes the heartbeat; reports when the row is no longer ours. */
  beat(): void {
    if (!this.held) return
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const holder = this.read()
        if (!holder || holder.nonce !== this.nonce) {
          this.db.exec('ROLLBACK')
          this.held = false
          this.stopTimer()
          this.opts.onLost?.(holder ? `taken by pid ${holder.pid} on ${holder.host}` : 'row removed')
          return
        }
        this.write({ ...holder, heartbeatAt: this.now() })
        this.db.exec('COMMIT')
      } catch (error) {
        this.rollback()
        throw error
      }
    } catch (error) {
      // a busy or closed store: the next beat retries; the lock only expires after several missed beats
      this.logger.warn('instance lock heartbeat failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Removes the row when it is still ours. Safe to call twice. */
  release(): void {
    this.stopTimer()
    if (!this.held) return
    this.held = false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const holder = this.read()
      if (holder?.nonce === this.nonce) this.db.prepare('DELETE FROM site WHERE key = ?').run(SITE_KEY)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  get isHeld(): boolean {
    return this.held
  }
}
