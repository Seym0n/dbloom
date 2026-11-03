import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAuditStore, unregisterAuditStore } from '../src/server/audit'
import { csvCell, exportLines, planExport } from '../src/server/audit/export'
import { handleAuditExportWith } from '../src/server/audit/http'
import { createAuditService, type AuditService } from '../src/server/audit/service'
import { resetSinks } from '../src/server/audit/sink'
import { main } from '../src/server/auth/cli/main'
import { AuthError, type AccountContext } from '../src/server/auth/types'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

const DAY = 86_400_000
let dir: string
let store: SqliteStore
let svc: AuditService
let stepUpOk: boolean

const admin: AccountContext = {
  idHash: 'sess1', csrf: 'c', kind: 'account', state: 'full', ownerKey: 'u:a1', mfaAt: null, stepupAt: null,
  user: { id: 'a1', username: 'a1', displayName: 'a1', role: 'admin', securityVersion: 0 },
}
const add = (o: { at?: number; event?: string; subject?: string; address?: string }) =>
  store.db
    .prepare("INSERT INTO audit_log (at, event, actor_kind, subject, address, fields) VALUES (?,?,'user',?,?,'{\"n\":1}')")
    .run(o.at ?? Date.now(), o.event ?? 'sql.run', o.subject ?? null, o.address ?? null)
const exportRows = () => store.db.prepare("SELECT * FROM audit_log WHERE event = 'audit.export'").all() as { actor_id: string | null; actor_kind: string; fields: string; at: number }[]
const text = async (r: Response) => await r.text()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-exp-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  registerAuditStore(store.db)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  stepUpOk = true
  store.db.exec("INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES ('a1','a1','a1','a1','admin','active','w1',1,1,'system')")
  svc = createAuditService({
    db: store.db,
    store: store.accounts,
    mode: () => 'account',
    stepUp: { requireRecentFactor: () => { if (!stepUpOk) throw new AuthError('stepup_required') } },
    retentionDays: () => 365,
  })
})
afterEach(() => {
  unregisterAuditStore()
  resetSinks()
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('export via the service', () => {
  it('without step-up: refused, no row, no token', () => {
    stepUpOk = false
    add({})
    expect(() => svc.startExport(admin, {}, 'csv')).toThrow(/stepup_required|auth/i)
    expect(exportRows()).toHaveLength(0)
  })

  it('the audit.export row exists before any byte is read, also when the stream is cancelled', async () => {
    add({ subject: 'a' })
    add({ subject: 'b' })
    const started = svc.startExport(admin, { eventPrefix: 'sql.' }, 'ndjson')
    expect(started).toMatchObject({ rows: 2, truncated: false })
    const row = exportRows()
    expect(row).toHaveLength(1)
    expect(row[0]).toMatchObject({ actor_id: 'a1' })
    expect(JSON.parse(row[0]!.fields)).toMatchObject({ format: 'ndjson', rows: 2, truncated: false })
    const out = svc.openExport(admin, started.token)
    await out.stream.cancel()
    expect(exportRows()).toHaveLength(1)
  })

  it('a token is single use and bound to the session that started it', () => {
    add({})
    const t1 = svc.startExport(admin, {}, 'csv').token
    expect(() => svc.openExport({ ...admin, idHash: 'other' }, t1)).toThrow(AuthError)
    expect(() => svc.openExport(admin, t1)).toThrow(AuthError) // consumed by the failed attempt too
    const t2 = svc.startExport(admin, {}, 'csv').token
    svc.openExport(admin, t2)
    expect(() => svc.openExport(admin, t2)).toThrow(AuthError)
  })

  it('the export is bounded by the retention window', () => {
    add({ at: Date.now() - 400 * DAY, subject: 'old' })
    add({ at: Date.now() - 10 * DAY, subject: 'new' })
    expect(svc.startExport(admin, {}, 'csv').rows).toBe(1)
  })
})

describe('formats and cap', () => {
  it('csv: header, CRLF, quoting, formula guard; ndjson: one object per line with parsed fields', () => {
    add({ subject: 'plain' })
    add({ subject: '=HYPERLINK("x")' })
    add({ subject: 'a,b "c"\nd' })
    const plan = planExport(store.db, {}, Date.now(), 365)
    const csv = [...exportLines(store.db, plan, 'csv')].join('')
    expect(csv.startsWith('id,time,event,outcome,actor_id,actor_name,actor_kind,subject,address,fields\r\n')).toBe(true)
    expect(csv).toContain("'=HYPERLINK(\"\"x\"\")")
    expect(csv).toContain('"a,b ""c""\nd"')
    const nd = [...exportLines(store.db, plan, 'ndjson')].map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(nd).toHaveLength(3)
    expect(nd[0]).toMatchObject({ event: 'sql.run', subject: 'plain', fields: { n: 1 } })
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell(-5)).toBe('-5')
  })

  it('cap: stops at the row cap and says truncated', () => {
    for (let i = 0; i < 25; i++) add({ subject: `s${i}` })
    const plan = planExport(store.db, {}, Date.now(), 365, 10)
    expect(plan).toMatchObject({ rows: 10, truncated: true })
    expect([...exportLines(store.db, plan, 'ndjson', 10)]).toHaveLength(10)
  })

  it('streams in batches larger than one page without loss or repeat', () => {
    for (let i = 0; i < 2500; i++) add({ subject: `s${i}` })
    const plan = planExport(store.db, {}, Date.now(), 365)
    const ids = [...exportLines(store.db, plan, 'ndjson')].map((l) => (JSON.parse(l) as { id: number }).id)
    expect(ids).toHaveLength(2500)
    expect(new Set(ids).size).toBe(2500)
  })
})

describe('download route', () => {
  it('streams with attachment headers for the right session; neutral 404 otherwise', async () => {
    add({ subject: 'x' })
    const { token } = svc.startExport(admin, {}, 'ndjson')
    const req = new Request('https://db.example.org/api/audit/export/t', { headers: { cookie: '__Host-dbloom-session=abc' } })
    const bad = handleAuditExportWith(req, token, () => undefined, () => svc)
    expect(bad.status).toBe(404)
    const ok = handleAuditExportWith(req, token, () => admin, () => svc)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment; filename="dbloom-audit-\d{4}-\d{2}-\d{2}\.ndjson"$/)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect((await text(ok)).trim().split('\n').length).toBeGreaterThanOrEqual(1)
    expect(handleAuditExportWith(req, token, () => admin, () => svc).status).toBe(404)
  })
})

describe('CLI audit export', () => {
  it('writes audit.export with kind cli first, then the rows; bad flags give usage', async () => {
    add({ subject: 'one' })
    add({ subject: 'two' })
    const out: string[] = []
    const code = await main(['audit', 'export', '--format', 'ndjson'], { DBLOOM_DATA_DIR: dir }, (s) => void out.push(s))
    expect(code).toBe(0)
    const lines = out.join('').trim().split('\n').map((l) => JSON.parse(l) as { subject: string | null })
    expect(lines.map((l) => l.subject)).toEqual(['one', 'two'])
    const row = exportRows()
    expect(row).toHaveLength(1)
    expect(row[0]).toMatchObject({ actor_kind: 'cli' })
    const bad: string[] = []
    expect(await main(['audit', 'export', '--format', 'xml'], { DBLOOM_DATA_DIR: dir }, (s) => void bad.push(s))).toBe(2)
    expect(bad.join('')).toContain('audit export')
    expect(await main(['audit', 'export', '--since', 'yesterday-ish'], { DBLOOM_DATA_DIR: dir }, () => undefined)).toBe(2)
  })

  it('since and until bound the rows', async () => {
    add({ at: Date.UTC(2026, 9, 1), subject: 'oct1' })
    add({ at: Date.now() - DAY, subject: 'recent' })
    const out: string[] = []
    await main(['audit', 'export', '--since', new Date(Date.now() - 5 * DAY).toISOString()], { DBLOOM_DATA_DIR: dir }, (s) => void out.push(s))
    expect(out.join('')).toContain('recent')
    expect(out.join('')).not.toContain('oct1')
  })
})
