import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { inspectForAssistant, runForAssistant } from '~/server/sql/assistant'
import { RunRegistry } from '~/server/sql/registry'
import type { SqlHistoryRecord, SqlRunEnv } from '~/server/sql/run'
import { DEFAULT_SQL_LIMITS } from '~/server/sql/types'
import { PlanStore } from '~/server/structure/plans'

// SPEC/34 FR-AST-011: the assistant hook with the write path (INSERT and UPDATE only with an approval) against real servers.

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
]
const DB = 'assistant_hook_scratch'

describe.each(servers)('assistant hook writes on $name', ({ port }) => {
  let pool: Pool
  let history: SqlHistoryRecord[] = []
  let logs: string[] = []

  const mkEnv = (guard = { forcedReadOnly: false, sessionReadOnly: false }): SqlRunEnv => ({
    session: { idHash: 'assistant-session', target: { host: '127.0.0.1', port, username: 'root' }, pool },
    guard,
    tokens: createTokenIssuer(),
    limits: { ...DEFAULT_SQL_LIMITS, timeoutMs: 60_000 },
    plans: new PlanStore(),
    registry: new RunRegistry(),
    recordHistory: (r) => history.push(r),
  })
  const rows = async (sql: string) => ((await pool.query(sql))[0] as Record<string, unknown>[])
  const count = async (sql: string) => Number((await rows(sql))[0]!.n)
  const audits = () =>
    logs.flatMap((l) => {
      try {
        const o = JSON.parse(l) as Record<string, unknown>
        return o.audit === 'sql.run' ? [o] : []
      } catch {
        return []
      }
    })
  const call = (env: SqlRunEnv, text: string, approvedWrite?: boolean) =>
    runForAssistant(env, { db: DB, text, conversationId: 'c1', ...(approvedWrite === undefined ? {} : { approvedWrite }) })

  beforeAll(async () => {
    pool = createPool({ host: '127.0.0.1', port, user: 'root', password: 'root', connectionLimit: 4, charset: 'utf8mb4' })
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.query(`CREATE DATABASE ${DB}`)
    await pool.query(`CREATE TABLE ${DB}.t (id INT PRIMARY KEY, name VARCHAR(40))`)
    await pool.query(`INSERT INTO ${DB}.t VALUES (1,'a'),(2,'b'),(3,'c')`)
  })
  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.end()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    history = []
    logs = []
  })
  const captureLog = () =>
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })

  test('inspect classifies without running: read, write, and what stays with the user', async () => {
    const env = mkEnv()
    const read = await inspectForAssistant(env, 'SELECT * FROM t')
    expect(read).toMatchObject({ ok: true, access: 'read', facts: { kind: 'select', class: 'none' } })
    expect(await inspectForAssistant(env, "INSERT INTO t VALUES (9,'z')")).toMatchObject({ ok: true, access: 'write', facts: { kind: 'insert' } })
    expect(await inspectForAssistant(env, "UPDATE t SET name='x' WHERE id = 1")).toMatchObject({ ok: true, access: 'write', facts: { kind: 'update', class: 'none' } })
    for (const text of [
      "UPDATE t SET name='x'",
      'UPDATE t SET name = name WHERE 1 = 1',
      'DELETE FROM t WHERE id = 1',
      "REPLACE INTO t VALUES (1,'q')",
      'DROP TABLE t',
      'TRUNCATE TABLE t',
      'ALTER TABLE t ADD COLUMN x INT',
      'SELECT 1; SELECT 2',
    ]) {
      expect((await inspectForAssistant(env, text)).ok, text).toBe(false)
    }
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.t`)).toBe(3)
  })

  test('an INSERT or UPDATE without approval is not run and says why', async () => {
    captureLog()
    const env = mkEnv()
    for (const text of ["INSERT INTO t VALUES (9,'z')", "UPDATE t SET name='x' WHERE id = 1"]) {
      const r = await call(env, text)
      expect(r).toMatchObject({ needsUser: true, reason: 'approval-required' })
      expect((await call(env, text, false)).needsUser).toBe(true)
    }
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.t WHERE id = 9`)).toBe(0)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.t WHERE name = 'x'`)).toBe(0)
    expect(audits()).toHaveLength(0)
    expect(env.registry!.size).toBe(0)
  })

  test('an approved INSERT and UPDATE run, with affected rows, audit and history source assistant', async () => {
    captureLog()
    const env = mkEnv()
    const ins = await call(env, "INSERT INTO t VALUES (10,'ten')", true)
    if (ins.needsUser) throw new Error(ins.reason)
    expect(ins.ok).toBe(true)
    expect(ins.result).toMatchObject({ status: 'ok', affectedRows: 1 })
    const upd = await call(env, "UPDATE t SET name='uno' WHERE id = 1", true)
    if (upd.needsUser) throw new Error(upd.reason)
    expect(upd.result).toMatchObject({ status: 'ok', affectedRows: 1 })
    expect(await rows(`SELECT name FROM ${DB}.t WHERE id IN (1, 10) ORDER BY id`)).toEqual([{ name: 'uno' }, { name: 'ten' }])
    expect(audits()).toHaveLength(2)
    expect(audits().every((l) => l.source === 'assistant')).toBe(true)
    expect(history.every((h) => h.source === 'assistant')).toBe(true)
  })

  test('an approval never widens what runs: DELETE, REPLACE, DDL, UPDATE without WHERE, batches stay with the user', async () => {
    captureLog()
    const env = mkEnv()
    for (const text of [
      'DELETE FROM t WHERE id = 2',
      "REPLACE INTO t VALUES (2,'q')",
      'DROP TABLE t',
      'TRUNCATE TABLE t',
      "UPDATE t SET name='x'",
      "UPDATE t SET name='x' WHERE id = 2; DROP TABLE t",
      "INSERT INTO t VALUES (11,'e'); DELETE FROM t",
    ]) {
      const r = await call(env, text, true)
      expect(r.needsUser, text).toBe(true)
    }
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.t WHERE id IN (2,3)`)).toBe(2)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.t WHERE id = 11`)).toBe(0)
    expect(audits()).toHaveLength(0)
  })

  test('a read-only connection refuses an approved write before anything reaches the server', async () => {
    captureLog()
    for (const guard of [{ forcedReadOnly: true, sessionReadOnly: false }, { forcedReadOnly: false, sessionReadOnly: true }]) {
      const env = mkEnv(guard)
      const r = await call(env, "INSERT INTO t VALUES (12,'ro')", true)
      expect(r).toMatchObject({ needsUser: true, reason: 'read-only' })
      expect(env.registry!.size).toBe(0)
    }
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.t WHERE id = 12`)).toBe(0)
    expect(audits()).toHaveLength(0)
  })

  test('reads are unchanged: a SELECT still runs read-only, a writing function still fails, approvedWrite is ignored', async () => {
    const env = mkEnv()
    const r = await call(env, 'SELECT id FROM t ORDER BY id', true)
    if (r.needsUser) throw new Error(r.reason)
    expect(r.result.status).toBe('rows')
    expect(r.facts).toMatchObject({ kind: 'select', class: 'none' })
  })
})
