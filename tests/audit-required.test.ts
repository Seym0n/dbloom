import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audit, AuditUnavailable, auditRequired, auditRequiredIn, registerAuditStore, setAuditContext, unregisterAuditStore } from '../src/server/audit'
import { resetSinks } from '../src/server/audit/sink'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

let dir: string
let store: SqliteStore
const rows = (db: DatabaseSync = store.db) => db.prepare('SELECT * FROM audit_log ORDER BY id').all() as Record<string, unknown>[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-req-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  registerAuditStore(store.db)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  setAuditContext(undefined)
  unregisterAuditStore()
  resetSinks()
  vi.restoreAllMocks()
  try { store.close() } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('actor and address', () => {
  it('fills the address from the request context, and keeps it out of the stdout line', () => {
    setAuditContext(() => ({ address: '203.0.113.9' }))
    audit('invite.revoke', { id: 'i1', actor: 'u1', outcome: 'ok' })
    expect(rows()[0]).toMatchObject({ address: '203.0.113.9', actor_id: 'u1', actor_kind: 'user' })
    expect(vi.mocked(console.log).mock.calls[0]![0]).not.toContain('203.0.113.9')
  })
  it('call-site address wins over context', () => {
    setAuditContext(() => ({ address: '203.0.113.9' }))
    audit('connection.open', { actor: 'u1', subject: 's', address: '198.51.100.1' })
    expect(rows()[0]!.address).toBe('198.51.100.1')
  })
  it('snapshots the user name from the users table', () => {
    store.db.exec(`INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES ('u1','ann','ann','Ann','user','active','w1',1,1,'system')`)
    audit('invite.revoke', { id: 'i1', actor: 'u1' })
    expect(rows()[0]!.actor_name).toBe('ann')
  })
  it('kinds: cli, system, anonymous, system without context', () => {
    audit('cli.command', { actor: 'cli', actorKind: 'cli', outcome: 'ok' })
    audit('setup.token', { actor: 'setup', actorKind: 'setup', outcome: 'ok' })
    expect(rows().map((r) => r.actor_kind)).toEqual(['cli', 'system'])
    setAuditContext(() => ({ address: '10.0.0.1' }))
    audit('auth.signin', { outcome: 'failed' })
    expect(rows()[2]!.actor_kind).toBe('anonymous')
    setAuditContext(undefined)
    audit('audit.purge', { count: 1 })
    expect(rows()[3]!.actor_kind).toBe('system')
  })
  it('auth and account events attribute the subject user as actor; others do not', () => {
    store.db.exec(`INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES ('u1','ann','ann','Ann','user','active','w1',1,1,'system')`)
    audit('auth.signin', { outcome: 'ok', subject: 'u1' })
    audit('factor.added', { action: 'totp_set', factor: 'totp', actor: 'u1', subject: 'u1' })
    audit('invite.revoke', { id: 'i1', subject: 'u1' })
    const r = rows()
    expect(r[0]).toMatchObject({ actor_id: 'u1', actor_name: 'ann', actor_kind: 'user' })
    expect(r[1]).toMatchObject({ actor_id: 'u1' })
    expect(r[2]!.actor_id).toBeNull()
  })
  it('a throwing context provider does not break the event', () => {
    setAuditContext(() => { throw new Error('no request') })
    audit('audit.purge', { count: 1 })
    expect(rows()).toHaveLength(1)
  })
})

describe('auditRequired', () => {
  it('commits the row before returning and still writes stdout', () => {
    auditRequired('audit.purge', { count: 2 })
    expect(rows()).toHaveLength(1)
    const other = new DatabaseSync(join(dir, 'dbloom.db'))
    expect(other.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 1 })
    other.close()
    expect(vi.mocked(console.log).mock.calls.length).toBe(1)
  })
  it('throws AuditUnavailable in stateless mode (no store registered)', () => {
    unregisterAuditStore()
    expect(() => auditRequired('audit.purge', {})).toThrow(AuditUnavailable)
  })
  it('locked store: auditRequired throws, audit does not', () => {
    const other = new DatabaseSync(join(dir, 'dbloom.db'))
    other.exec('PRAGMA busy_timeout = 0')
    store.db.exec('PRAGMA busy_timeout = 0')
    other.exec('BEGIN IMMEDIATE')
    try {
      expect(() => auditRequired('audit.purge', {})).toThrow(AuditUnavailable)
      expect(() => audit('audit.purge', {})).not.toThrow()
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }
    expect(rows()).toHaveLength(0)
  })
  it('read-only handle throws', () => {
    const ro = new DatabaseSync(join(dir, 'dbloom.db'), { readOnly: true })
    try {
      expect(() => auditRequiredIn(ro, 'audit.purge', {})).toThrow(AuditUnavailable)
    } finally {
      ro.close()
    }
  })
})

describe('auditRequiredIn (transaction variant)', () => {
  const change = (db: DatabaseSync) => db.exec(`INSERT INTO site (key, value) VALUES ('standin', '1')`)
  const standin = () => store.db.prepare(`SELECT COUNT(*) AS n FROM site WHERE key = 'standin'`).get() as { n: number }

  it('row and change commit together; other sinks get the entry after commit', () => {
    store.db.exec('BEGIN IMMEDIATE')
    change(store.db)
    const publish = auditRequiredIn(store.db, 'audit.purge', { count: 1 })
    expect(vi.mocked(console.log)).not.toHaveBeenCalled()
    store.db.exec('COMMIT')
    publish()
    expect(rows()).toHaveLength(1)
    expect(standin().n).toBe(1)
    expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1)
  })
  it('a failed audit write aborts the change: no row, no half change', () => {
    store.db.exec('DROP TRIGGER audit_log_no_update')
    store.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    store.db.exec('BEGIN IMMEDIATE')
    try {
      change(store.db)
      auditRequiredIn(store.db, 'audit.purge', {})
      store.db.exec('COMMIT')
    } catch (error) {
      expect(error).toBeInstanceOf(AuditUnavailable)
      store.db.exec('ROLLBACK')
    }
    expect(rows()).toHaveLength(0)
    expect(standin().n).toBe(0)
  })
})
