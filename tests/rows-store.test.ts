import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createSqlitePrefs,
  MIGRATIONS,
  openSqliteStore,
  type SqliteStore,
} from '~/server/store/sqlite-store'
import {
  MemoryPrefs,
  parsePrefValue,
  PrefsError,
  pruneLayout,
  pruneSort,
  scopeKey,
  type PrefsStore,
} from '~/server/rows/prefs'
import { boundsFromEnv, resolveRowLimits } from '~/server/rows/limits'
import { DEFAULT_ROW_LIMITS } from '~/server/rows/types'

let dir: string
let store: SqliteStore | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-rows-'))
})
afterEach(() => {
  store?.close()
  store = undefined
  rmSync(dir, { recursive: true, force: true })
})

const layout = { order: ['a', 'b'], hidden: ['b'], widths: { a: 120 } }

describe('ui_prefs migration', () => {
  test('a version 2 file upgrades without touching other data', () => {
    const path = join(dir, 'old.db')
    const old = new DatabaseSync(path)
    MIGRATIONS[0]!(old)
    MIGRATIONS[1]!(old)
    old.exec('PRAGMA user_version = 2')
    old.exec(
      "INSERT INTO sql_bookmarks (id, owner_key, target_key, name, sql, db, created_at, updated_at) VALUES ('1','o','t','n','SELECT 1',NULL,1,1)",
    )
    old.close()

    store = openSqliteStore(path)
    expect(store.sql.listBookmarks('o')).toHaveLength(1)
    store.prefs.set('o', 't', { kind: 'global' }, 'rows.pageSize', 100)
    expect(store.prefs.get('o', 't')['rows.pageSize']).toBe(100)
    store.close()
    store = undefined

    const check = new DatabaseSync(path)
    const v = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(3)
    check.close()
  })
})

type Made = PrefsStore

const implementations: [string, () => Made][] = [
  [
    'sqlite',
    () => {
      const db = new DatabaseSync(':memory:')
      MIGRATIONS.forEach((m) => m(db))
      let t = 1000
      return createSqlitePrefs(db, () => t++, 5)
    },
  ],
  [
    'memory',
    () => {
      let t = 1000
      return new MemoryPrefs(() => t++, 1000, 5)
    },
  ],
]

describe.each(implementations)('prefs store: %s', (_name, make) => {
  test('global is overlaid by the table scope; scopes are separate', () => {
    const p = make()
    p.set('o', 't', { kind: 'global' }, 'rows.pageSize', 25)
    p.set('o', 't', { kind: 'table', db: 'd', table: 'x' }, 'rows.pageSize', 100)
    p.set('o', 't', { kind: 'table', db: 'd', table: 'x' }, 'rows.columns', layout)
    expect(p.get('o', 't')).toEqual({ 'rows.pageSize': 25 })
    expect(p.get('o', 't', { db: 'd', table: 'x' })).toEqual({
      'rows.pageSize': 100,
      'rows.columns': layout,
    })
    expect(p.get('o', 't', { db: 'd', table: 'y' })).toEqual({ 'rows.pageSize': 25 })
  })

  test('owner and target isolation', () => {
    const p = make()
    p.set('alice', 't', { kind: 'global' }, 'rows.fullText', true)
    expect(p.get('bob', 't')).toEqual({})
    expect(p.get('alice', 'other')).toEqual({})
    expect(p.get('alice', 't')).toEqual({ 'rows.fullText': true })
  })

  test('a later write replaces the value', () => {
    const p = make()
    p.set('o', 't', { kind: 'global' }, 'rows.displayChars', 100)
    p.set('o', 't', { kind: 'global' }, 'rows.displayChars', 40)
    expect(p.get('o', 't')['rows.displayChars']).toBe(40)
  })

  test('table scopes are capped and the least recently updated go first', () => {
    const p = make()
    for (let i = 0; i < 5; i++) {
      p.set('o', 't', { kind: 'table', db: 'd', table: `t${i}` }, 'rows.pageSize', 25 + i)
    }
    // touch t0 so t1 becomes the oldest
    p.set('o', 't', { kind: 'table', db: 'd', table: 't0' }, 'rows.pageSize', 500)
    p.set('o', 't', { kind: 'table', db: 'd', table: 'new' }, 'rows.pageSize', 50)
    expect(p.tableScopeCount('o', 't')).toBe(5)
    expect(p.get('o', 't', { db: 'd', table: 't1' })).toEqual({})
    expect(p.get('o', 't', { db: 'd', table: 't0' })['rows.pageSize']).toBe(500)
    expect(p.get('o', 't', { db: 'd', table: 'new' })['rows.pageSize']).toBe(50)
    // another owner is not pruned by this one
    p.set('x', 't', { kind: 'table', db: 'd', table: 'only' }, 'rows.pageSize', 25)
    expect(p.tableScopeCount('x', 't')).toBe(1)
  })

  test('a dot in a name cannot make two scopes collide', () => {
    const p = make()
    p.set('o', 't', { kind: 'table', db: 'a.b', table: 'c' }, 'rows.pageSize', 25)
    p.set('o', 't', { kind: 'table', db: 'a', table: 'b.c' }, 'rows.pageSize', 50)
    expect(p.get('o', 't', { db: 'a.b', table: 'c' })['rows.pageSize']).toBe(25)
    expect(p.get('o', 't', { db: 'a', table: 'b.c' })['rows.pageSize']).toBe(50)
    expect(scopeKey({ kind: 'table', db: 'a.b', table: 'c' })).not.toBe(
      scopeKey({ kind: 'table', db: 'a', table: 'b.c' }),
    )
  })
})

describe('parsePrefValue', () => {
  const table = { kind: 'table', db: 'd', table: 't' } as const
  test('accepts the documented shapes', () => {
    expect(parsePrefValue('rows.pageSize', 100, table)).toBe(100)
    expect(parsePrefValue('rows.columns', layout, table)).toEqual(layout)
    expect(parsePrefValue('rows.sort', [{ column: 'a', direction: 'desc' }], table)).toHaveLength(1)
    expect(parsePrefValue('rows.relationMode', 'links', { kind: 'global' })).toBe('links')
  })
  test('refuses unknown keys, wrong types, ranges, extra keys and global layout', () => {
    expect(() => parsePrefValue('rows.filter', 'x', { kind: 'global' })).toThrow(PrefsError)
    expect(() => parsePrefValue('rows.pageSize', '100', table)).toThrow(PrefsError)
    expect(() => parsePrefValue('rows.pageSize', 5000, table)).toThrow(PrefsError)
    expect(() => parsePrefValue('rows.displayChars', 5, table)).toThrow(PrefsError)
    expect(() => parsePrefValue('rows.columns', { ...layout, extra: 1 }, table)).toThrow(PrefsError)
    expect(() => parsePrefValue('rows.columns', layout, { kind: 'global' })).toThrow(/one table/)
    expect(() => parsePrefValue('rows.relationMode', 'all', table)).toThrow(PrefsError)
  })
  test('a value above 8 KiB is refused', () => {
    const wide = {
      order: Array.from({ length: 2000 }, (_, i) => `column_${i}_long_name`),
      hidden: [],
      widths: {},
    }
    expect(() => parsePrefValue('rows.columns', wide, table)).toThrow(/too large/)
  })
})

describe('layout pruning (DATA-ISS-114)', () => {
  test('drops dropped columns only; widths of survivors stay', () => {
    expect(pruneLayout(layout, ['a', 'c'])).toEqual({
      order: ['a'],
      hidden: [],
      widths: { a: 120 },
    })
    expect(
      pruneSort(
        [
          { column: 'a', direction: 'asc' },
          { column: 'z', direction: 'asc' },
        ],
        ['a'],
      ),
    ).toEqual([{ column: 'a', direction: 'asc' }])
    expect(pruneLayout('junk', ['a'])).toBeUndefined()
  })
})

describe('stateless fallback', () => {
  test('memory prefs die with the owner and are bounded in owners', () => {
    const m = new MemoryPrefs(Date.now, 2)
    m.set('s1', 't', { kind: 'global' }, 'rows.pageSize', 25)
    m.set('s2', 't', { kind: 'global' }, 'rows.pageSize', 25)
    m.set('s3', 't', { kind: 'global' }, 'rows.pageSize', 25)
    expect(m.get('s1', 't')).toEqual({})
    m.dropOwner('s2')
    expect(m.get('s2', 't')).toEqual({})
    expect(m.get('s3', 't')['rows.pageSize']).toBe(25)
  })
})

describe('resolveRowLimits', () => {
  const bounds = boundsFromEnv({})
  test('defaults', () => {
    const l = resolveRowLimits({}, bounds)
    expect(l.defaultPageSize).toBe(DEFAULT_ROW_LIMITS.defaultPageSize)
    expect(l.exactCountThreshold).toBe(50_000)
    expect(l.viewCountCap).toBe(10_000)
    expect(l.cellBytes).toBe(64 * 1024)
  })
  test('preferences only lower the bound', () => {
    expect(resolveRowLimits({ 'rows.countThreshold': 1000 }, bounds).exactCountThreshold).toBe(1000)
    expect(resolveRowLimits({ 'rows.countThreshold': 9_999_999 }, bounds).exactCountThreshold).toBe(
      50_000,
    )
    expect(resolveRowLimits({ 'rows.pageSize': 5000 }, bounds).defaultPageSize).toBe(1000)
    expect(resolveRowLimits({ 'rows.displayChars': 5 }, bounds).displayChars).toBe(20)
    expect(resolveRowLimits({ 'rows.displayChars': 5000 }, bounds).displayChars).toBe(1000)
  })
  test('the environment lowers the bounds and wins over preferences', () => {
    const b = boundsFromEnv({
      DBLOOM_ROWS_EXACT_COUNT_THRESHOLD: '1000',
      DBLOOM_ROWS_MAX_PAGE_SIZE: '100',
      DBLOOM_ROWS_UPLOAD_BYTES: '1024',
      DBLOOM_ROWS_VIEW_COUNT_CAP: 'junk',
    })
    const l = resolveRowLimits({ 'rows.countThreshold': 50_000, 'rows.pageSize': 500 }, b)
    expect(l.exactCountThreshold).toBe(1000)
    expect(l.maxPageSize).toBe(100)
    expect(l.defaultPageSize).toBe(100)
    expect(l.pageSizes.every((s) => s <= 100)).toBe(true)
    expect(l.uploadBytes).toBe(1024)
    expect(l.viewCountCap).toBe(10_000)
  })
})
