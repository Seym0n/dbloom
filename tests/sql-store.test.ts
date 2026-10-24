import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { MemorySqlState, ownerKeyOf, SqlStateError } from '~/server/sql/state'
import { normaliseTarget } from '~/server/target'
import type { NewHistoryEntry, SqlStateStore } from '~/server/sql/types'

let dir: string
let store: SqliteStore | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-sql-'))
})
afterEach(() => {
  store?.close()
  store = undefined
  rmSync(dir, { recursive: true, force: true })
})

const entry = (over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  createdAt: Date.now(),
  source: 'user',
  targetKey: 'h:3306',
  db: 'd',
  sql: 'SELECT 1',
  sqlOmitted: false,
  statements: 1,
  executed: 1,
  failedIndex: null,
  maxClass: 'none',
  outcome: 'ok',
  durationMs: 3,
  ...over,
})

describe('ownerKeyOf', () => {
  test('host[zone]:port|username from the normalised target', () => {
    expect(ownerKeyOf(normaliseTarget('DB.Example.COM.', 3307, 'root'))).toBe(
      'db.example.com:3307|root',
    )
    expect(ownerKeyOf(normaliseTarget('[fe80::1%ETH0]', undefined, 'u'))).toBe(
      'fe80::1%eth0:3306|u',
    )
    expect(ownerKeyOf(normaliseTarget('h', 1, 'a'))).not.toBe(
      ownerKeyOf(normaliseTarget('h', 1, 'b')),
    )
  })
})

describe('migrations', () => {
  const version = (path: string) => {
    const db = new DatabaseSync(path)
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    db.close()
    return v
  }

  test('empty file reaches the latest version', () => {
    const path = join(dir, 'a.db')
    store = openSqliteStore(path)
    store.close()
    store = undefined
    expect(version(path)).toBe(MIGRATIONS.length)
  })

  test('version-1 file written by the skeleton code keeps its sessions', () => {
    const path = join(dir, 'v1.db')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE sessions (
      id_hash TEXT PRIMARY KEY, target_key TEXT NOT NULL, user_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT; CREATE INDEX sessions_expires ON sessions(expires_at);`)
    old.exec("INSERT INTO sessions VALUES ('x','h:1','root',1,1,99)")
    old.close()
    expect(version(path)).toBe(0)
    store = openSqliteStore(path)
    expect(store.getSession('x')?.userName).toBe('root')
    expect(store.sql.addHistory('o', entry()).id).toBeGreaterThan(0)
    store.close()
    store = undefined
    expect(version(path)).toBe(MIGRATIONS.length)
  })

  test('explicit user_version 1 upgrades to 2', () => {
    const path = join(dir, 'v1b.db')
    const old = new DatabaseSync(path)
    MIGRATIONS[0]!(old)
    old.exec('PRAGMA user_version = 1')
    old.close()
    store = openSqliteStore(path)
    expect(store.sql.listBookmarks('o')).toEqual([])
  })

  test('a database newer than the code refuses to start', () => {
    const path = join(dir, 'new.db')
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    db.close()
    expect(() => openSqliteStore(path)).toThrow(/newer/)
  })

  test('a failing migration rolls back completely', () => {
    const path = join(dir, 'fail.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE sql_history (x INTEGER)') // makes migration 2 fail
    db.close()
    expect(() => openSqliteStore(path)).toThrow()
    const check = new DatabaseSync(path)
    const v = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const hasSessions = check
      .prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'")
      .get()
    check.close()
    expect(v).toBe(0)
    expect(hasSessions).toBeUndefined()
  })
})

/** The same behaviour is required of both implementations. */
const impls: [string, () => SqlStateStore][] = [
  ['sqlite', () => (store = openSqliteStore(join(dir, 's.db'))).sql],
  ['memory', () => new MemorySqlState()],
]

describe.each(impls)('state store: %s', (_name, make) => {
  test('history lists newest first with a cursor and filters', () => {
    const s = make()
    for (let i = 0; i < 5; i++) s.addHistory('A', entry({ sql: `SELECT ${i}` }))
    s.addHistory('A', entry({ source: 'generated', sql: 'SELECT 100%' }))
    const p1 = s.listHistory('A', { limit: 4 })
    expect(p1.entries.map((e) => e.sql)).toEqual([
      'SELECT 100%',
      'SELECT 4',
      'SELECT 3',
      'SELECT 2',
    ])
    const p2 = s.listHistory('A', { limit: 4, cursor: p1.nextCursor! })
    expect(p2.entries.map((e) => e.sql)).toEqual(['SELECT 1', 'SELECT 0'])
    expect(p2.nextCursor).toBeNull()
    expect(s.listHistory('A', { limit: 9, source: 'generated' }).entries).toHaveLength(1)
    expect(s.listHistory('A', { limit: 9, query: '100%' }).entries).toHaveLength(1)
    expect(s.listHistory('A', { limit: 9, query: '%' }).entries).toHaveLength(1)
  })

  test('owner isolation: history and bookmarks, even by id', () => {
    const s = make()
    const a = s.addHistory('A', entry({ sql: 'SELECT secret' }))
    const bm = s.saveBookmark('A', { targetKey: 't', name: 'n', sql: 'SELECT 1', db: null })
    expect(s.listHistory('B', { limit: 50 }).entries).toEqual([])
    expect(s.deleteHistory('B', [a.id])).toBe(0)
    expect(s.listHistory('A', { limit: 50 }).entries).toHaveLength(1)
    expect(s.clearHistory('B')).toBe(0)
    expect(s.listBookmarks('B')).toEqual([])
    expect(s.renameBookmark('B', bm.id, 'x')).toBeUndefined()
    expect(s.deleteBookmark('B', bm.id)).toBe(false)
    expect(() =>
      s.saveBookmark('B', { id: bm.id, targetKey: 't', name: 'y', sql: 'z', db: null }),
    ).toThrow(SqlStateError)
    expect(s.listBookmarks('A')[0]).toMatchObject({ name: 'n', sql: 'SELECT 1' })
    // B may use the same name on the same target.
    expect(s.saveBookmark('B', { targetKey: 't', name: 'n', sql: 'q', db: null }).id).not.toBe(
      bm.id,
    )
  })

  test('retention by count and by age', () => {
    const s = make()
    const now = Date.now()
    for (let i = 0; i < 10; i++) s.addHistory('A', entry({ createdAt: now, sql: `q${i}` }))
    expect(s.pruneHistory('A', 3, 1000, now)).toBe(7)
    expect(s.listHistory('A', { limit: 50 }).entries.map((e) => e.sql)).toEqual(['q9', 'q8', 'q7'])
    s.addHistory('A', entry({ createdAt: now - 10_000, sql: 'old' }))
    expect(s.pruneHistory('A', 100, 5000, now)).toBeGreaterThanOrEqual(1)
    expect(s.listHistory('A', { limit: 50 }).entries.some((e) => e.sql === 'old')).toBe(false)
    s.addHistory('B', entry())
    expect(s.listHistory('B', { limit: 5 }).entries).toHaveLength(1) // other owner untouched
  })

  test('over-long text is stored without text and marked', () => {
    const s = make()
    const e = s.addHistory('A', entry({ sql: 'x'.repeat(64 * 1024 + 1) }))
    expect(e).toMatchObject({ sql: null, sqlOmitted: true })
    expect(s.listHistory('A', { limit: 1 }).entries[0]).toMatchObject({
      sql: null,
      sqlOmitted: true,
    })
    const ok = s.addHistory('A', entry({ sql: 'x'.repeat(64 * 1024) }))
    expect(ok.sqlOmitted).toBe(false)
    expect(s.addHistory('A', entry({ sql: null, sqlOmitted: true })).sqlOmitted).toBe(true)
  })

  test('bookmark names are unique per owner and target', () => {
    const s = make()
    const b = s.saveBookmark('A', { targetKey: 't1', name: 'n', sql: 'a', db: 'd' })
    expect(() => s.saveBookmark('A', { targetKey: 't1', name: 'n', sql: 'b', db: null })).toThrow(
      /exists/,
    )
    expect(s.saveBookmark('A', { targetKey: 't2', name: 'n', sql: 'b', db: null })).toBeDefined()
    const other = s.saveBookmark('A', { targetKey: 't1', name: 'm', sql: 'b', db: null })
    expect(() => s.renameBookmark('A', other.id, 'n')).toThrow(/exists/)
    expect(s.renameBookmark('A', other.id, 'k')?.name).toBe('k')
    const upd = s.saveBookmark('A', { id: b.id, targetKey: 't1', name: 'n', sql: 'new', db: null })
    expect(upd).toMatchObject({ id: b.id, sql: 'new', db: null })
    expect(s.listBookmarks('A', { targetKey: 't2' })).toHaveLength(1)
    expect(s.deleteBookmark('A', b.id)).toBe(true)
  })

  test('at most 500 bookmarks per owner and target', () => {
    const s = make()
    for (let i = 0; i < 500; i++)
      s.saveBookmark('A', { targetKey: 't', name: `n${i}`, sql: 'q', db: null })
    expect(() => s.saveBookmark('A', { targetKey: 't', name: 'more', sql: 'q', db: null })).toThrow(
      /Too many/,
    )
    expect(s.saveBookmark('A', { targetKey: 'u', name: 'more', sql: 'q', db: null })).toBeDefined()
  })
})

describe('sqlite specifics', () => {
  test('history and bookmarks survive reopening; retention runs at start', () => {
    const path = join(dir, 'p.db')
    store = openSqliteStore(path)
    const now = Date.now()
    for (let i = 0; i < 6; i++) store.sql.addHistory('A', entry({ createdAt: now, sql: `q${i}` }))
    store.sql.saveBookmark('A', { targetKey: 't', name: 'n', sql: 'q', db: null })
    store.close()
    store = openSqliteStore(path, { historyEntries: 2 })
    expect(store.sql.listHistory('A', { limit: 50 }).entries.map((e) => e.sql)).toEqual([
      'q5',
      'q4',
    ])
    expect(store.sql.listBookmarks('A')).toHaveLength(1)
  })

  test('retention is applied after each insert', () => {
    store = openSqliteStore(join(dir, 'r.db'), { historyEntries: 3 })
    for (let i = 0; i < 8; i++) store.sql.addHistory('A', entry({ sql: `q${i}` }))
    expect(store.sql.listHistory('A', { limit: 50 }).entries).toHaveLength(3)
  })

  test('hostile text is stored as data', () => {
    store = openSqliteStore(join(dir, 'h.db'))
    const sql = "'; DROP TABLE sql_history; --"
    store.sql.addHistory("o'; --", entry({ sql }))
    expect(store.sql.listHistory("o'; --", { limit: 5, query: 'DROP' }).entries[0]!.sql).toBe(sql)
  })
})

describe('memory store bounds', () => {
  test('entries per owner and number of owners are bounded', () => {
    const m = new MemorySqlState({ historyEntries: 5, historyDays: 30, historyEntryBytes: 100 }, 3)
    for (let i = 0; i < 20; i++) m.addHistory('A', entry())
    expect(m.listHistory('A', { limit: 100 }).entries).toHaveLength(5)
    m.addHistory('B', entry())
    m.addHistory('C', entry())
    m.addHistory('D', entry()) // evicts A
    expect(m.listHistory('A', { limit: 100 }).entries).toHaveLength(0)
    expect(m.listHistory('D', { limit: 100 }).entries).toHaveLength(1)
    m.dropOwner('D')
    expect(m.listHistory('D', { limit: 100 }).entries).toHaveLength(0)
  })
})

describe('no SQL text in log lines', () => {
  test('store operations log nothing with the text', () => {
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.join(' '))),
    )
    try {
      store = openSqliteStore(join(dir, 'l.db'))
      const text = "SELECT 'needle-literal-123' FROM secret_table"
      store.sql.addHistory('A', entry({ sql: text }))
      store.sql.addHistory('A', entry({ sql: 'x'.repeat(70_000) }))
      store.sql.saveBookmark('A', { targetKey: 't', name: 'n', sql: text, db: null })
      try {
        store.sql.saveBookmark('A', { targetKey: 't', name: 'n', sql: text, db: null })
      } catch {
        // duplicate name
      }
      new MemorySqlState().addHistory('A', entry({ sql: text }))
      expect(lines.join('\n')).not.toMatch(/needle-literal|secret_table/)
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })
})
