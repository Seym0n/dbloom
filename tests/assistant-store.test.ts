import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ALL_TARGETS } from '~/server/assistant/store'
import { MIGRATIONS, openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import type { User } from '~/server/auth/types'

// SPEC/34 task 2: migration 9, conversation store (owner scoped, no result rows), PII markings and acknowledgements.

let dir: string
let store: SqliteStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-assistant-'))
  store = openSqliteStore(join(dir, 'store.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const mkUser = (id: string): User => ({
  id, username: id, usernameKey: id, displayName: id, role: 'user', status: 'active', securityVersion: 1, mustChangePassword: false,
  tempPasswordExpiresAt: null, webauthnUserId: `w-${id}`, createdAt: 1, updatedAt: 1, createdBy: 'setup', lastSignInAt: null,
})
const addUser = (id: string) => store.accounts.createUser(mkUser(id))
const conv = (id: string, userId: string, over: Partial<{ targetKey: string; title: string; at: number }> = {}) =>
  store.assistant.createConversation({ id, userId, targetKey: over.targetKey ?? 'db.example:3306', title: over.title ?? 'Orders', mode: 'manual', ...(over.at ? { at: over.at } : {}) })

describe('migration 9', () => {
  it('is the ninth migration and a store at version 8 upgrades', () => {
    expect(MIGRATIONS).toHaveLength(9)
    store.close()
    const db = new DatabaseSync(join(dir, 'store.db'))
    db.exec('DROP TABLE assistant_messages; DROP TABLE assistant_conversations; DROP TABLE pii_rules; DROP TABLE pii_ack; PRAGMA user_version = 8')
    db.close()
    store = openSqliteStore(join(dir, 'store.db'))
    addUser('u1')
    expect(conv('c1', 'u1').mode).toBe('manual')
  })

  it('has no column that could hold a result row or the token map', () => {
    const cols = (t: string) => (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('assistant_messages').sort()).toEqual(['content', 'conversation_id', 'created_at', 'id', 'outcome', 'role', 'row_count', 'seq', 'sql'])
    expect(cols('assistant_conversations').sort()).toEqual(['created_at', 'id', 'mode', 'target_key', 'title', 'updated_at', 'user_id'])
  })
})

describe('conversations', () => {
  it('create, get, list newest first, filter by target, and rename or switch mode', () => {
    addUser('u1')
    conv('c1', 'u1', { at: 100, title: 'First' })
    conv('c2', 'u1', { at: 200, title: 'Second' })
    conv('c3', 'u1', { at: 300, targetKey: 'other:3306' })
    expect(store.assistant.getConversation('u1', 'c1')).toMatchObject({ title: 'First', mode: 'manual', createdAt: 100, updatedAt: 100 })
    expect(store.assistant.listConversations('u1').map((c) => c.id)).toEqual(['c3', 'c2', 'c1'])
    expect(store.assistant.listConversations('u1', { targetKey: 'db.example:3306' }).map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(store.assistant.updateConversation('u1', 'c1', { title: 'Renamed', mode: 'auto' })).toBe(true)
    expect(store.assistant.getConversation('u1', 'c1')).toMatchObject({ title: 'Renamed', mode: 'auto' })
    expect(store.assistant.listConversations('u1', { limit: 1 })).toHaveLength(1)
  })

  it('a mode outside manual and auto is refused by the table', () => {
    addUser('u1')
    conv('c1', 'u1')
    expect(() => store.db.prepare("UPDATE assistant_conversations SET mode = 'wild' WHERE id = 'c1'").run()).toThrow()
  })

  it('everything is scoped by user: nobody reads, writes, renames or deletes another user\'s conversation', () => {
    addUser('u1')
    addUser('u2')
    conv('c1', 'u1')
    expect(store.assistant.getConversation('u2', 'c1')).toBeUndefined()
    expect(store.assistant.listConversations('u2')).toEqual([])
    expect(store.assistant.updateConversation('u2', 'c1', { title: 'x' })).toBe(false)
    expect(store.assistant.addMessage('u2', 'c1', { role: 'user', content: 'hi' })).toBeUndefined()
    expect(store.assistant.listMessages('u2', 'c1')).toEqual([])
    expect(store.assistant.deleteConversation('u2', 'c1')).toBe(false)
    expect(store.assistant.getConversation('u1', 'c1')).toBeDefined()
  })

  it('messages keep their order, carry sql, outcome and row count, and touch the conversation', () => {
    addUser('u1')
    conv('c1', 'u1', { at: 100 })
    const a = store.assistant.addMessage('u1', 'c1', { role: 'user', content: 'How many orders?' })!
    const b = store.assistant.addMessage('u1', 'c1', { role: 'tool', content: '', sql: 'SELECT COUNT(*) FROM orders', outcome: 'ok', rowCount: 1 })!
    const c = store.assistant.addMessage('u1', 'c1', { role: 'assistant', content: 'There are <n:abcd:1> orders.' })!
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(store.assistant.listMessages('u1', 'c1').map((m) => [m.role, m.sql, m.outcome, m.rowCount])).toEqual([
      ['user', null, null, null],
      ['tool', 'SELECT COUNT(*) FROM orders', 'ok', 1],
      ['assistant', null, null, null],
    ])
    expect(store.assistant.getConversation('u1', 'c1')!.updatedAt).toBeGreaterThan(100)
  })

  it('delete removes the messages; deleting the user removes their conversations', () => {
    addUser('u1')
    addUser('u2')
    conv('c1', 'u1')
    conv('c2', 'u2')
    store.assistant.addMessage('u1', 'c1', { role: 'user', content: 'hi' })
    store.assistant.addMessage('u2', 'c2', { role: 'user', content: 'hi' })
    expect(store.assistant.deleteConversation('u1', 'c1')).toBe(true)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM assistant_messages').get()).toEqual({ n: 1 })
    store.accounts.deleteUser('u2')
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM assistant_conversations').get()).toEqual({ n: 0 })
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM assistant_messages').get()).toEqual({ n: 0 })
  })

  it('retention purge removes conversations not touched since the cut-off', () => {
    addUser('u1')
    conv('old', 'u1', { at: 100 })
    conv('new', 'u1', { at: 900 })
    expect(store.assistant.purgeConversations(500)).toBe(1)
    expect(store.assistant.listConversations('u1').map((c) => c.id)).toEqual(['new'])
  })
})

describe('PII markings and acknowledgements', () => {
  it('add is idempotent per target and rule; list returns the target plus the global ones', () => {
    const first = store.assistant.addPiiRule('db:3306', 'shop.customers.email', 'admin1')
    expect(first.created).toBe(true)
    expect(store.assistant.addPiiRule('db:3306', 'shop.customers.email', 'admin2')).toMatchObject({ created: false, row: { createdBy: 'admin1' } })
    store.assistant.addPiiRule(ALL_TARGETS, '*.*.ssn', 'admin1')
    store.assistant.addPiiRule('other:3306', '*.*.phone', 'admin1')
    expect(store.assistant.listPiiRules('db:3306').map((r) => r.rule)).toEqual(['shop.customers.email', '*.*.ssn'])
    expect(store.assistant.listPiiRules().map((r) => r.rule)).toEqual(['shop.customers.email', '*.*.ssn', '*.*.phone'])
  })

  it('remove returns the row it removed, once', () => {
    const { row } = store.assistant.addPiiRule('db:3306', 'a.b.c', 'admin1')
    expect(store.assistant.removePiiRule(row.id)).toMatchObject({ rule: 'a.b.c' })
    expect(store.assistant.removePiiRule(row.id)).toBeUndefined()
    expect(store.assistant.listPiiRules()).toEqual([])
  })

  it('an acknowledgement is per target, replaced by a new one, and can be cleared', () => {
    expect(store.assistant.getPiiAck('db:3306')).toBeUndefined()
    store.assistant.setPiiAck('db:3306', 'admin1')
    store.assistant.setPiiAck('db:3306', 'admin2')
    expect(store.assistant.getPiiAck('db:3306')).toMatchObject({ acknowledgedBy: 'admin2' })
    expect(store.assistant.getPiiAck('other:3306')).toBeUndefined()
    expect(store.assistant.clearPiiAck('db:3306')).toBe(true)
    expect(store.assistant.clearPiiAck('db:3306')).toBe(false)
  })
})
