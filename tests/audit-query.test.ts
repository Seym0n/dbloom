import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PAGE_CAP, queryAudit, queryOwnEvents } from '../src/server/audit/query'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 3)
let dir: string
let store: SqliteStore
const add = (o: { at?: number; event?: string; outcome?: string; actorId?: string; actorName?: string; subject?: string; fields?: string }) =>
  store.db
    .prepare('INSERT INTO audit_log (at, event, outcome, actor_id, actor_name, actor_kind, subject, address, fields) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(o.at ?? NOW, o.event ?? 'sql.run', o.outcome ?? null, o.actorId ?? null, o.actorName ?? null, 'user', o.subject ?? null, '10.0.0.1', o.fields ?? '{}')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-q-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('queryAudit', () => {
  it('newest first, keyset pages without gaps or repeats, even while rows are appended', () => {
    for (let i = 0; i < 120; i++) add({ subject: `s${i}` })
    const p1 = queryAudit(store.db, {}, { limit: 50 })
    expect(p1.rows).toHaveLength(50)
    expect(p1.rows[0]!.subject).toBe('s119')
    add({ subject: 'late' })
    const p2 = queryAudit(store.db, {}, { before: p1.next!, limit: 50 })
    const p3 = queryAudit(store.db, {}, { before: p2.next!, limit: 50 })
    const subjects = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.subject)
    expect(subjects).toHaveLength(120)
    expect(new Set(subjects).size).toBe(120)
    expect(subjects).not.toContain('late')
    expect(p3.next).toBeNull()
  })

  it('default page 50, cap 200', () => {
    for (let i = 0; i < 250; i++) add({})
    expect(queryAudit(store.db).rows).toHaveLength(50)
    expect(queryAudit(store.db, {}, { limit: 100_000 }).rows).toHaveLength(PAGE_CAP)
  })

  it('filters: time range, event prefix, actor id or name, outcome, subject text', () => {
    add({ at: NOW - 10 * DAY, event: 'user.create', actorId: 'u1', actorName: 'ann', outcome: 'ok', subject: 'bob_100%' })
    add({ at: NOW - 5 * DAY, event: 'user.delete', actorId: 'u2', actorName: 'cy', outcome: 'failed', subject: 'bobXYZ' })
    add({ at: NOW - 1 * DAY, event: 'sql.run', actorId: 'u1', actorName: 'ann', outcome: 'ok' })
    const events = (f: Parameters<typeof queryAudit>[1]) => queryAudit(store.db, f).rows.map((r) => r.event).sort()
    expect(events({ from: NOW - 6 * DAY })).toEqual(['sql.run', 'user.delete'])
    expect(events({ to: NOW - 6 * DAY })).toEqual(['user.create'])
    expect(events({ eventPrefix: 'user.' })).toEqual(['user.create', 'user.delete'])
    expect(events({ actor: 'u1' })).toEqual(['sql.run', 'user.create'])
    expect(events({ actor: 'cy' })).toEqual(['user.delete'])
    expect(events({ outcome: 'failed' })).toEqual(['user.delete'])
    expect(events({ text: 'bob_100%' })).toEqual(['user.create']) // wildcards are literal
    expect(events({ eventPrefix: 'user.', outcome: 'ok' })).toEqual(['user.create'])
  })

  it('returns parsed fields; broken JSON becomes an empty object', () => {
    add({ fields: '{"count":3}' })
    add({ fields: 'not json' })
    expect(queryAudit(store.db).rows.map((r) => r.fields)).toEqual([{}, { count: 3 }])
  })
})

describe('queryOwnEvents', () => {
  it('only the user, last 90 days, reduced columns', () => {
    add({ actorId: 'u1', event: 'auth.signin', at: NOW - 1 * DAY })
    add({ actorId: 'u1', event: 'auth.signin', at: NOW - 91 * DAY })
    add({ actorId: 'u2', event: 'auth.signin', at: NOW - 1 * DAY })
    add({ actorId: 'u1', event: 'auth.signout', at: NOW - 2 * DAY, fields: '{"secretish":"x"}' })
    const page = queryOwnEvents(store.db, 'u1', NOW)
    expect(page.rows.map((r) => r.event)).toEqual(['auth.signout', 'auth.signin'])
    expect(Object.keys(page.rows[0]!).sort()).toEqual(['address', 'at', 'event', 'id', 'outcome', 'subject'])
  })

  it('pages by keyset', () => {
    for (let i = 0; i < 7; i++) add({ actorId: 'u1', subject: `s${i}` })
    const p1 = queryOwnEvents(store.db, 'u1', NOW, { limit: 3 })
    const p2 = queryOwnEvents(store.db, 'u1', NOW, { limit: 3, before: p1.next! })
    const p3 = queryOwnEvents(store.db, 'u1', NOW, { limit: 3, before: p2.next! })
    expect([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.subject)).toEqual(['s6', 's5', 's4', 's3', 's2', 's1', 's0'])
    expect(p3.next).toBeNull()
  })
})
