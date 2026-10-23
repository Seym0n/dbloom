import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SQL_LIMITS,
  type Bookmark,
  type HistoryEntry,
  type HistorySource,
  type NewHistoryEntry,
  type SqlStateStore,
} from './types'
import type { TargetKey } from '../target'

/** Refusals of the state stores (stable code, safe message). */
export class SqlStateError extends Error {
  constructor(
    public code: 'bookmark_exists' | 'bookmark_limit' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'SqlStateError'
  }
}

export const MAX_BOOKMARKS_PER_TARGET = 500

export type SqlStateOptions = {
  /** Retention applied after each insert and at start (ST-161). */
  historyEntries: number
  historyDays: number
  /** Text above this many bytes is not stored (`sql` NULL, `sqlOmitted`). */
  historyEntryBytes: number
}

export const DEFAULT_STATE_OPTIONS: SqlStateOptions = {
  historyEntries: DEFAULT_SQL_LIMITS.historyEntries,
  historyDays: DEFAULT_SQL_LIMITS.historyDays,
  historyEntryBytes: DEFAULT_SQL_LIMITS.historyEntryBytes,
}

export const DAY_MS = 86_400_000

/**
 * Owner key in direct mode: `host[zone]:port|username` of the normalised target (DATA-TGT-095).
 * `TargetKey` only ever comes out of `normaliseTarget`, so the parts are already normalised.
 */
export function ownerKeyOf(target: TargetKey): string {
  return `${target.host}${target.zone ?? ''}:${target.port}|${target.username}`
}

/** Stateless mode (`DBLOOM_STORE=none`): history and bookmarks live in memory for the session. */
export const isStateless = (): boolean => process.env.DBLOOM_STORE === 'none'

/** The store enforces only the size limit; redaction is the caller's job (spec 5.8, 5.10). */
export function applyEntryLimit(
  entry: NewHistoryEntry,
  maxBytes: number,
): { sql: string | null; sqlOmitted: boolean } {
  if (entry.sql === null) return { sql: null, sqlOmitted: true }
  if (Buffer.byteLength(entry.sql, 'utf8') > maxBytes) return { sql: null, sqlOmitted: true }
  return { sql: entry.sql, sqlOmitted: entry.sqlOmitted }
}

type OwnerState = { history: HistoryEntry[]; bookmarks: Map<string, Bookmark> }

/**
 * Per-owner state in process memory, bounded, nothing persisted. In stateless mode the owner key is
 * the session id hash, so one session cannot see another's entries.
 */
export class MemorySqlState implements SqlStateStore {
  private owners = new Map<string, OwnerState>()
  private nextId = 1

  constructor(
    private opts: SqlStateOptions = DEFAULT_STATE_OPTIONS,
    private maxOwners = 1000,
    private now: () => number = Date.now,
  ) {}

  private owner(key: string): OwnerState {
    let o = this.owners.get(key)
    if (!o) {
      if (this.owners.size >= this.maxOwners) {
        const oldest = this.owners.keys().next().value
        if (oldest !== undefined) this.owners.delete(oldest)
      }
      o = { history: [], bookmarks: new Map() }
      this.owners.set(key, o)
    }
    return o
  }

  /** To be called when a session ends. */
  dropOwner(ownerKey: string): void {
    this.owners.delete(ownerKey)
  }

  addHistory(ownerKey: string, entry: NewHistoryEntry): HistoryEntry {
    const o = this.owner(ownerKey)
    const stored: HistoryEntry = {
      ...entry,
      ...applyEntryLimit(entry, this.opts.historyEntryBytes),
      id: this.nextId++,
    }
    o.history.unshift(stored)
    this.pruneHistory(ownerKey, this.opts.historyEntries, this.opts.historyDays * DAY_MS)
    return stored
  }

  listHistory(
    ownerKey: string,
    opts: {
      cursor?: number
      limit: number
      source?: HistorySource
      targetKey?: string
      query?: string
    },
  ): { entries: HistoryEntry[]; nextCursor: number | null } {
    const needle = opts.query?.toLowerCase()
    const all = (this.owners.get(ownerKey)?.history ?? []).filter(
      (e) =>
        (opts.cursor === undefined || e.id < opts.cursor) &&
        (opts.source === undefined || e.source === opts.source) &&
        (opts.targetKey === undefined || e.targetKey === opts.targetKey) &&
        (needle === undefined || needle === '' || (e.sql?.toLowerCase().includes(needle) ?? false)),
    )
    const entries = all.slice(0, opts.limit)
    return {
      entries,
      nextCursor: all.length > opts.limit ? entries[entries.length - 1]!.id : null,
    }
  }

  deleteHistory(ownerKey: string, ids: number[]): number {
    const o = this.owners.get(ownerKey)
    if (!o) return 0
    const set = new Set(ids)
    const before = o.history.length
    o.history = o.history.filter((e) => !set.has(e.id))
    return before - o.history.length
  }

  clearHistory(ownerKey: string): number {
    const o = this.owners.get(ownerKey)
    if (!o) return 0
    const n = o.history.length
    o.history = []
    return n
  }

  pruneHistory(ownerKey: string, maxEntries: number, maxAgeMs: number, now?: number): number {
    const o = this.owners.get(ownerKey)
    if (!o) return 0
    const cutoff = (now ?? this.now()) - maxAgeMs
    const before = o.history.length
    o.history = o.history.filter((e) => e.createdAt >= cutoff).slice(0, Math.max(0, maxEntries))
    return before - o.history.length
  }

  saveBookmark(
    ownerKey: string,
    b: { id?: string; targetKey: string; name: string; sql: string; db: string | null },
  ): Bookmark {
    const o = this.owner(ownerKey)
    const at = this.now()
    const clash = [...o.bookmarks.values()].some(
      (x) => x.targetKey === b.targetKey && x.name === b.name && x.id !== b.id,
    )
    if (b.id !== undefined) {
      const old = o.bookmarks.get(b.id)
      if (!old) throw new SqlStateError('not_found', 'Not found')
      if (clash) throw new SqlStateError('bookmark_exists', 'A bookmark with this name exists')
      const next: Bookmark = { ...old, name: b.name, sql: b.sql, db: b.db, updatedAt: at }
      o.bookmarks.set(b.id, next)
      return next
    }
    if (clash) throw new SqlStateError('bookmark_exists', 'A bookmark with this name exists')
    const count = [...o.bookmarks.values()].filter((x) => x.targetKey === b.targetKey).length
    if (count >= MAX_BOOKMARKS_PER_TARGET) {
      throw new SqlStateError('bookmark_limit', 'Too many bookmarks')
    }
    const created: Bookmark = {
      id: randomUUID(),
      targetKey: b.targetKey,
      name: b.name,
      sql: b.sql,
      db: b.db,
      createdAt: at,
      updatedAt: at,
    }
    o.bookmarks.set(created.id, created)
    return created
  }

  listBookmarks(ownerKey: string, opts?: { targetKey?: string }): Bookmark[] {
    return [...(this.owners.get(ownerKey)?.bookmarks.values() ?? [])]
      .filter((b) => opts?.targetKey === undefined || b.targetKey === opts.targetKey)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  renameBookmark(ownerKey: string, id: string, name: string): Bookmark | undefined {
    const o = this.owners.get(ownerKey)
    const old = o?.bookmarks.get(id)
    if (!o || !old) return undefined
    const clash = [...o.bookmarks.values()].some(
      (x) => x.targetKey === old.targetKey && x.name === name && x.id !== id,
    )
    if (clash) throw new SqlStateError('bookmark_exists', 'A bookmark with this name exists')
    const next = { ...old, name, updatedAt: this.now() }
    o.bookmarks.set(id, next)
    return next
  }

  deleteBookmark(ownerKey: string, id: string): boolean {
    return this.owners.get(ownerKey)?.bookmarks.delete(id) ?? false
  }
}

/** Stateless mode keeps one process-wide memory store, partitioned by owner key (the session id). */
export const memorySqlState = new MemorySqlState()

/** Chooses the store by `DBLOOM_STORE`: `none` is memory, everything else the SQLite store. */
export function getSqlState(runtime: { store: { sql: SqlStateStore } }): SqlStateStore {
  return isStateless() ? memorySqlState : runtime.store.sql
}
