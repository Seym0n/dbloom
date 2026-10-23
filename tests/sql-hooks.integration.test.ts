import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { runForAssistant } from '~/server/sql/assistant'
import { openResultStream } from '~/server/sql/export-source'
import { RunRegistry } from '~/server/sql/registry'
import type { SqlHistoryRecord, SqlRunEnv } from '~/server/sql/run'
import { DEFAULT_SQL_LIMITS, type SqlLimits } from '~/server/sql/types'
import { PlanStore } from '~/server/structure/plans'

// SCN-035: the export hook (FR-SQL-026) and the assistant hook (FR-SQL-027) against real servers.

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
]
const DB = 'sql_hooks_scratch'
const ROWS = 50_000

describe.each(servers)('SQL hooks on $name', ({ port, product }) => {
  let pool: Pool
  let history: SqlHistoryRecord[] = []
  let logs: string[] = []

  const mkEnv = (over: Partial<SqlRunEnv> = {}, limits: Partial<SqlLimits> = {}): SqlRunEnv => ({
    session: {
      idHash: 'hooks-session',
      target: { host: '127.0.0.1', port, username: 'root' },
      pool,
    },
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens: createTokenIssuer(),
    limits: { ...DEFAULT_SQL_LIMITS, timeoutMs: 60_000, ...limits },
    plans: new PlanStore(),
    registry: new RunRegistry(),
    recordHistory: (r) => history.push(r),
    ...over,
  })
  const count = async (sql: string) => {
    const [rows] = await pool.query(sql)
    return Number((rows as { n: unknown }[])[0]!.n)
  }
  const auditLines = () =>
    logs.flatMap((l) => {
      try {
        const o = JSON.parse(l) as Record<string, unknown>
        return o.audit === 'sql.run' ? [o] : []
      } catch {
        return []
      }
    })
  const streaming = () =>
    count(
      "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT id, REPEAT%'",
    )

  beforeAll(async () => {
    pool = createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      connectionLimit: 4,
      charset: 'utf8mb4',
    })
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.query(`CREATE DATABASE ${DB}`)
    const c = await pool.getConnection()
    try {
      await c.query(`USE ${DB}`)
      await c.query('CREATE TABLE big (id INT PRIMARY KEY, pad VARCHAR(120)) ENGINE=InnoDB')
      await c.query('CREATE TABLE log (n INT)')
      await c.query('CREATE TABLE d (i INT)')
      await c.query('INSERT INTO d VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)')
      await c.query(
        `INSERT INTO big SELECT id, pad FROM (SELECT a.i + b.i * 10 + c.i * 100 + e.i * 1000 + f.i * 10000 + 1 AS id,
           REPEAT('x', 100) AS pad FROM d a, d b, d c, d e, d f) x WHERE id <= ${ROWS}`,
      )
      await c.query(
        'CREATE FUNCTION wr() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO log VALUES (1); RETURN 1; END',
      )
    } finally {
      c.release()
    }
  }, 120_000)

  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.end()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    history = []
    logs = []
  })

  const captureLog = () => {
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
  }
  const readOnlyVar = product === 'mysql' ? 'transaction_read_only' : 'tx_read_only'

  describe('openResultStream (FR-SQL-026)', () => {
    test('streams 50,000 rows ignoring the grid caps, without holding them, and releases the run', async () => {
      const env = mkEnv({}, { rowCap: 10, responseBytes: 1000 })
      const s = await openResultStream(env, {
        db: DB,
        text: 'SELECT id, pad FROM big ORDER BY id',
        statementIndex: 0,
      })
      expect(s.columns.map((c) => c.name)).toEqual(['id', 'pad'])
      expect(env.registry!.size).toBe(1)
      let n = 0
      let last = 0
      for await (const row of s.rows) {
        n++
        last = Number(row[0])
        // Rows are consumed one at a time: the run stays registered until the generator ends.
        if (n === 100) expect(env.registry!.size).toBe(1)
      }
      expect(n).toBe(ROWS)
      expect(last).toBe(ROWS)
      expect(env.registry!.size).toBe(0)
    }, 120_000)

    test('is lazy: the server sends only as the consumer pulls; closing early ends the statement', async () => {
      captureLog()
      const env = mkEnv()
      const s = await openResultStream(env, {
        db: DB,
        text: "SELECT id, REPEAT('x', 200000) AS pad FROM big WHERE id <= 5000",
        statementIndex: 0,
      })
      const it = s.rows[Symbol.asyncIterator]()
      for (let i = 0; i < 10; i++) expect((await it.next()).done).toBe(false)
      // About 1 GB of rows in total: a producer that ignored back pressure could not still be sending after this wait.
      await new Promise((r) => setTimeout(r, 1500))
      expect(await streaming()).toBe(1)
      expect(env.registry!.size).toBe(1)
      await s.close()
      expect(env.registry!.size).toBe(0)
      await vi.waitFor(async () => expect(await streaming()).toBe(0))
      expect(auditLines().some((l) => l.source === 'export')).toBe(true)
    }, 60_000)

    test('read-only is forced on a writable session; destructive statements are refused', async () => {
      const env = mkEnv()
      const ro = await openResultStream(env, {
        db: DB,
        text: `SELECT @@session.${readOnlyVar} AS ro`,
        statementIndex: 0,
      })
      const rows: unknown[][] = []
      for await (const r of ro.rows) rows.push(r)
      expect(String(rows[0]?.[0])).toMatch(/^(1|ON)$/)

      // A function that writes cannot write through the export.
      const w = await openResultStream(env, { db: DB, text: 'SELECT wr()', statementIndex: 0 })
      await expect(
        (async () => {
          for await (const r of w.rows) void r
        })(),
      ).rejects.toThrow()
      expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.log`)).toBe(0)

      for (const text of [
        'DELETE FROM big WHERE id = 1',
        'DROP TABLE big',
        'UPDATE big SET pad = 1',
        'TRUNCATE big',
      ]) {
        await expect(openResultStream(env, { db: DB, text, statementIndex: 0 })).rejects.toThrow(
          /not_exportable/,
        )
      }
      expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.big`)).toBe(ROWS)
      expect(env.registry!.size).toBe(0)
    })
  })

  describe('runForAssistant (FR-SQL-027)', () => {
    test('a SELECT runs inline under the row cap; audit and history carry source assistant', async () => {
      captureLog()
      const env = mkEnv()
      const r = await runForAssistant(env, {
        db: DB,
        text: 'SELECT id FROM big',
        conversationId: 'c1',
        maxRows: 25,
      })
      if (r.needsUser) throw new Error('expected a result')
      expect(r.ok).toBe(true)
      if (r.result.status !== 'rows') throw new Error(r.result.status)
      expect(r.result.rows).toHaveLength(25)
      expect(r.result.truncated).toEqual({ reason: 'rows', limit: 25 })

      // The inline cap defaults to 100; the server's own row cap wins over a larger request.
      const d = await runForAssistant(env, {
        db: DB,
        text: 'SELECT id FROM big',
        conversationId: 'c1',
      })
      if (d.needsUser || d.result.status !== 'rows') throw new Error('expected rows')
      expect(d.result.rows).toHaveLength(100)
      const capped = await runForAssistant(mkEnv({}, { rowCap: 7 }), {
        db: DB,
        text: 'SELECT id FROM big',
        conversationId: 'c1',
        maxRows: 5000,
      })
      if (capped.needsUser || capped.result.status !== 'rows') throw new Error('expected rows')
      expect(capped.result.rows).toHaveLength(7)

      const runs = auditLines()
      expect(runs).toHaveLength(3)
      expect(runs.every((l) => l.source === 'assistant')).toBe(true)
      expect(history).toHaveLength(3)
      expect(history.every((h) => h.source === 'assistant')).toBe(true)
    })

    test('UPDATE, DELETE, DROP, TRUNCATE and mixed batches return needsUser with a reason and run nothing', async () => {
      captureLog()
      const env = mkEnv()
      for (const text of [
        "UPDATE big SET pad = 'z' WHERE id = 1",
        'DELETE FROM big',
        'DROP TABLE big',
        'TRUNCATE TABLE big',
        'SELECT 1; DROP TABLE big',
      ]) {
        const r = await runForAssistant(env, { db: DB, text, conversationId: 'c1' })
        expect(r.needsUser, text).toBe(true)
        if (r.needsUser) expect(r.reason.length).toBeGreaterThan(0)
      }
      expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.big`)).toBe(ROWS)
      expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.big WHERE pad = 'z'`)).toBe(0)
      // Nothing reached the server: no run was audited, the registry is empty.
      expect(auditLines()).toHaveLength(0)
      expect(env.registry!.size).toBe(0)
    })

    test('read-only is forced for the assistant: a writing function fails and writes nothing', async () => {
      const env = mkEnv()
      const r = await runForAssistant(env, { db: DB, text: 'SELECT wr()', conversationId: 'c1' })
      if (r.needsUser) throw new Error('expected a result')
      expect(r.result.status).toBe('failed')
      expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.log`)).toBe(0)
    })
  })
})
