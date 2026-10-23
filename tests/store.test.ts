import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '~/server/store/sqlite-store'
import type { SessionRecord, Store } from '~/server/store/store'

let dir: string
let store: Store
const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  idHash: 'a'.repeat(64),
  targetKey: 'mysql.example:3306',
  userName: 'root',
  createdAt: 1000,
  lastSeenAt: 1000,
  expiresAt: 5000,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-'))
  store = openSqliteStore(join(dir, 'store.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('creates and reads a session', () => {
  store.createSession(rec())
  expect(store.getSession('a'.repeat(64))).toEqual(rec())
})

test('unknown session is undefined', () => {
  expect(store.getSession('nope')).toBeUndefined()
})

test('touch updates last seen only', () => {
  store.createSession(rec())
  store.touchSession('a'.repeat(64), 2000)
  expect(store.getSession('a'.repeat(64))).toEqual(rec({ lastSeenAt: 2000 }))
})

test('delete removes the session', () => {
  store.createSession(rec())
  store.deleteSession('a'.repeat(64))
  expect(store.getSession('a'.repeat(64))).toBeUndefined()
})

test('purge removes only expired sessions', () => {
  store.createSession(rec({ idHash: 'old', expiresAt: 10 }))
  store.createSession(rec({ idHash: 'new', expiresAt: 9000 }))
  expect(store.purgeSessions(100)).toBe(1)
  expect(store.getSession('old')).toBeUndefined()
  expect(store.getSession('new')).toBeDefined()
})

test('sessions survive reopening the file', () => {
  store.createSession(rec())
  store.close()
  store = openSqliteStore(join(dir, 'store.db'))
  expect(store.getSession('a'.repeat(64))).toEqual(rec())
})
