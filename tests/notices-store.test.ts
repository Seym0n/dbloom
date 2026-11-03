import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

let dir: string
let store: SqliteStore

const user = (id: string) =>
  store.db
    .prepare("INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES (?,?,?,?,'admin','active',?,1,1,'system')")
    .run(id, id, id, id, `w-${id}`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-notices-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  user('u1')
  user('u2')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migration 7', () => {
  it('adds the detail column and the seen_locations table with a composite key and a cascade', () => {
    const cols = (store.db.prepare('PRAGMA table_info(user_notices)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('detail')
    const keys = (store.db.prepare('PRAGMA table_info(seen_locations)').all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name)
    expect(keys.sort()).toEqual(['prefix', 'user_id'])
    expect(store.db.prepare('PRAGMA foreign_key_list(seen_locations)').all()).toMatchObject([{ table: 'users', on_delete: 'CASCADE' }])
  })

  it('a store at version 6 with notices migrates and keeps its rows', () => {
    store.db.exec("INSERT INTO user_notices (id, user_id, kind, created_at, read_at) VALUES ('n0','u1','password_changed',5,NULL)")
    expect(store.accounts.listNotices('u1')).toMatchObject([{ id: 'n0', kind: 'password_changed' }])
    expect(store.accounts.listNotices('u1')[0]).not.toHaveProperty('detail')
  })
})

describe('notices with detail', () => {
  it('stores and returns the detail; notices without one omit it; markNoticeRead is per user', () => {
    store.accounts.addNotice({ id: 'a', userId: 'u1', kind: 'failed_burst', createdAt: 10, readAt: null, detail: 'account ann: 10 failures in 10 min' })
    store.accounts.addNotice({ id: 'b', userId: 'u1', kind: 'password_changed', createdAt: 5, readAt: null })
    const list = store.accounts.listNotices('u1')
    expect(list.map((n) => n.id)).toEqual(['a', 'b'])
    expect(list[0]!.detail).toBe('account ann: 10 failures in 10 min')
    expect(list[1]).not.toHaveProperty('detail')
    store.accounts.markNoticeRead('u2', 'a', 99)
    expect(store.accounts.listNotices('u1')[0]!.readAt).toBeNull()
    store.accounts.markNoticeRead('u1', 'a', 99)
    expect(store.accounts.listNotices('u1')[0]!.readAt).toBe(99)
  })
})

describe('seen locations', () => {
  it('upsert keeps one row per prefix and moves the time; count and get work per user', () => {
    expect(store.accounts.getSeenLocation('u1', '203.0.113.0')).toBeUndefined()
    store.accounts.upsertSeenLocation('u1', '203.0.113.0', 100)
    store.accounts.upsertSeenLocation('u1', '203.0.113.0', 200)
    store.accounts.upsertSeenLocation('u1', '198.51.100.0', 150)
    store.accounts.upsertSeenLocation('u2', '203.0.113.0', 50)
    expect(store.accounts.getSeenLocation('u1', '203.0.113.0')).toBe(200)
    expect(store.accounts.countSeenLocations('u1')).toBe(2)
    expect(store.accounts.countSeenLocations('u2')).toBe(1)
  })

  it('purge deletes only rows older than the cutoff', () => {
    store.accounts.upsertSeenLocation('u1', 'a', 100)
    store.accounts.upsertSeenLocation('u1', 'b', 300)
    expect(store.accounts.purgeSeenLocations(200)).toBe(1)
    expect(store.accounts.countSeenLocations('u1')).toBe(1)
  })

  it('deleting the user deletes the rows', () => {
    store.accounts.upsertSeenLocation('u1', 'a', 100)
    store.db.exec("DELETE FROM users WHERE id = 'u1'")
    expect(store.accounts.countSeenLocations('u1')).toBe(0)
  })
})
