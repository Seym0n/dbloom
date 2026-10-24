import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  DAY_MS,
  DEFAULT_STATE_OPTIONS,
  MAX_BOOKMARKS_PER_TARGET,
  SqlStateError,
  applyEntryLimit,
  type SqlStateOptions,
} from '../sql/state'
import { scopeKey, type PrefScope, type PrefValues, type PrefsStore } from '../rows/prefs'
import { MAX_TABLE_SCOPES, PREF_KEYS, type PrefKey } from '../rows/types'
import type {
  Bookmark,
  HistoryEntry,
  HistorySource,
  NewHistoryEntry,
  SqlStateStore,
} from '../sql/types'
import type { SessionRecord, Store } from './store'

const SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash      TEXT PRIMARY KEY,
    target_key   TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
`

const SQL_STATE_SCHEMA = `
  CREATE TABLE sql_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key    TEXT NOT NULL,
    target_key   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('user','generated','assistant')),
    db           TEXT,
    sql          TEXT,
    sql_omitted  INTEGER NOT NULL DEFAULT 0,
    statements   INTEGER NOT NULL,
    executed     INTEGER NOT NULL,
    failed_index INTEGER,
    max_class    TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sql_history_owner ON sql_history(owner_key, id DESC);
  CREATE TABLE sql_bookmarks (
    id         TEXT PRIMARY KEY,
    owner_key  TEXT NOT NULL,
    target_key TEXT NOT NULL,
    name       TEXT NOT NULL,
    sql        TEXT NOT NULL,
    db         TEXT,
    shared     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_key, target_key, name)
  ) STRICT;
`

const UI_PREFS_SCHEMA = `
  CREATE TABLE ui_prefs (
    owner_key  TEXT NOT NULL,
    target_key TEXT NOT NULL,
    scope      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, target_key, scope, key)
  ) STRICT;
`

/** Migration n+1 is MIGRATIONS[n]; `PRAGMA user_version` holds the number applied (FR-SQL-020). */
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 1: the skeleton schema, unchanged. Idempotent, because files made before versions existed
  // have the sessions table and user_version 0.
  (db) => db.exec(SESSIONS_SCHEMA),
  // 2: history and bookmarks
  (db) => db.exec(SQL_STATE_SCHEMA),
  // 3: display preferences of module rows (FR-ROW-010, spec 24 section 5.9)
  (db) => db.exec(UI_PREFS_SCHEMA),
]

/** Applies pending migrations in one transaction; refuses a database newer than the code. */
export function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  if (current > MIGRATIONS.length) {
    throw new Error(
      `The store has schema version ${current}, newer than this program supports (${MIGRATIONS.length})`,
    )
  }
  if (current === MIGRATIONS.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let i = current; i < MIGRATIONS.length; i++) MIGRATIONS[i]!(db)
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

type Row = {
  id_hash: string
  target_key: string
  user_name: string
  created_at: number
  last_seen_at: number
  expires_at: number
}

export type SqliteStore = Store & { sql: SqlStateStore; prefs: PrefsStore }

export function openSqliteStore(path: string, options: Partial<SqlStateOptions> = {}): SqliteStore {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  const sql = createSqliteSqlState(db, { ...DEFAULT_STATE_OPTIONS, ...options })
  const prefs = createSqlitePrefs(db)

  const insert = db.prepare(
    'INSERT INTO sessions (id_hash, target_key, user_name, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const select = db.prepare('SELECT * FROM sessions WHERE id_hash = ?')
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?')
  const remove = db.prepare('DELETE FROM sessions WHERE id_hash = ?')
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?')

  return {
    createSession: (r) =>
      void insert.run(r.idHash, r.targetKey, r.userName, r.createdAt, r.lastSeenAt, r.expiresAt),
    getSession(idHash) {
      const row = select.get(idHash) as Row | undefined
      if (!row) return undefined
      return {
        idHash: row.id_hash,
        targetKey: row.target_key,
        userName: row.user_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      } satisfies SessionRecord
    },
    touchSession: (idHash, lastSeenAt) => void touch.run(lastSeenAt, idHash),
    deleteSession: (idHash) => void remove.run(idHash),
    purgeSessions: (before) => Number(purge.run(before).changes),
    sql,
    prefs,
    close: () => db.close(),
  }
}

// ---- History and bookmarks --------------------------------------------------------------------------------

type HistoryRow = {
  id: number
  target_key: string
  created_at: number
  source: HistorySource
  db: string | null
  sql: string | null
  sql_omitted: number
  statements: number
  executed: number
  failed_index: number | null
  max_class: HistoryEntry['maxClass']
  outcome: HistoryEntry['outcome']
  duration_ms: number
}

type BookmarkRow = {
  id: string
  target_key: string
  name: string
  sql: string
  db: string | null
  created_at: number
  updated_at: number
}

const toEntry = (r: HistoryRow): HistoryEntry => ({
  id: r.id,
  createdAt: r.created_at,
  source: r.source,
  targetKey: r.target_key,
  db: r.db,
  sql: r.sql,
  sqlOmitted: r.sql_omitted === 1,
  statements: r.statements,
  executed: r.executed,
  failedIndex: r.failed_index,
  maxClass: r.max_class,
  outcome: r.outcome,
  durationMs: r.duration_ms,
})

const toBookmark = (r: BookmarkRow): Bookmark => ({
  id: r.id,
  targetKey: r.target_key,
  name: r.name,
  sql: r.sql,
  db: r.db,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
const exists = () => new SqlStateError('bookmark_exists', 'A bookmark with this name exists')

/**
 * SQLite implementation of `SqlStateStore` (spec 5.8). Every statement carries `owner_key = ?`;
 * values go through prepared statements; no SQL text is placed in a log.
 */
export function createSqliteSqlState(
  db: DatabaseSync,
  opts: SqlStateOptions = DEFAULT_STATE_OPTIONS,
  now: () => number = Date.now,
): SqlStateStore {
  const insertH = db.prepare(
    `INSERT INTO sql_history (owner_key, target_key, created_at, source, db, sql, sql_omitted,
       statements, executed, failed_index, max_class, outcome, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const pruneAge = db.prepare('DELETE FROM sql_history WHERE owner_key = ? AND created_at < ?')
  const pruneCount = db.prepare(
    `DELETE FROM sql_history WHERE owner_key = ? AND id NOT IN
       (SELECT id FROM sql_history WHERE owner_key = ? ORDER BY id DESC LIMIT ?)`,
  )
  const clearH = db.prepare('DELETE FROM sql_history WHERE owner_key = ?')

  const prune = (ownerKey: string, maxEntries: number, maxAgeMs: number, at: number): number => {
    const byAge = Number(pruneAge.run(ownerKey, at - maxAgeMs).changes)
    const byCount = Number(pruneCount.run(ownerKey, ownerKey, Math.max(0, maxEntries)).changes)
    return byAge + byCount
  }

  const selB = db.prepare('SELECT * FROM sql_bookmarks WHERE owner_key = ? AND id = ?')
  const insB = db.prepare(
    `INSERT INTO sql_bookmarks (id, owner_key, target_key, name, sql, db, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const updB = db.prepare(
    'UPDATE sql_bookmarks SET name = ?, sql = ?, db = ?, updated_at = ? WHERE owner_key = ? AND id = ?',
  )
  const countB = db.prepare(
    'SELECT COUNT(*) AS n FROM sql_bookmarks WHERE owner_key = ? AND target_key = ?',
  )
  const listB = db.prepare('SELECT * FROM sql_bookmarks WHERE owner_key = ? ORDER BY name')
  const listBT = db.prepare(
    'SELECT * FROM sql_bookmarks WHERE owner_key = ? AND target_key = ? ORDER BY name',
  )
  const renB = db.prepare(
    'UPDATE sql_bookmarks SET name = ?, updated_at = ? WHERE owner_key = ? AND id = ?',
  )
  const delB = db.prepare('DELETE FROM sql_bookmarks WHERE owner_key = ? AND id = ?')

  const store: SqlStateStore = {
    addHistory(ownerKey, entry: NewHistoryEntry) {
      const limited = applyEntryLimit(entry, opts.historyEntryBytes)
      const r = insertH.run(
        ownerKey,
        entry.targetKey,
        entry.createdAt,
        entry.source,
        entry.db,
        limited.sql,
        limited.sqlOmitted ? 1 : 0,
        entry.statements,
        entry.executed,
        entry.failedIndex,
        entry.maxClass,
        entry.outcome,
        entry.durationMs,
      )
      prune(ownerKey, opts.historyEntries, opts.historyDays * DAY_MS, now())
      return { ...entry, ...limited, id: Number(r.lastInsertRowid) }
    },
    listHistory(ownerKey, o) {
      const where = ['owner_key = ?']
      const args: (string | number)[] = [ownerKey]
      if (o.cursor !== undefined) {
        where.push('id < ?')
        args.push(o.cursor)
      }
      if (o.source !== undefined) {
        where.push('source = ?')
        args.push(o.source)
      }
      if (o.targetKey !== undefined) {
        where.push('target_key = ?')
        args.push(o.targetKey)
      }
      if (o.query !== undefined && o.query !== '') {
        where.push("sql LIKE ? ESCAPE '\\'")
        args.push(`%${escapeLike(o.query)}%`)
      }
      const rows = db
        .prepare(`SELECT * FROM sql_history WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...args, o.limit + 1) as HistoryRow[]
      const entries = rows.slice(0, o.limit).map(toEntry)
      return {
        entries,
        nextCursor: rows.length > o.limit ? entries[entries.length - 1]!.id : null,
      }
    },
    deleteHistory(ownerKey, ids) {
      if (ids.length === 0) return 0
      const marks = ids.map(() => '?').join(',')
      const r = db
        .prepare(`DELETE FROM sql_history WHERE owner_key = ? AND id IN (${marks})`)
        .run(ownerKey, ...ids)
      return Number(r.changes)
    },
    clearHistory: (ownerKey) => Number(clearH.run(ownerKey).changes),
    pruneHistory: (ownerKey, maxEntries, maxAgeMs, at) =>
      prune(ownerKey, maxEntries, maxAgeMs, at ?? now()),
    saveBookmark(ownerKey, b) {
      const at = now()
      try {
        if (b.id !== undefined) {
          if (!selB.get(ownerKey, b.id)) throw new SqlStateError('not_found', 'Not found')
          updB.run(b.name, b.sql, b.db, at, ownerKey, b.id)
          return toBookmark(selB.get(ownerKey, b.id) as BookmarkRow)
        }
        const { n } = countB.get(ownerKey, b.targetKey) as { n: number }
        if (n >= MAX_BOOKMARKS_PER_TARGET) {
          throw new SqlStateError('bookmark_limit', 'Too many bookmarks')
        }
        const id = randomUUID()
        insB.run(id, ownerKey, b.targetKey, b.name, b.sql, b.db, at, at)
        return toBookmark(selB.get(ownerKey, id) as BookmarkRow)
      } catch (error) {
        throw isUnique(error) ? exists() : error
      }
    },
    listBookmarks(ownerKey, o) {
      const rows = (
        o?.targetKey !== undefined ? listBT.all(ownerKey, o.targetKey) : listB.all(ownerKey)
      ) as BookmarkRow[]
      return rows.map(toBookmark)
    },
    renameBookmark(ownerKey, id, name) {
      try {
        const r = renB.run(name, now(), ownerKey, id)
        if (Number(r.changes) === 0) return undefined
        return toBookmark(selB.get(ownerKey, id) as BookmarkRow)
      } catch (error) {
        throw isUnique(error) ? exists() : error
      }
    },
    deleteBookmark: (ownerKey, id) => Number(delB.run(ownerKey, id).changes) > 0,
  }

  // Retention once at start for every owner (spec 5.8).
  const owners = db.prepare('SELECT DISTINCT owner_key FROM sql_history').all() as {
    owner_key: string
  }[]
  for (const o of owners) {
    prune(o.owner_key, opts.historyEntries, opts.historyDays * DAY_MS, now())
  }
  return store
}

// ---- Display preferences ----------------------------------------------------------------------------------

const isPrefKey = (k: string): k is PrefKey => (PREF_KEYS as readonly string[]).includes(k)

/**
 * SQLite implementation of `PrefsStore` (spec 24 section 5.9). Every statement carries
 * `owner_key = ? AND target_key = ?`; at most `MAX_TABLE_SCOPES` table scopes per owner and target,
 * the least recently updated removed on write (FR-CFG-073).
 */
export function createSqlitePrefs(
  db: DatabaseSync,
  now: () => number = Date.now,
  maxTableScopes: number = MAX_TABLE_SCOPES,
): PrefsStore {
  const selScope = db.prepare(
    'SELECT key, value FROM ui_prefs WHERE owner_key = ? AND target_key = ? AND scope = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO ui_prefs (owner_key, target_key, scope, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_key, target_key, scope, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  const prune = db.prepare(
    `DELETE FROM ui_prefs WHERE owner_key = ? AND target_key = ? AND scope <> 'global' AND scope IN (
       SELECT scope FROM (
         SELECT scope, MAX(updated_at) AS u FROM ui_prefs
          WHERE owner_key = ? AND target_key = ? AND scope <> 'global'
          GROUP BY scope ORDER BY u DESC, scope DESC LIMIT -1 OFFSET ?))`,
  )
  const count = db.prepare(
    `SELECT COUNT(DISTINCT scope) AS n FROM ui_prefs
      WHERE owner_key = ? AND target_key = ? AND scope <> 'global'`,
  )

  const read = (ownerKey: string, targetKey: string, scope: string, out: PrefValues) => {
    for (const row of selScope.all(ownerKey, targetKey, scope) as {
      key: string
      value: string
    }[]) {
      if (!isPrefKey(row.key)) continue
      try {
        out[row.key] = JSON.parse(row.value) as unknown
      } catch {
        // a damaged value is treated as absent
      }
    }
  }

  return {
    get(ownerKey, targetKey, table) {
      const out: PrefValues = {}
      read(ownerKey, targetKey, 'global', out)
      if (table) read(ownerKey, targetKey, scopeKey({ kind: 'table', ...table }), out)
      return out
    },
    set(ownerKey, targetKey, scope: PrefScope, key, value) {
      upsert.run(ownerKey, targetKey, scopeKey(scope), key, JSON.stringify(value), now())
      if (scope.kind === 'table') {
        prune.run(ownerKey, targetKey, ownerKey, targetKey, maxTableScopes)
      }
    },
    tableScopeCount(ownerKey, targetKey) {
      return (count.get(ownerKey, targetKey) as { n: number }).n
    },
  }
}
