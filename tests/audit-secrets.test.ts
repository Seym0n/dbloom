/** SPEC/29 FR-AAU-011: known secret values seeded into every field position of every wrapper reach no sink. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  audit, auditIo, auditRowsChange, auditRowsRefused, auditSqlRun, auditSqlStatement, auditStructure,
  registerAuditStore, setAuditContext, unregisterAuditStore,
} from '../src/server/audit'
import { createFileSink, type FileSink } from '../src/server/audit/file-sink'
import { addSink, resetSinks } from '../src/server/audit/sink'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

const SECRET = 'Zq9-top-secret-VALUE-77'
/** Forms in which a credential reaches a text field by mistake. */
const CARRIERS = [`Bearer ${SECRET}`, `https://host.example/path?token=${SECRET}&x=1`, `GET /x?password=${SECRET}`]

let dir: string
let store: SqliteStore
let file: FileSink
let stdout: string[]

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-sec-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  registerAuditStore(store.db)
  file = createFileSink({ path: join(dir, 'audit.log') })
  addSink(file)
  stdout = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => void stdout.push(String(line)))
  setAuditContext(() => ({ address: `Bearer ${SECRET}` }))
})
afterEach(() => {
  vi.useRealTimers()
  setAuditContext(undefined)
  unregisterAuditStore()
  resetSinks()
  vi.restoreAllMocks()
  file.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Everything every sink holds right now. */
function everything(): string {
  file.flush()
  const table = JSON.stringify(store.db.prepare('SELECT * FROM audit_log').all())
  return [stdout.join('\n'), table, readFileSync(join(dir, 'audit.log'), 'utf8')].join('\n')
}

/** An object with every key set to `value`; numbers stay numbers. */
const all = <T extends object>(template: T, value: string): T =>
  Object.fromEntries(Object.entries(template).map(([k, v]) => [k, typeof v === 'string' ? value : v])) as T

describe('no secret reaches a sink', () => {
  it.each(CARRIERS)('wrappers, every string position, carrier %#', (carrier) => {
    auditStructure(all({ user: 'u', target: 't', kind: 'k', class: 'c', statementHash: 'h', outcome: 'o' }, carrier) as never)
    auditSqlRun(all({ user: 'u', target: 't', runId: 'r', statements: 1, maxClass: 'none', outcome: 'ok', code: 'c', source: 'user' }, carrier) as never)
    auditSqlStatement(all({ user: 'u', target: 't', runId: 'r', index: 1, kind: 'k', class: 'none', statementHash: 'h', outcome: 'failed' }, carrier) as never)
    auditRowsChange(all({ user: 'u', target: 't', db: 'd', table: 'x', operation: 'insert', rowCount: 1, statementCount: 1, maxClass: 'none', identityKind: 'primary', outcome: 'ok', planId: 'p' }, carrier) as never)
    auditRowsRefused(all({ user: 'u', target: 't', db: 'd', table: 'x', operation: 'insert', code: 'c' }, carrier) as never)
    auditIo('io.export.start', all({ user: 'u', target: 't', jobId: 'j', uploadId: 'u', kind: 'export', scope: 's', format: 'f', compression: 'c', db: 'd', objects: 'o', fileName: 'n', classCounts: 'cc', state: 's', errorCode: 'e', statementHash: 'h' }, carrier) as never)
    const text = everything()
    expect(text).not.toContain(SECRET)
    expect(text.split('\n').filter(Boolean).length).toBeGreaterThan(6) // events were written everywhere
  })

  it('secret-named and nested fields on the generic call, including the column fields', () => {
    audit('sql.run', {
      user: 'u', password: SECRET, token: SECRET, cookie: SECRET, authorization: SECRET, passphrase: SECRET,
      secret: SECRET, apiKey: SECRET, credential: SECRET, body: SECRET, payload: SECRET, key: SECRET,
      subject: `Bearer ${SECRET}`, outcome: `?token=${SECRET}`, address: `Bearer ${SECRET}`, actor: `Bearer ${SECRET}`,
      newPassword: SECRET, sessionToken: SECRET,
    })
    expect(everything()).not.toContain(SECRET)
  })

  it('the request-context address is covered too', () => {
    audit('audit.purge', { count: 1 })
    expect(everything()).not.toContain(SECRET)
  })

  it('stable short codes survive redaction in every sink', () => {
    audit('rows.refused', { user: 'u', code: 'read_only', errorCode: 'ER_LOCK_DEADLOCK' })
    const text = everything()
    expect(text).toContain('read_only')
    expect(text).toContain('ER_LOCK_DEADLOCK')
  })

  it('a token-shaped value in a code field is redacted', () => {
    audit('rows.refused', { user: 'u', code: SECRET })
    expect(everything()).not.toContain(SECRET)
  })
})
