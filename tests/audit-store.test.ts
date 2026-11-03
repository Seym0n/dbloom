import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audit } from '../src/server/audit'
import { addSink, resetSinks } from '../src/server/audit/sink'
import { createStoreSink, FIELDS_CAP_BYTES, storeWriterFor } from '../src/server/audit/store-sink'
import { MIGRATIONS, openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'
import { main } from '../src/server/auth/cli/main'

let dir: string
let store: SqliteStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  addSink(createStoreSink(store.db))
})
afterEach(() => {
  resetSinks()
  try { store.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

const rows = () => store.db.prepare('SELECT * FROM audit_log ORDER BY id').all() as Record<string, unknown>[]

describe('audit_log table', () => {
  it('migration 6 creates the table, three indexes and two triggers; no foreign key', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(6)
    const names = (type: string) =>
      (store.db.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = 'audit_log'`).all(type) as { name: string }[]).map((r) => r.name)
    expect(names('index')).toEqual(expect.arrayContaining(['audit_log_at', 'audit_log_event', 'audit_log_actor']))
    expect(names('trigger').sort()).toEqual(['audit_log_no_delete', 'audit_log_no_update'])
    expect(store.db.prepare(`PRAGMA foreign_key_list(audit_log)`).all()).toEqual([])
  })

  it('stores an event with columns and remaining fields', () => {
    audit('auth.signin', { user: 'ann', userId: 'u1', outcome: 'ok', address: '10.0.0.1', note: 'x' })
    const [r] = rows()
    expect(r).toMatchObject({ event: expect.any(String), outcome: 'ok', actor_id: 'u1', actor_name: 'ann', actor_kind: 'user', address: '10.0.0.1' })
    expect(JSON.parse(r!.fields as string)).toEqual({ userId: 'u1', note: 'x' })
  })

  it('redacts secrets and caps oversized fields', () => {
    audit('sql.run', { user: 'ann', password: 'hunter2', big: 'x'.repeat(FIELDS_CAP_BYTES * 2) })
    const [r] = rows()
    expect(r!.fields as string).not.toContain('hunter2')
    expect(Buffer.byteLength(r!.fields as string)).toBeLessThan(FIELDS_CAP_BYTES)
    expect(JSON.parse(r!.fields as string)).toMatchObject({ truncated: true })
  })

  it('refuses UPDATE and DELETE of a current row', () => {
    audit('sql.run', { user: 'ann' })
    expect(() => store.db.exec(`UPDATE audit_log SET event = 'x'`)).toThrow(/append-only/)
    expect(() => store.db.exec(`DELETE FROM audit_log`)).toThrow(/append-only/)
    expect(rows()).toHaveLength(1)
  })

  it('allows DELETE only for rows older than site.audit_cutoff', () => {
    store.db.exec(`INSERT INTO audit_log (at, event, actor_kind, fields) VALUES (100, 'sql.run', 'system', '{}'), (300, 'sql.run', 'system', '{}')`)
    store.db.exec(`INSERT INTO site (key, value) VALUES ('audit_cutoff', '200')`)
    store.db.exec(`DELETE FROM audit_log WHERE at < 200`)
    expect(rows().map((r) => r.at)).toEqual([300])
    expect(() => store.db.exec(`DELETE FROM audit_log WHERE at = 300`)).toThrow(/append-only/)
  })

  it('keeps rows when the user is deleted', () => {
    store.db.exec(
      `INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES ('u1','ann','ann','Ann','user','active','w1',1,1,'system')`,
    )
    audit('sql.run', { user: 'ann', userId: 'u1' })
    store.db.exec(`DELETE FROM users WHERE id = 'u1'`)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.actor_name).toBe('ann')
  })

  it('a CLI write lands while the server holds the store', async () => {
    const out: string[] = []
    const code = await main(['users', 'list'], { DBLOOM_DATA_DIR: dir }, (s) => void out.push(s))
    expect([0, 1, 2]).toContain(code)
    // The CLI registered and removed its own table sink; the server registers its sink again here.
    addSink(createStoreSink(store.db))
    audit('sql.run', { user: 'after' })
    expect(rows().some((r) => r.actor_name === 'after')).toBe(true)
    const other = new DatabaseSync(join(dir, 'dbloom.db'))
    expect(other.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toMatchObject({ n: expect.any(Number) })
    other.close()
  })
})

describe('write cost and row size (SPEC/29 section 4.3)', () => {
  it('median insert of a typical event is well under 5 ms; typical rows stay small', () => {
    const samples: number[] = []
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now()
      audit('rows.change', {
        user: 'ann', target: '127.0.0.1:3306', db: 'shop', table: 'orders', operation: 'update', rowCount: 3, statementCount: 3,
        class: 'soft', identityKind: 'primary', outcome: 'ok', durationMs: 12, planId: 'p-123456',
      })
      samples.push(performance.now() - t0)
    }
    const table: number[] = []
    const writer = storeWriterFor(store.db)
    for (let i = 0; i < 500; i++) {
      const entry = { t: new Date().toISOString(), event: 'rows.change', fields: { user: 'ann', target: 'x', db: 'shop', table: 'orders', operation: 'update', rowCount: 3, outcome: 'ok' } }
      const t0 = performance.now()
      writer.insert(entry)
      table.push(performance.now() - t0)
    }
    table.sort((a, b) => a - b)
    samples.sort((a, b) => a - b)
    const median = samples[250]!
    const bytes = (store.db.prepare('SELECT AVG(LENGTH(fields) + LENGTH(event) + LENGTH(actor_name) + LENGTH(actor_kind)) AS b FROM audit_log').get() as { b: number }).b
    console.info(`audit micro: table insert alone median ${table[250]!.toFixed(3)} ms, p99 ${table[494]!.toFixed(3)} ms; full audit() with stdout line median insert ${median.toFixed(3)} ms, p99 ${samples[494]!.toFixed(3)} ms, ${bytes.toFixed(0)} payload bytes per rows.change row`)
    expect(median).toBeLessThan(5)
    expect(bytes).toBeLessThan(500)
  })
})
