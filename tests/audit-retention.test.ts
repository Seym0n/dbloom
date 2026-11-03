import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAuditStore, unregisterAuditStore } from '../src/server/audit'
import { purgeAudit } from '../src/server/audit/retention'
import { resetSinks } from '../src/server/audit/sink'
import { loadConfig } from '../src/server/config'
import { createAuthSettingsResolver } from '../src/server/auth/settings'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 3)
let dir: string
let store: SqliteStore
const ats = () => (store.db.prepare('SELECT at, event FROM audit_log ORDER BY id').all() as { at: number; event: string }[])
const seed = (ageDays: number) =>
  store.db.prepare(`INSERT INTO audit_log (at, event, actor_kind, fields) VALUES (?, 'sql.run', 'system', '{}')`).run(NOW - ageDays * DAY)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-ret-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  registerAuditStore(store.db)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  unregisterAuditStore()
  resetSinks()
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('purge', () => {
  it('deletes rows older than the limit, keeps newer, writes one audit.purge row', () => {
    seed(400); seed(380); seed(366); seed(364); seed(1)
    const r = purgeAudit(store.db, 365, NOW)
    expect(r.deleted).toBe(3)
    const rows = ats()
    expect(rows.filter((x) => x.event === 'sql.run')).toHaveLength(2)
    expect(rows.filter((x) => x.event === 'audit.purge')).toHaveLength(1)
    expect(store.db.prepare(`SELECT value FROM site WHERE key = 'audit_cutoff'`).get()).toEqual({ value: String(NOW - 365 * DAY) })
  })
  it('works in batches and writes nothing when there is nothing to delete', () => {
    for (let i = 0; i < 25; i++) seed(500)
    expect(purgeAudit(store.db, 365, NOW, 10).deleted).toBe(25)
    expect(ats().filter((x) => x.event === 'audit.purge')).toHaveLength(1)
    expect(purgeAudit(store.db, 365, NOW, 10).deleted).toBe(0)
    expect(ats().filter((x) => x.event === 'audit.purge')).toHaveLength(1)
  })
  it('the cutoff never moves back, so a shorter-then-longer retention cannot open newer rows', () => {
    purgeAudit(store.db, 100, NOW)
    purgeAudit(store.db, 1000, NOW)
    expect(store.db.prepare(`SELECT value FROM site WHERE key = 'audit_cutoff'`).get()).toEqual({ value: String(NOW - 100 * DAY) })
  })
  it('a direct delete of a newer row stays refused after a purge', () => {
    seed(1)
    purgeAudit(store.db, 365, NOW)
    expect(() => store.db.exec(`DELETE FROM audit_log WHERE event = 'sql.run'`)).toThrow(/append-only/)
  })
})

describe('setting and variable', () => {
  it('default 365, env overrides, stored value within bounds, out-of-range clamps in the resolver', () => {
    expect(createAuthSettingsResolver(store.accounts, {}).resolve().auditRetentionDays).toBe(365)
    expect(createAuthSettingsResolver(store.accounts, { DBLOOM_AUDIT_RETENTION_DAYS: '180' }).resolve().auditRetentionDays).toBe(180)
    expect(createAuthSettingsResolver(store.accounts, { DBLOOM_AUDIT_RETENTION_DAYS: '5000' }).resolve().auditRetentionDays).toBe(1095)
  })
  it.each(['89', '1096', 'abc', '1.5'])('startup refuses DBLOOM_AUDIT_RETENTION_DAYS=%s', (value) => {
    expect(() => loadConfig({ DBLOOM_AUDIT_RETENTION_DAYS: value } as NodeJS.ProcessEnv)).toThrow(/DBLOOM_AUDIT_RETENTION_DAYS/)
  })
  it.each([90, 365, 1095])('startup accepts DBLOOM_AUDIT_RETENTION_DAYS=%i and the purge applies it', (days) => {
    expect(loadConfig({ DBLOOM_AUDIT_RETENTION_DAYS: String(days) } as NodeJS.ProcessEnv).auditRetentionDays).toBe(days)
    seed(days + 1)
    seed(days - 1)
    expect(purgeAudit(store.db, days, NOW).deleted).toBe(1)
  })
  it('config default is 365', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).auditRetentionDays).toBe(365)
  })
})
