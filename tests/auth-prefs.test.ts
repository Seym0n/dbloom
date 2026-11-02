/** Package D: preferences registry, service, backends (SPEC/26 task 9; FR-AUT-024, 025). */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { migrate, createSqlitePrefs, createSqliteIoPrefs } from '~/server/store/sqlite-store'
import { createSqlitePrefsBackend, MemoryPrefsBackend, type PrefsBackend } from '~/server/auth/prefs/backend'
import { createDefaultPrefsRegistry, createPrefsRegistry } from '~/server/auth/prefs/registry'
import { createPrefsService, PREFS_MAX_TARGETS } from '~/server/auth/prefs/service'
import { PREFS_EXPORT_VERSION, PREFS_IMPORT_MAX_BYTES } from '~/server/auth/types'

const T = 'db.example:3306|root'
const sqlite = () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  migrate(db)
  return { db, backend: createSqlitePrefsBackend(db) }
}
const make = (backend: PrefsBackend, now = () => 1000) => createPrefsService(backend, createDefaultPrefsRegistry(), now)
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return undefined
}
const file = (user: Record<string, unknown>, targets: Record<string, unknown> = {}) =>
  JSON.stringify({ dbloomPreferences: 1, exportedAt: 'x', user, targets })

describe.each([
  ['sqlite', () => sqlite().backend],
  ['memory', () => new MemoryPrefsBackend()],
])('prefs service (%s)', (_n, mk) => {
  it('returns defaults, then stored values per key', () => {
    const s = make(mk())
    expect(s.get('u:1')).toMatchObject({ theme: 'system', language: 'en', navWidth: 244, loginLanding: true })
    expect(s.get('u:1')).not.toHaveProperty('hiddenDatabases')
    expect(s.get('u:1', T)).toMatchObject({ hiddenDatabases: [], collation: null, 'rows.pageSize': 50 })
    s.set('u:1', 'theme', 'dark')
    s.set('u:1', 'hiddenDatabases', ['a', 'b'], T)
    expect(s.get('u:1').theme).toBe('dark')
    expect(s.get('u:1', T).hiddenDatabases).toEqual(['a', 'b'])
    expect(s.get('u:2').theme).toBe('system')
    expect(s.get('u:1', 'other:1|x').hiddenDatabases).toEqual([])
  })

  it('refuses unknown keys, bad values, wrong scope', () => {
    const s = make(mk())
    expect(code(() => s.set('u:1', 'nope', 1))).toBe('unknown-key')
    expect(code(() => s.set('u:1', 'secret', 1))).toBe('unknown-key')
    expect(code(() => s.set('u:1', 'theme', 'blue'))).toBe('invalid-value')
    expect(code(() => s.set('u:1', 'language', 'xx'))).toBe('invalid-value')
    expect(code(() => s.set('u:1', 'navWidth', 5))).toBe('invalid-value')
    expect(code(() => s.set('u:1', 'hiddenDatabases', Array.from({ length: 501 }, (_, i) => `d${i}`), T))).toBe('invalid-value')
    expect(code(() => s.set('u:1', 'hiddenDatabases', ['a']))).toBe('target-required')
    expect(code(() => s.set('u:1', 'theme', 'dark', T))).toBe('target-forbidden')
    expect(code(() => s.set('u:1', 'rows.columns', {}, T))).toBe('unknown-key')
    expect(s.get('u:1').theme).toBe('system')
  })

  it('collation is optional (null clears) and validated', () => {
    const s = make(mk())
    s.set('u:1', 'collation', 'utf8mb4_bin', T)
    expect(s.get('u:1', T).collation).toBe('utf8mb4_bin')
    s.set('u:1', 'collation', null, T)
    expect(s.get('u:1', T).collation).toBeNull()
    expect(code(() => s.set('u:1', 'collation', 'a b;', T))).toBe('invalid-value')
  })

  it('a partial save touches no other key (FR-UPD-003)', () => {
    const b = mk()
    const s = make(b)
    s.set('u:1', 'theme', 'dark')
    s.set('u:1', 'navWidth', 300)
    const before = JSON.stringify(b.rows('u:1').filter((r) => r.key === 'theme'))
    s.set('u:1', 'navWidth', 320)
    expect(JSON.stringify(b.rows('u:1').filter((r) => r.key === 'theme'))).toBe(before)
    expect(s.get('u:1')).toMatchObject({ theme: 'dark', navWidth: 320 })
  })

  it('damaged or outdated stored values fall back to the default', () => {
    const b = mk()
    const s = make(b)
    b.put('u:1', { targetKey: '*', scope: 'prefs', key: 'theme', value: '"purple"', updatedAt: 1 })
    b.put('u:1', { targetKey: '*', scope: 'prefs', key: 'navWidth', value: '{oops', updatedAt: 1 })
    expect(s.get('u:1')).toMatchObject({ theme: 'system', navWidth: 244 })
    expect(s.export('u:1').user).toEqual({})
  })

  it('caps target keys per owner', () => {
    const s = make(mk())
    for (let i = 0; i < PREFS_MAX_TARGETS; i++) s.set('u:1', 'collation', null, `t${i}`)
    expect(code(() => s.set('u:1', 'collation', null, 'extra'))).toBe('too-many-targets')
    s.set('u:1', 'collation', 'utf8mb4_bin', 't0')
  })

  it('tracks the last save time and resets only the owner', () => {
    let t = 1000
    const s = make(mk(), () => t)
    expect(s.lastSavedAt('u:1')).toBeNull()
    s.set('u:1', 'theme', 'dark')
    t = 2000
    s.set('u:1', 'navWidth', 200)
    s.set('u:2', 'theme', 'light')
    expect(s.lastSavedAt('u:1')).toBe(2000)
    s.reset('u:1')
    expect(s.get('u:1').theme).toBe('system')
    expect(s.lastSavedAt('u:1')).toBeNull()
    expect(s.get('u:2').theme).toBe('light')
  })

  it('exports without secrets and imports it back (round trip)', () => {
    const s = make(mk(), () => Date.UTC(2026, 0, 1))
    s.set('u:1', 'theme', 'dark')
    s.set('u:1', 'hiddenDatabases', ['x'], T)
    s.set('u:1', 'rows.pageSize', 100, T)
    s.set('u:1', 'io.options.json', { pretty: false }, T)
    const out = s.export('u:1')
    expect(out).toMatchObject({ dbloomPreferences: PREFS_EXPORT_VERSION, exportedAt: '2026-01-01T00:00:00.000Z', user: { theme: 'dark' } })
    expect(out.targets[T]).toMatchObject({ hiddenDatabases: ['x'], 'rows.pageSize': 100, 'io.options.json': { pretty: false, unicode: true } })
    const text = JSON.stringify(out)
    expect(text).not.toMatch(/password|secret|totp|passkey/i)
    const r = s.import('u:2', { json: text, mode: 'merge', validOnly: false })
    expect(r).toMatchObject({ written: 4, skipped: 0, problems: [] })
    expect(s.export('u:2')).toEqual(out)
  })

  it('import lists every invalid entry and writes nothing unless validOnly', () => {
    const s = make(mk())
    s.set('u:1', 'theme', 'light')
    const json = file(
      { theme: 'dark', navWidth: 1, nope: 1, hiddenDatabases: [] },
      { [T]: { 'rows.pageSize': 'many', collation: 'utf8mb4_bin', theme: 'dark' } },
    )
    const r = s.import('u:1', { json, mode: 'merge', validOnly: false })
    expect(r.written).toBe(0)
    expect(r.problems).toEqual([
      { key: 'navWidth', reason: 'invalid_value' },
      { key: 'nope', reason: 'unknown_key' },
      { key: 'hiddenDatabases', reason: 'wrong_section' },
      { key: 'rows.pageSize', target: T, reason: 'invalid_value' },
      { key: 'theme', target: T, reason: 'wrong_section' },
    ])
    expect(s.get('u:1').theme).toBe('light')
    const v = s.import('u:1', { json, mode: 'merge', validOnly: true })
    expect(v).toMatchObject({ written: 2, skipped: 5 })
    expect(s.get('u:1').theme).toBe('dark')
    expect(s.get('u:1', T).collation).toBe('utf8mb4_bin')
  })

  it('a target named "user" is not the user section', () => {
    const s = make(mk())
    const r = s.import('u:1', { json: file({}, { user: { theme: 'dark', collation: null } }), mode: 'merge', validOnly: true })
    expect(r.problems).toEqual([{ key: 'theme', target: 'user', reason: 'wrong_section' }])
    expect(r.written).toBe(1)
  })

  it('merge keeps other keys, replace drops registry values not in the file', () => {
    const s = make(mk())
    s.set('u:1', 'theme', 'dark')
    s.set('u:1', 'navWidth', 300)
    s.set('u:1', 'collation', 'utf8mb4_bin', T)
    const json = file({ theme: 'light' })
    s.import('u:1', { json, mode: 'merge', validOnly: false })
    expect(s.get('u:1')).toMatchObject({ theme: 'light', navWidth: 300 })
    s.import('u:1', { json, mode: 'replace', validOnly: false })
    expect(s.get('u:1')).toMatchObject({ theme: 'light', navWidth: 244 })
    expect(s.get('u:1', T).collation).toBeNull()
  })

  it('replace with problems and no validOnly leaves everything as it was', () => {
    const s = make(mk())
    s.set('u:1', 'navWidth', 300)
    expect(s.import('u:1', { json: file({ theme: 'nope' }), mode: 'replace', validOnly: false }).written).toBe(0)
    expect(s.get('u:1').navWidth).toBe(300)
  })

  it('refuses a bad, wrong-version, oversized or non-JSON file', () => {
    const s = make(mk())
    const bad = (json: string) => s.import('u:1', { json, mode: 'merge', validOnly: true })
    expect(bad('{nope').problems).toEqual([{ key: '', reason: 'invalid_file' }])
    expect(bad('[]').problems[0]?.reason).toBe('invalid_file')
    expect(bad(JSON.stringify({ dbloomPreferences: 2, exportedAt: 'x', user: {}, targets: {} })).problems[0]?.reason).toBe('invalid_file')
    expect(bad(JSON.stringify({ dbloomPreferences: 1, exportedAt: 'x', user: {}, targets: {}, extra: 1 })).problems[0]?.reason).toBe('invalid_file')
    expect(bad('x'.repeat(PREFS_IMPORT_MAX_BYTES + 1)).problems).toEqual([{ key: '', reason: 'file_too_large' }])
    expect(bad('é'.repeat(PREFS_IMPORT_MAX_BYTES / 2 + 1)).problems[0]?.reason).toBe('file_too_large')
  })

  it('import respects the target cap', () => {
    const s = make(mk())
    const targets: Record<string, unknown> = {}
    for (let i = 0; i < PREFS_MAX_TARGETS + 2; i++) targets[`t${i}`] = { collation: null }
    const r = s.import('u:1', { json: file({}, targets), mode: 'merge', validOnly: true })
    expect(r.written).toBe(PREFS_MAX_TARGETS)
    expect(r.problems.map((p) => p.reason)).toEqual(['too_many_targets', 'too_many_targets'])
  })

  it('deleteOwner removes all rows', () => {
    const b = mk()
    const s = make(b)
    s.set('u:1', 'theme', 'dark')
    s.deleteOwner('u:1')
    expect(b.rows('u:1')).toEqual([])
  })
})

describe('registry', () => {
  it('has the auth, rows and io keys, each with a valid default', () => {
    const r = createDefaultPrefsRegistry()
    const keys = r.all().map((d) => d.key)
    for (const k of ['theme', 'language', 'hiddenDatabases', 'navWidth', 'collation', 'loginLanding', 'rows.pageSize', 'io.exportFormat', 'io.options.csv']) {
      expect(keys).toContain(k)
    }
    for (const d of r.all()) expect(d.schema.safeParse(d.default).success, d.key).toBe(true)
    expect(r.get('theme')?.scope).toBe('user')
    expect(r.get('hiddenDatabases')?.scope).toBe('user+target')
    expect(r.get('rows.pageSize')?.storedAs).toEqual({ scope: 'global', key: 'rows.pageSize' })
    expect(r.get('io.mode')?.storedAs).toEqual({ scope: 'io', key: 'io.mode' })
    expect(r.get('rows.columns')).toBeUndefined()
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('refuses a duplicate key', () => {
    const r = createPrefsRegistry()
    const d = createDefaultPrefsRegistry().get('theme')!
    r.register(d)
    expect(() => r.register(d)).toThrow()
  })

  it('other modules can register keys', () => {
    const r = createDefaultPrefsRegistry()
    r.register({ key: 'sql.x', module: 'sql', scope: 'user', category: 'sql', schema: z.boolean(), default: false, label: 'prefs.sql.x' })
    const s = createPrefsService(new MemoryPrefsBackend(), r)
    s.set('u:1', 'sql.x', true)
    expect(s.get('u:1')['sql.x']).toBe(true)
  })
})

describe('rows and io keys stay compatible with their stores', () => {
  it('registry writes are read by the rows and io stores, and vice versa', () => {
    const { db, backend } = sqlite()
    const s = make(backend)
    s.set('d:1', 'rows.pageSize', 250, T)
    s.set('d:1', 'io.exportFormat', 'csv', T)
    expect(createSqlitePrefs(db).get('d:1', T)['rows.pageSize']).toBe(250)
    expect(createSqliteIoPrefs(db).get('d:1', T)['io.exportFormat']).toBe('csv')
    createSqlitePrefs(db).set('d:1', T, { kind: 'global' }, 'rows.insertRows', 5)
    createSqliteIoPrefs(db).set('d:1', T, 'io.mode', 'custom')
    const v = s.get('d:1', T)
    expect(v['rows.insertRows']).toBe(5)
    expect(v['io.mode']).toBe('custom')
  })

  it('table layouts of rows are untouched by import and replace, reset clears them', () => {
    const { db, backend } = sqlite()
    const s = make(backend)
    const tbl = { db: 'a', table: 'b' }
    createSqlitePrefs(db).set('d:1', T, { kind: 'table', ...tbl }, 'rows.sort', [{ column: 'id', direction: 'asc' }])
    s.import('d:1', { json: file({}), mode: 'replace', validOnly: false })
    expect(createSqlitePrefs(db).get('d:1', T, tbl)['rows.sort']).toHaveLength(1)
    s.reset('d:1')
    expect(createSqlitePrefs(db).get('d:1', T, tbl)['rows.sort']).toBeUndefined()
  })

  it('sqlite transaction rolls back on failure', () => {
    const { backend } = sqlite()
    expect(() =>
      backend.transaction(() => {
        backend.put('o', { targetKey: '*', scope: 'prefs', key: 'theme', value: '"dark"', updatedAt: 1 })
        throw new Error('x')
      }),
    ).toThrow()
    expect(backend.rows('o')).toEqual([])
  })

  it('a failing write is reported as save-failed and keeps the old value', () => {
    const b = new MemoryPrefsBackend()
    const s = make(b)
    s.set('u:1', 'theme', 'dark')
    b.put = () => {
      throw new Error('disk full')
    }
    expect(code(() => s.set('u:1', 'theme', 'light'))).toBe('save-failed')
    expect(s.get('u:1').theme).toBe('dark')
  })
})
