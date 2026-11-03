import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAuditStore, unregisterAuditStore } from '../src/server/audit'
import { createAuditService, type AuditService } from '../src/server/audit/service'
import { resetSinks } from '../src/server/audit/sink'
import { AuthError, type AccountContext, type LoginMode } from '../src/server/auth/types'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

let dir: string
let store: SqliteStore
let mode: LoginMode
let svc: AuditService

const user = (id: string, role: 'admin' | 'user', status: 'active' | 'disabled' = 'active') =>
  store.db
    .prepare("INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,1,1,'system')")
    .run(id, id, id, id, role, status, `w-${id}`)
const ctx = (id: string | null, role: 'admin' | 'user' = 'user', state: AccountContext['state'] = 'full'): AccountContext => ({
  idHash: 'h',
  csrf: 'c',
  kind: 'account',
  state,
  ownerKey: `u:${id}`,
  mfaAt: null,
  stepupAt: null,
  user: id ? { id, username: id, displayName: id, role, securityVersion: 0 } : null,
})
const row = (actorId: string | null) =>
  store.db.prepare("INSERT INTO audit_log (at, event, actor_id, actor_kind, fields) VALUES (?, 'sql.run', ?, 'user', '{}')").run(Date.now(), actorId)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-fn-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  registerAuditStore(store.db)
  mode = 'account'
  svc = createAuditService({ db: store.db, store: store.accounts, mode: () => mode, stepUp: { requireRecentFactor: () => undefined }, retentionDays: () => 365 })
  user('a1', 'admin')
  user('u1', 'user')
  user('u2', 'user')
  user('a2', 'admin', 'disabled')
  row('u1')
  row('u2')
  row('a1')
})
afterEach(() => {
  unregisterAuditStore()
  resetSinks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('role matrix', () => {
  it('admin lists and reads status', () => {
    expect(svc.list(ctx('a1', 'admin'), {}, {}).rows).toHaveLength(3)
    expect(svc.status(ctx('a1', 'admin'))).toMatchObject({ mode: 'account', table: true, tableFailures: 0, sink: { sink: 'stdout', state: 'ok' } })
    expect(svc.status(ctx('a1', 'admin')).events).toContain('audit.export')
  })

  it.each([
    ['user', ctx('u1', 'user')],
    ['no user', ctx(null)],
    ['disabled admin', ctx('a2', 'admin')],
    ['admin not yet fully signed in', ctx('a1', 'admin', 'pending_mfa')],
    ['role claimed in session but row says user', ctx('u1', 'admin')],
  ])('list and status refuse: %s', (_name, c) => {
    expect(() => svc.list(c, {}, {})).toThrow(AuthError)
    expect(() => svc.status(c)).toThrow(AuthError)
  })

  it('own events: a user sees only their own rows; anonymous and not-full refused', () => {
    expect(svc.own(ctx('u1'), {}).rows).toHaveLength(1)
    expect(svc.own(ctx('a1', 'admin'), {}).rows).toHaveLength(1)
    expect(() => svc.own(ctx(null), {})).toThrow(AuthError)
    expect(() => svc.own(ctx('u1', 'user', 'must_change'), {})).toThrow(AuthError)
  })

  it('direct and stateless mode: list throws unavailable, own is empty', () => {
    mode = 'direct'
    expect(() => svc.list(ctx('a1', 'admin'), {}, {})).toThrow(/unavailable/)
    expect(svc.own(ctx('u1'), {}).rows).toEqual([])
    expect(svc.status(ctx('a1', 'admin')).table).toBe(false)
  })
})

describe('client chunk', () => {
  it('audit.functions.ts imports no module that runs Node code at load (its client chunk is loaded in the browser)', () => {
    const src = readFileSync('src/server/audit.functions.ts', 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]!)
    expect(imports.sort()).toEqual(['./audit/formats', './audit/runtime', './auth/error-transport', './middleware', '@tanstack/react-start', 'zod'])
  })
})

describe('no write path', () => {
  it('the service and the function module export no write, update or delete', () => {
    expect(Object.keys(svc).sort()).toEqual(['list', 'openExport', 'own', 'startExport', 'status'])
    const src = readFileSync('src/server/audit.functions.ts', 'utf8')
    const exported = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!)
    // reads, the export start (writes only its own audit.export row), and the accessors; nothing that edits or deletes rows
    expect(exported.filter((n) => !/^(list|get|startAuditExport|auditService)/.test(n))).toEqual([])
    expect(exported.filter((n) => /update|delete|remove|purge|clear/i.test(n))).toEqual([])
    const reads = readFileSync('src/server/audit/query.ts', 'utf8') + readFileSync('src/server/audit/service.ts', 'utf8')
    expect(reads).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
  })
})
