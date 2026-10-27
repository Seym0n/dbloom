import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from '~/server/config'
import {
  IO_DEFAULTS,
  ioBoundsFromConfig,
  limitsFor,
  resolveIoLimits,
  uploadLimitNote,
} from '~/server/io/limits'
import {
  IoStoreError,
  MemoryIoPrefs,
  MemoryIoTemplates,
  parseIoPref,
  setIoPref,
  validateStoredPrefs,
  type IoPrefsStore,
  type IoTemplateStore,
} from '~/server/io/store'
import { GiB, MAX_TEMPLATES, MiB } from '~/server/io/types'
import {
  MIGRATIONS,
  createSqliteIoPrefs,
  createSqliteIoTemplates,
  openSqliteStore,
  type SqliteStore,
} from '~/server/store/sqlite-store'

describe('resolveIoLimits (FR-IO-022, section 5.8)', () => {
  test('defaults: 64 MiB upload, 1 GiB decompressed, 900 s, 1 GiB export, 1 import', () => {
    const l = resolveIoLimits()
    expect(l.uploadBytes).toBe(64 * MiB)
    expect(l.decompressedBytes).toBe(1 * GiB)
    expect(l.jobMs).toBe(900_000)
    expect(l.maxExportBytes).toBe(1 * GiB)
    expect(l.concurrentImports).toBe(1)
    expect(l.formats).toEqual(['sql', 'csv', 'json'])
    expect(l.compressions).toEqual(['none', 'gzip', 'zip'])
    expect(l.serverFolderEnabled).toBe(false)
    expect(l.formulaNeutralisation).toBe(true)
    expect(l.tempQuotaBytes).toBe(10_240 * MiB)
    expect(l.uploadLimitedBy).toBe('default')
    expect(IO_DEFAULTS.uploadBytes).toBe(64 * MiB)
  })

  test('the environment bound lowers the default and wins over a larger preference', () => {
    const bounds = ioBoundsFromConfig({ importMaxMiB: 16 })
    expect(resolveIoLimits({}, bounds).uploadBytes).toBe(16 * MiB)
    expect(resolveIoLimits({}, bounds).uploadLimitedBy).toBe('environment')
    expect(resolveIoLimits({ 'io.uploadMiB': 500 }, bounds).uploadBytes).toBe(16 * MiB)
    expect(resolveIoLimits({ 'io.uploadMiB': 8 }, bounds).uploadBytes).toBe(8 * MiB)
    expect(resolveIoLimits({ 'io.uploadMiB': 8 }, bounds).uploadLimitedBy).toBe('preference')
  })

  test('a preference may raise the default up to the bound and never below the floor', () => {
    expect(resolveIoLimits({ 'io.uploadMiB': 512 }).uploadBytes).toBe(512 * MiB)
    expect(resolveIoLimits({ 'io.uploadMiB': 0 }).uploadBytes).toBe(1 * MiB)
    expect(resolveIoLimits({ 'io.jobSeconds': 10 }).jobMs).toBe(60_000)
    expect(resolveIoLimits({ 'io.jobSeconds': 99_999 }).jobMs).toBe(7_200_000)
    expect(resolveIoLimits({ 'io.maxExportMiB': 99_999 }).maxExportBytes).toBe(8 * GiB)
    expect(resolveIoLimits({ 'io.decompressedMiB': 99_999 }).decompressedBytes).toBe(4 * GiB)
    expect(resolveIoLimits({ 'io.concurrentImports': 3 }).concurrentImports).toBe(3)
    expect(resolveIoLimits({ 'io.concurrentImports': 9 }).concurrentImports).toBe(3)
    expect(resolveIoLimits({ 'io.concurrentImports': 0 }).concurrentImports).toBe(1)
  })

  test('a proxy body limit is a bound too and is named as the reason', () => {
    const l = resolveIoLimits({}, { ...ioBoundsFromConfig(), proxyBodyBytes: 10 * MiB })
    expect(l.uploadBytes).toBe(10 * MiB)
    expect(l.uploadLimitedBy).toBe('proxy')
    expect(uploadLimitNote(l)).toMatch(/10 MiB/)
    expect(uploadLimitNote(l)).toMatch(/web server/)
  })

  test('formats and compressions are the intersection of the bound and the choice', () => {
    const bounds = { ...ioBoundsFromConfig(), formats: ['sql', 'csv'] as const }
    expect(resolveIoLimits({ 'io.formats': ['json', 'csv'] }, bounds).formats).toEqual(['csv'])
    expect(resolveIoLimits({ 'io.formats': ['sql'] }, bounds).formats).toEqual(['sql'])
    // an empty or foreign choice never switches the page off
    expect(resolveIoLimits({ 'io.formats': [] }, bounds).formats).toEqual(['sql', 'csv'])
    expect(resolveIoLimits({ 'io.compressions': ['zip'] }).compressions).toEqual(['zip'])
  })

  test('the server folder needs the environment; the user can only switch it off', () => {
    const on = ioBoundsFromConfig({ importDir: '/data/import' })
    expect(resolveIoLimits({}, on).serverFolderEnabled).toBe(true)
    expect(resolveIoLimits({ 'io.serverFolder': false }, on).serverFolderEnabled).toBe(false)
    expect(resolveIoLimits({ 'io.serverFolder': true }).serverFolderEnabled).toBe(false)
  })

  test('formula neutralisation is on unless the user opts out and the administrator allows it', () => {
    expect(resolveIoLimits({ 'io.formulaNeutralisation': false }).formulaNeutralisation).toBe(false)
    const locked = { ...ioBoundsFromConfig(), formulaOptOut: false }
    expect(
      resolveIoLimits({ 'io.formulaNeutralisation': false }, locked).formulaNeutralisation,
    ).toBe(true)
  })

  test('limitsFor reads the stored preferences and ignores invalid stored values', () => {
    const prefs = new MemoryIoPrefs()
    prefs.set('o', 't', 'io.uploadMiB', 20)
    prefs.set('o', 't', 'io.jobSeconds', 'soon') // fails its schema
    const l = limitsFor(prefs, 'o', 't', {})
    expect(l.uploadBytes).toBe(20 * MiB)
    expect(l.jobMs).toBe(900_000)
    expect(limitsFor(prefs, 'other', 't', {}).uploadBytes).toBe(64 * MiB)
  })
})

describe('configuration (new variables)', () => {
  const base = { DBLOOM_DIRECT_FREE_FORM_ACK: 'true' }
  test('defaults', () => {
    const c = loadConfig(base)
    expect(c.tempDir).toBeUndefined()
    expect(c.tempQuotaMiB).toBe(10_240)
    expect(c.importMaxMiB).toBe(2048)
    expect(c.importDir).toBeUndefined()
  })
  test('values are read', () => {
    const dir = process.platform === 'win32' ? 'C:\\imports' : '/srv/import'
    const c = loadConfig({
      ...base,
      DBLOOM_TEMP_DIR: ' /var/tmp/dbloom ',
      DBLOOM_TEMP_QUOTA_MIB: '500',
      DBLOOM_IMPORT_MAX_MIB: '128',
      DBLOOM_IMPORT_DIR: dir,
    })
    expect(c.tempDir).toBe('/var/tmp/dbloom')
    expect(c.tempQuotaMiB).toBe(500)
    expect(c.importMaxMiB).toBe(128)
    expect(c.importDir).toBe(dir)
  })
  test('invalid values stop the start with a message naming the variable', () => {
    expect(() => loadConfig({ ...base, DBLOOM_TEMP_QUOTA_MIB: '0' })).toThrow(
      /DBLOOM_TEMP_QUOTA_MIB/,
    )
    expect(() => loadConfig({ ...base, DBLOOM_TEMP_QUOTA_MIB: 'lots' })).toThrow(
      /DBLOOM_TEMP_QUOTA_MIB/,
    )
    expect(() => loadConfig({ ...base, DBLOOM_IMPORT_MAX_MIB: '4096' })).toThrow(
      /DBLOOM_IMPORT_MAX_MIB/,
    )
    expect(() => loadConfig({ ...base, DBLOOM_IMPORT_MAX_MIB: '1.5' })).toThrow(
      /DBLOOM_IMPORT_MAX_MIB/,
    )
    expect(() => loadConfig({ ...base, DBLOOM_IMPORT_DIR: 'relative/dir' })).toThrow(
      /DBLOOM_IMPORT_DIR/,
    )
  })
  test('config feeds the bounds', () => {
    const b = ioBoundsFromConfig(
      loadConfig({ ...base, DBLOOM_IMPORT_MAX_MIB: '32', DBLOOM_TEMP_QUOTA_MIB: '7' }),
    )
    expect(b.uploadMaxBytes).toBe(32 * MiB)
    expect(b.tempQuotaBytes).toBe(7 * MiB)
  })
})

describe('preference values', () => {
  test('keys and values are checked', () => {
    expect(parseIoPref('io.exportFormat', 'csv')).toBe('csv')
    expect(() => parseIoPref('io.exportFormat', 'xml')).toThrow(IoStoreError)
    expect(() => parseIoPref('rows.pageSize', 10)).toThrow(IoStoreError)
    expect(() => parseIoPref('io.uploadMiB', 1.5)).toThrow(IoStoreError)
    expect(() => parseIoPref('io.options.csv', { bogus: 1 })).toThrow(IoStoreError)
    expect(parseIoPref('io.options.csv', { separator: ';' })).toMatchObject({
      separator: ';',
      header: true,
    })
    expect(() => parseIoPref('io.lastExport', { a: 'x'.repeat(9000) })).toThrow(/too large/)
  })
  test('stale stored values are reported and left out (FR-UPD-004)', () => {
    const r = validateStoredPrefs({ 'io.exportFormat': 'xml', 'io.mode': 'quick' })
    expect(r.invalid).toEqual(['io.exportFormat'])
    expect(r.values).toEqual({ 'io.mode': 'quick' })
  })
})

let dir: string
let store: SqliteStore | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-io-'))
})
afterEach(() => {
  store?.close()
  store = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('io_templates migration', () => {
  test('an older file upgrades and keeps its data; the version is the migration count', () => {
    const path = join(dir, 'old.db')
    const old = new DatabaseSync(path)
    for (let i = 0; i < 3; i++) MIGRATIONS[i]!(old)
    old.exec('PRAGMA user_version = 3')
    old.exec(
      "INSERT INTO sql_bookmarks (id, owner_key, target_key, name, sql, db, created_at, updated_at) VALUES ('1','o','t','n','SELECT 1',NULL,1,1)",
    )
    old.close()
    store = openSqliteStore(path)
    expect(store.sql.listBookmarks('o')).toHaveLength(1)
    store.ioTemplates.save('o', 'table', 'mine', { format: 'csv' })
    expect(store.ioTemplates.list('o')).toHaveLength(1)
    store.close()
    store = undefined
    const check = new DatabaseSync(path)
    const v = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4)
    check.close()
  })
})

const prefsImplementations: [string, () => IoPrefsStore][] = [
  [
    'sqlite',
    () => {
      const db = new DatabaseSync(':memory:')
      MIGRATIONS.forEach((m) => m(db))
      return createSqliteIoPrefs(db)
    },
  ],
  ['memory', () => new MemoryIoPrefs()],
]

describe.each(prefsImplementations)('io defaults (%s)', (_name, make) => {
  test('values round trip per owner and target; the rows keys are not mixed in', () => {
    const s = make()
    setIoPref(s, 'o1', 't', 'io.exportFormat', 'json')
    setIoPref(s, 'o1', 't', 'io.options.json', { pretty: false })
    setIoPref(s, 'o1', 't', 'io.exportFormat', 'csv') // overwrite
    expect(s.get('o1', 't')['io.exportFormat']).toBe('csv')
    expect(s.get('o1', 't')['io.options.json']).toEqual({ pretty: false, unicode: true })
    expect(s.get('o2', 't')).toEqual({})
    expect(s.get('o1', 'other')).toEqual({})
  })
  test('a value that fails the schema is refused before it is stored', () => {
    const s = make()
    expect(() => setIoPref(s, 'o', 't', 'io.exportFormat', 'xml')).toThrow(IoStoreError)
    expect(s.get('o', 't')).toEqual({})
  })
})

const templateImplementations: [string, () => IoTemplateStore][] = [
  [
    'sqlite',
    () => {
      const db = new DatabaseSync(':memory:')
      MIGRATIONS.forEach((m) => m(db))
      let t = 1
      return createSqliteIoTemplates(db, () => t++)
    },
  ],
  [
    'memory',
    () => {
      let t = 1
      return new MemoryIoTemplates(() => t++)
    },
  ],
]

describe.each(templateImplementations)('io templates (%s)', (_name, make) => {
  test('save, list, update by name, delete', () => {
    const s = make()
    s.save('o', 'table', 'b', { format: 'csv' })
    s.save('o', 'table', 'a', { format: 'json' })
    s.save('o', 'database', 'a', { format: 'sql' })
    expect(s.list('o', 'table').map((t) => t.name)).toEqual(['a', 'b'])
    expect(s.list('o')).toHaveLength(3)
    const upd = s.save('o', 'table', 'a', { format: 'sql' })
    expect(upd.options).toEqual({ format: 'sql' })
    expect(s.list('o', 'table')).toHaveLength(2)
    expect(s.list('o', 'table').find((t) => t.name === 'a')?.options).toEqual({ format: 'sql' })
    expect(s.delete('o', 'table', 'a')).toBe(true)
    expect(s.delete('o', 'table', 'a')).toBe(false)
    expect(s.list('o', 'table')).toHaveLength(1)
  })
  test('other owners see nothing and cannot delete', () => {
    const s = make()
    s.save('o', 'table', 'a', {})
    expect(s.list('x')).toEqual([])
    expect(s.delete('x', 'table', 'a')).toBe(false)
    expect(s.list('o')).toHaveLength(1)
  })
  test(`at most ${MAX_TEMPLATES} per owner and kind; replacing is still allowed`, () => {
    const s = make()
    for (let i = 0; i < MAX_TEMPLATES; i++) s.save('o', 'table', `n${i}`, { i })
    expect(() => s.save('o', 'table', 'one-more', {})).toThrow(
      expect.objectContaining({ code: 'template-limit' }),
    )
    expect(() => s.save('o', 'table', 'n3', { i: 'new' })).not.toThrow()
    expect(() => s.save('o', 'database', 'fresh', {})).not.toThrow()
    expect(() => s.save('p', 'table', 'fresh', {})).not.toThrow()
  })
  test('names and options are checked', () => {
    const s = make()
    expect(() => s.save('o', 'table', '   ', {})).toThrow(IoStoreError)
    expect(() => s.save('o', 'table', 'a\nb', {})).toThrow(IoStoreError)
    expect(() => s.save('o', 'table', 'x'.repeat(121), {})).toThrow(IoStoreError)
    expect(() => s.save('o', 'galaxy' as never, 'a', {})).toThrow(IoStoreError)
    expect(() => s.save('o', 'table', 'a', { big: 'x'.repeat(20_000) })).toThrow(IoStoreError)
    expect(() => s.save('o', 'table', 'a', [] as never)).toThrow(IoStoreError)
    expect(s.save('o', 'table', '  trimmed ', {}).name).toBe('trimmed')
  })
  test('names are data: a quote or SQL text is stored as written', () => {
    const s = make()
    const evil = "x'; DROP TABLE io_templates; --"
    s.save('o', 'table', evil, { a: 1 })
    expect(s.list('o').map((t) => t.name)).toEqual([evil])
  })
})
