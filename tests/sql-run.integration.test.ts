import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { parsePlan } from '~/lib/sql/plan-tree'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { estimateAffected } from '~/server/sql/estimate'
import { explainSql, planAnalyse } from '~/server/sql/explain'
import { openResultStream } from '~/server/sql/export-source'
import { runForAssistant } from '~/server/sql/assistant'
import { RunRegistry, cancelRun } from '~/server/sql/registry'
import { confirmSqlRun, runSqlText, type SqlHistoryRecord, type SqlRunEnv } from '~/server/sql/run'
import {
  DEFAULT_SQL_LIMITS,
  type RunSqlInput,
  type SqlLimits,
  type SqlRunResponse,
  type SqlStatementResult,
} from '~/server/sql/types'
import { structureEvents } from '~/server/structure/execute'
import { PlanStore } from '~/server/structure/plans'

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
]

const DB = 'sql_b_scratch'
const DB2 = 'sql_b_scratch2'

type Done = Extract<SqlRunResponse, { kind: 'done' }>
type Confirm = Extract<SqlRunResponse, { kind: 'confirm' }>

let counter = 0
const input = (text: string, extra: Partial<RunSqlInput> = {}): RunSqlInput => ({
  runId: `run-test-${++counter}`,
  tabId: 'tab1',
  db: DB,
  text,
  options: {
    continueOnError: false,
    singleTransaction: false,
    disableForeignKeyChecks: false,
    confirmSoft: false,
  },
  ...extra,
})
const opts = (o: Partial<RunSqlInput['options']>): RunSqlInput['options'] => ({
  continueOnError: false,
  singleTransaction: false,
  disableForeignKeyChecks: false,
  confirmSoft: false,
  ...o,
})

async function runConfirmed(env: SqlRunEnv, inp: RunSqlInput): Promise<Done> {
  const r = await runSqlText(env, inp)
  if (r.kind === 'done') return r
  return asDone(
    await confirmSqlRun(env, {
      runId: `${inp.runId}-c`,
      planId: r.planId,
      confirmToken: r.confirmToken,
    }),
  )
}

function asDone(r: SqlRunResponse): Done {
  expect(r.kind).toBe('done')
  return r as Done
}
function asConfirm(r: SqlRunResponse): Confirm {
  expect(r.kind).toBe('confirm')
  return r as Confirm
}
const statuses = (r: Done) => r.results.map((x) => `${x.index}:${x.status}`)
function rowsOf(r: SqlStatementResult | undefined) {
  if (!r || r.status !== 'rows') throw new Error(`expected rows, got ${r?.status}`)
  return r
}

describe.each(servers)('sql runner on $name', ({ port, product }) => {
  let pool: Pool
  let tokens = createTokenIssuer()
  let history: SqlHistoryRecord[] = []
  let logs: string[] = []

  const mkEnv = (over: Partial<SqlRunEnv> = {}, limits: Partial<SqlLimits> = {}): SqlRunEnv => ({
    session: {
      idHash: 'session-1',
      target: { host: '127.0.0.1', port, username: 'root' },
      pool,
    },
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens,
    limits: { ...DEFAULT_SQL_LIMITS, timeoutMs: 30_000, ...limits },
    plans: new PlanStore(),
    registry: new RunRegistry(),
    recordHistory: (r) => history.push(r),
    ...over,
  })

  const count = async (sql: string): Promise<number> => {
    const [rows] = await pool.query(sql)
    return Number((rows as { n: unknown }[])[0]!.n)
  }
  const sleepers = () =>
    count(
      "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP%' OR INFO LIKE 'SELECT n, SLEEP%' OR INFO LIKE 'SELECT a.n, SLEEP%'",
    )

  beforeAll(async () => {
    pool = createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      connectionLimit: 4,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      jsonStrings: true,
    })
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.query(`DROP DATABASE IF EXISTS ${DB2}`)
    await pool.query(`CREATE DATABASE ${DB}`)
    await pool.query(`CREATE DATABASE ${DB2}`)
    const c = await pool.getConnection()
    try {
      await c.query(`USE ${DB}`)
      await c.query(
        'CREATE TABLE customer (id INT PRIMARY KEY, name VARCHAR(40), score INT) ENGINE=InnoDB',
      )
      await c.query(
        'INSERT INTO customer SELECT seq, CONCAT("n", seq), seq MOD 10 FROM (' +
          'SELECT a.i + b.i * 10 + c.i * 100 + 1 AS seq FROM ' +
          '(SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a, ' +
          '(SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b, ' +
          '(SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c) x',
      )
      await c.query('CREATE TABLE seq (n INT)')
      await c.query('INSERT INTO seq SELECT id FROM customer WHERE id <= 300')
      await c.query(
        'CREATE TABLE kinds (i INT, b BIGINT, d DECIMAL(10,2), f DOUBLE, s VARCHAR(20), t TEXT, bl BLOB, dt DATE, ts DATETIME, j JSON, n INT NULL)',
      )
      await c.query(
        "INSERT INTO kinds VALUES (7, 9007199254740993, 12.50, 1.5, 'héllo €', REPEAT('x', 300), X'DEADBEEF', '2026-10-23', '2026-10-23 12:34:56', '{\"a\": [1, 2]}', NULL)",
      )
      await c.query('CREATE TABLE parent (id INT PRIMARY KEY) ENGINE=InnoDB')
      await c.query(
        'CREATE TABLE child (id INT PRIMARY KEY, pid INT, FOREIGN KEY (pid) REFERENCES parent(id)) ENGINE=InnoDB',
      )
      await c.query('INSERT INTO parent VALUES (1)')
      await c.query('INSERT INTO child VALUES (1, 1)')
      await c.query(
        'CREATE PROCEDURE p() BEGIN SELECT 1 AS a; SELECT id, name FROM customer WHERE id <= 3; UPDATE customer SET score = score WHERE id = 1; SELECT 3 AS c; END',
      )
      await c.query(
        'CREATE FUNCTION wf() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO seq VALUES (-1); RETURN 1; END',
      )
    } finally {
      c.release()
    }
  }, 60_000)

  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.query(`DROP DATABASE IF EXISTS ${DB2}`)
    await pool.end()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    tokens = createTokenIssuer()
    history = []
    logs = []
  })

  const captureLog = () => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
  }

  test('SELECT with all value kinds, exact text, one grid', async () => {
    const env = mkEnv()
    const text = 'SELECT i, b, d, f, s, t, bl, dt, ts, j, n FROM kinds -- foobar'
    const r = asDone(await runSqlText(env, input(text)))
    expect(r.ok).toBe(true)
    expect(r.results).toHaveLength(1)
    const g = rowsOf(r.results[0])
    expect(g.sql).toBe(text)
    expect(g.columns.map((c) => c.name)).toEqual('i b d f s t bl dt ts j n'.split(' '))
    const row = g.rows[0]!
    expect(String(row[0])).toBe('7')
    expect(row[1]).toBe('9007199254740993')
    expect(row[2]).toBe('12.50')
    expect(row[4]).toBe('héllo €')
    expect(row[5]).toBe('x'.repeat(300))
    expect(row[6]).toEqual({ binary: 'deadbeef', size: 4 })
    expect(row[7]).toBe('2026-10-23')
    expect(row[8]).toBe('2026-10-23 12:34:56')
    expect(JSON.parse(row[9] as string)).toEqual({ a: [1, 2] })
    expect(row[10]).toBeNull()
    expect(g.rowCount).toBe(1)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ outcome: 'ok', statements: 1, executed: 1, text })
  })

  test('unaliased expression is the header; duplicate names survive; <img> stays text', async () => {
    const r = asDone(
      await runSqlText(
        mkEnv(),
        input("SELECT (SELECT COUNT(*) FROM customer), 1 AS x, 2 AS x, '<img onerror=alert(1)>'"),
      ),
    )
    const g = rowsOf(r.results[0])
    expect(g.columns[0]!.name).toBe('(SELECT COUNT(*) FROM customer)')
    expect(g.columns.map((c) => c.name).slice(1, 3)).toEqual(['x', 'x'])
    expect(g.rows[0]![0]).toBe('1000')
    expect(g.rows[0]![3]).toBe('<img onerror=alert(1)>')
  })

  test('multi-statement with a failure in the middle: executed, failed, not-run', async () => {
    const env = mkEnv()
    const r = asDone(
      await runSqlText(
        env,
        input('CREATE TABLE t1 (id INT);\nINSERT INTO nope VALUES (1);\nSELECT 1'),
      ),
    )
    expect(statuses(r)).toEqual(['0:ok', '1:failed', '2:not-run'])
    expect(r.ok).toBe(false)
    const failed = r.results[1]!
    if (failed.status !== 'failed') throw new Error('x')
    expect(failed.error.errno).toBe(1146)
    expect(failed.error.hint).toMatch(/does not exist/)
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='t1'`,
      ),
    ).toBe(1)
    expect(history[0]).toMatchObject({
      outcome: 'failed',
      failedIndex: 1,
      executed: 1,
      statements: 3,
    })
    await pool.query(`DROP TABLE ${DB}.t1`)
  })

  test('continue on error runs the rest', async () => {
    const r = asDone(
      await runSqlText(
        mkEnv(),
        input('SELECT 1; INSERT INTO nope VALUES (1); SELECT 3', {
          options: opts({ continueOnError: true }),
        }),
      ),
    )
    expect(statuses(r)).toEqual(['0:rows', '1:failed', '2:rows'])
    expect(r.ok).toBe(false)
  })

  test('syntax error: errno 1064, position relative to the statement text', async () => {
    const text = 'SELECT 1;\n\nSELEC 2'
    const r = await runConfirmed(mkEnv(), input(text))
    const f = r.results[1]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.errno).toBe(1064)
    expect(f.error.position).toEqual({ line: 1, column: 1 })
    expect(f.error.hint).toMatch(/DELIMITER/)
  })

  test('a multi-line statement gets a line and column relative to itself', async () => {
    const text = 'SELECT 1;\n\nSELECT 1\n  FROM customer\n  WHERE'
    const r = await runConfirmed(mkEnv(), input(text))
    const f = r.results[1]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.position?.line).toBe(3)
    expect(f.error.position?.column).toBeGreaterThanOrEqual(1)
  })

  test('the confirm plan carries the full statement text up to 64 KiB', async () => {
    const small = asConfirm(await runSqlText(mkEnv(), input('DELETE FROM customer')))
    expect(small.statements[0]!.fullSql).toBe('DELETE FROM customer')
    const long = `DELETE FROM customer /* ${'x'.repeat(70_000)} */`
    const big = asConfirm(await runSqlText(mkEnv(), input(long)))
    expect(big.statements[0]!.fullSql).toBeUndefined()
    expect(big.statements[0]!.sql.endsWith('...')).toBe(true)
  })

  test('structure changes are reported in the response and emitted as structure.changed', async () => {
    const events: unknown[] = []
    const on = (e: unknown) => events.push(e)
    structureEvents.on('changed', on)
    try {
      const r = await runConfirmed(
        mkEnv(),
        input(
          `CREATE DATABASE IF NOT EXISTS sql_b_tmp_db; CREATE TABLE ${DB}.t_chg (id INT); TRUNCATE TABLE t_chg; DROP TABLE ${DB}.t_chg; DROP DATABASE sql_b_tmp_db`,
        ),
      )
      expect(r.ok).toBe(true)
      expect(r.changed).toEqual([
        { db: 'sql_b_tmp_db', database: true },
        { db: DB, table: 't_chg' },
        { db: DB, table: 't_chg' },
        { db: DB, table: 't_chg' },
        { db: 'sql_b_tmp_db', database: true },
      ])
      expect(events).toEqual([
        { db: 'sql_b_tmp_db' },
        { db: DB, table: 't_chg' },
        { db: DB, table: 't_chg' },
        { db: 'sql_b_tmp_db' },
      ])
    } finally {
      structureEvents.off('changed', on)
    }
  })

  test('planAnalyse of a safe read is not needed', async () => {
    await expect(planAnalyse(mkEnv(), { db: DB, text: 'SELECT 1' })).rejects.toThrow(
      /^no_confirmation_needed:/,
    )
  })

  test('error position follows a selection range', async () => {
    const text = 'SELECT 1;\nSELEC 2;\nSELECT 3'
    const from = text.indexOf('SELEC 2')
    const r = await runConfirmed(mkEnv(), input(text, { range: { from, to: from + 8 } }))
    const f = r.results[0]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.position).toMatchObject({ line: 1 })
  })

  test('an unterminated string is refused before anything runs', async () => {
    await pool.query(`DROP TABLE IF EXISTS ${DB}.t_lex`)
    await expect(
      runSqlText(mkEnv(), input("CREATE TABLE t_lex (id INT); SELECT 'abc")),
    ).rejects.toThrow(/^unterminated-string@\d+:/)
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='t_lex'`,
      ),
    ).toBe(0)
  })

  test('destructive statement without confirmation returns confirm and runs nothing', async () => {
    const env = mkEnv()
    const r = asConfirm(await runSqlText(env, input('DELETE FROM customer')))
    expect(r.maxClass).toBe('hard')
    expect(r.confirmRequired).toBe(true)
    expect(r.confirmToken).toBeTruthy()
    expect(r.statements[0]).toMatchObject({ index: 0, class: 'hard' })
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
    // a batch waits as a whole
    const batch = asConfirm(await runSqlText(env, input('SELECT 1; DROP TABLE nothing_here')))
    expect(batch.statements.map((s) => s.index)).toEqual([1])
  })

  test('comments and strings with DROP do not trigger a confirmation', async () => {
    const env = mkEnv()
    const r = asDone(
      await runSqlText(
        env,
        input("/* DROP TABLE customer */ SELECT '; DROP TABLE customer; --' AS s -- DROP TABLE x"),
      ),
    )
    expect(rowsOf(r.results[0]).rows[0]![0]).toBe('; DROP TABLE customer; --')
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
  })

  test('hostile and unicode text goes through unchanged', async () => {
    const text = "SELECT 'a'';DROP TABLE customer;--' AS h, '日本語 😀 ñ' AS u"
    const r = asDone(await runSqlText(mkEnv(), input(text)))
    const g = rowsOf(r.results[0])
    expect(g.rows[0]).toEqual(["a';DROP TABLE customer;--", '日本語 😀 ñ'])
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
  })

  test('token flow: missing, tampered, replay, other session, edited text, then valid once', async () => {
    const env = mkEnv()
    const make = async () =>
      asConfirm(await runSqlText(env, input('DELETE FROM seq WHERE n > 0 OR 1 = 1')))
    // The class of this statement is up to the classifier; use DROP TABLE for a certain hard class.
    await pool.query(`CREATE TABLE ${DB}.victim (id INT)`)
    const plan = async () => asConfirm(await runSqlText(env, input(`DROP TABLE ${DB}.victim`)))

    let c = await plan()
    await expect(confirmSqlRun(env, { runId: 'run-test-c1', planId: c.planId })).rejects.toThrow(
      /token-missing/,
    )
    // the failed attempt did not spend the plan; a tampered token is refused as well
    await expect(
      confirmSqlRun(env, {
        runId: 'run-test-c2',
        planId: c.planId,
        confirmToken: `${c.confirmToken!.slice(0, -2)}xx`,
      }),
    ).rejects.toThrow(/token-invalid/)
    // a token of another plan
    const other = await plan()
    await expect(
      confirmSqlRun(env, {
        runId: 'run-test-c3',
        planId: c.planId,
        confirmToken: other.confirmToken,
      }),
    ).rejects.toThrow(/token-invalid/)
    // another session cannot use the plan
    const env2 = mkEnv({ session: { ...env.session, idHash: 'session-2' }, plans: env.plans })
    await expect(
      confirmSqlRun(env2, { runId: 'run-test-c4', planId: c.planId, confirmToken: c.confirmToken }),
    ).rejects.toThrow(/plan_expired/)
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='victim'`,
      ),
    ).toBe(1)

    // valid, once
    const r = asDone(
      await confirmSqlRun(env, {
        runId: 'run-test-c5',
        planId: c.planId,
        confirmToken: c.confirmToken,
      }),
    )
    expect(r.ok).toBe(true)
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='victim'`,
      ),
    ).toBe(0)
    // replay
    await expect(
      confirmSqlRun(env, { runId: 'run-test-c6', planId: c.planId, confirmToken: c.confirmToken }),
    ).rejects.toThrow(/plan_expired/)

    // an expired plan
    let now = Date.now()
    const env3 = mkEnv({ plans: new PlanStore(() => now), now: () => now })
    c = asConfirm(await runSqlText(env3, input(`DROP TABLE ${DB}.victim`)))
    now += 11 * 60_000
    await expect(
      confirmSqlRun(env3, { runId: 'run-test-c7', planId: c.planId, confirmToken: c.confirmToken }),
    ).rejects.toThrow(/plan_expired/)
    void make
    // the plan of another module is not accepted
    const foreign = env.plans!.create('session-1', {
      statements: [],
      warnings: [],
      statementsHash: 'x',
    })
    await expect(
      confirmSqlRun(env, { runId: 'run-test-c8', planId: foreign.planId }),
    ).rejects.toThrow(/plan_expired/)
  })

  test('soft class asks only when the user preference is on', async () => {
    const env = mkEnv()
    await pool.query(`DROP TABLE IF EXISTS ${DB}.s1`)
    const text = `CREATE TABLE s1 (id INT); ALTER TABLE s1 ADD COLUMN x INT`
    const asked = asConfirm(
      await runSqlText(env, input(text, { options: opts({ confirmSoft: true }) })),
    )
    expect(asked.maxClass).toBe('soft')
    expect(asked.confirmRequired).toBe(false)
    expect(asked.confirmToken).toBeUndefined()
    const r = asDone(await confirmSqlRun(env, { runId: 'run-test-s1', planId: asked.planId }))
    expect(r.ok).toBe(true)
    const direct = asDone(await runSqlText(env, input('ALTER TABLE s1 ADD COLUMN y INT')))
    expect(direct.ok).toBe(true)
    await pool.query(`DROP TABLE ${DB}.s1`)
  })

  test('read-only: refused before any connection; safe reads run', async () => {
    const env = mkEnv({ guard: { forcedReadOnly: true, sessionReadOnly: false } })
    const getConn = vi.spyOn(pool, 'getConnection')
    const query = vi.spyOn(pool, 'query')
    for (const sql of [
      'INSERT INTO customer VALUES (5000, "x", 1)',
      'CREATE TABLE ro1 (a INT)',
      'SET SESSION TRANSACTION READ WRITE',
      'START TRANSACTION READ WRITE',
      'SELECT 1; DROP TABLE customer',
      'CALL p()',
      'LOCK TABLES customer READ',
      "SELECT * FROM customer INTO OUTFILE '/tmp/x'",
    ]) {
      await expect(runSqlText(env, input(sql))).rejects.toThrow(/read-only/)
    }
    expect(getConn).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)

    for (const sql of [
      'SELECT 1',
      'SHOW TABLES',
      'DESCRIBE customer',
      'EXPLAIN SELECT 1',
      `USE ${DB2}`,
    ]) {
      const r = asDone(await runSqlText(env, input(sql)))
      expect(r.ok, sql).toBe(true)
    }
  })

  test('read-only second layer: a SELECT of a writing function fails with 1792', async () => {
    const env = mkEnv({ guard: { forcedReadOnly: false, sessionReadOnly: true } })
    const r = asDone(await runSqlText(env, input('SELECT wf()')))
    const f = r.results[0]!
    if (f.status !== 'failed') throw new Error(`expected failed, got ${f.status}`)
    expect(f.error.errno).toBe(1792)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.seq WHERE n = -1`)).toBe(0)
    // the same function on a read-write connection writes
    const rw = asDone(await runSqlText(mkEnv(), input('SELECT wf()')))
    expect(rw.ok).toBe(true)
    await pool.query(`DELETE FROM ${DB}.seq WHERE n = -1`)
  })

  test('timeout: SLEEP is stopped, reported as time limit, thread gone, next run works', async () => {
    const env = mkEnv({}, { timeoutMs: 1000 })
    const started = Date.now()
    const r = asDone(await runSqlText(env, input('SELECT SLEEP(10); SELECT 2')))
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(4000)
    const f = r.results[0]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.code).toBe('timeout')
    expect(f.error.message).toMatch(/Stopped after 1 s \(time limit\)/)
    expect(r.results[1]!.status).toBe('not-run')
    expect(history[0]!.outcome).toBe('timeout')
    await new Promise((res) => setTimeout(res, 200))
    expect(await sleepers()).toBe(0)
    const next = asDone(await runSqlText(env, input('SELECT 3')))
    expect(next.ok).toBe(true)
  })

  test('timeout of the second statement keeps the first result', async () => {
    const env = mkEnv({}, { timeoutMs: 1000 })
    const r = asDone(
      await runSqlText(env, input('SELECT 1; UPDATE customer SET score = SLEEP(5) WHERE id = 1')),
    )
    expect(statuses(r)).toEqual(['0:rows', '1:failed'])
    const f = r.results[1]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.code).toBe('timeout')
    // the killed update is rolled back by the server
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer WHERE id = 1 AND score = 1`)).toBe(
      1,
    )
  })

  test('row cap: truncated message data, no thread left, next statement fine', async () => {
    const env = mkEnv({}, { rowCap: 50 })
    const r = asDone(
      await runSqlText(
        env,
        input('SELECT a.n, SLEEP(0.0001) FROM seq a, seq b, (SELECT 1 UNION SELECT 2) c; SELECT 5'),
      ),
    )
    const g = rowsOf(r.results[0])
    expect(g.rows).toHaveLength(50)
    expect(g.rowCount).toBe(50)
    expect(g.truncated).toEqual({ reason: 'rows', limit: 50 })
    expect(rowsOf(r.results[1]).rows[0]![0]).toBe('5')
    expect(r.ok).toBe(true)
    await new Promise((res) => setTimeout(res, 200))
    expect(await sleepers()).toBe(0)
  })

  test('exactly the cap is not truncated', async () => {
    const env = mkEnv({}, { rowCap: 300 })
    const g = rowsOf(asDone(await runSqlText(env, input('SELECT n FROM seq'))).results[0])
    expect(g.rows).toHaveLength(300)
    expect(g.truncated).toBeUndefined()
  })

  test('byte cap is shared and says bytes; cell cap cuts with the length', async () => {
    const env = mkEnv({}, { responseBytes: 3000, cellBytes: 100 })
    const r = asDone(
      await runSqlText(
        env,
        input("SELECT REPEAT('y', 90) FROM seq; SELECT REPEAT('z', 500) AS big"),
      ),
    )
    const g = rowsOf(r.results[0])
    expect(g.truncated).toMatchObject({ reason: 'bytes', limit: 3000 })
    expect(g.rows.length).toBeGreaterThan(5)
    expect(g.rows.length).toBeLessThan(300)
    // the budget is spent: the second set is cut as well, before its first row
    const second = rowsOf(r.results[1])
    expect(second.truncated?.reason).toBe('bytes')
    const env2 = mkEnv({}, { cellBytes: 100 })
    const c = rowsOf(
      asDone(await runSqlText(env2, input("SELECT REPEAT('z', 500) AS big"))).results[0],
    )
    const cell = c.rows[0]![0] as { cut: string; length: number }
    expect(cell.length).toBe(500)
    expect(Buffer.byteLength(cell.cut)).toBeLessThanOrEqual(100)
  })

  test('cancel mid-run: cancelled, rest not-run, no thread, registry empty', async () => {
    const env = mkEnv()
    const inp = input('SELECT SLEEP(30); SELECT 2')
    const running = runSqlText(env, inp)
    await new Promise((res) => setTimeout(res, 500))
    expect(env.registry!.countRunning('session-1')).toBe(1)
    // another session cannot cancel it
    await cancelRun(
      { session: { ...env.session, idHash: 'session-2' }, registry: env.registry },
      inp.runId,
    )
    const t0 = Date.now()
    await cancelRun(env, inp.runId)
    const r = asDone(await running)
    expect(Date.now() - t0).toBeLessThan(2000)
    const f = r.results[0]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.code).toBe('cancelled')
    expect(f.error.message).toBe('Cancelled by you')
    expect(r.results[1]!.status).toBe('not-run')
    expect(history[0]!.outcome).toBe('cancelled')
    expect(env.registry!.size).toBe(0)
    await cancelRun(env, inp.runId) // finished: harmless
    await cancelRun(env, 'does-not-exist')
    await new Promise((res) => setTimeout(res, 200))
    expect(await sleepers()).toBe(0)
    expect(asDone(await runSqlText(env, input('SELECT 1'))).ok).toBe(true)
  })

  test('cancel releases LOCK TABLES', async () => {
    const env = mkEnv()
    const inp = input('LOCK TABLES customer WRITE; SELECT SLEEP(30)')
    // LOCK TABLES is soft in the real classifier and runs without confirmation by default
    const running = runSqlText(env, inp)
    await new Promise((res) => setTimeout(res, 500))
    await cancelRun(env, inp.runId)
    await running
    const t0 = Date.now()
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('concurrency: two runs at once, the third is busy, cancel still works', async () => {
    const env = mkEnv({}, { maxConcurrentRuns: 2 })
    const a = input('SELECT SLEEP(20)')
    const b = input('SELECT SLEEP(20)')
    const ra = runSqlText(env, a)
    const rb = runSqlText(env, b)
    await new Promise((res) => setTimeout(res, 500))
    await expect(runSqlText(env, input('SELECT 1'))).rejects.toThrow(/busy/)
    // browse-like work on the pool is not blocked
    const t0 = Date.now()
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
    expect(Date.now() - t0).toBeLessThan(1500)
    await cancelRun(env, a.runId)
    await cancelRun(env, b.runId)
    await Promise.all([ra, rb])
    expect(asDone(await runSqlText(env, input('SELECT 1'))).ok).toBe(true)
  })

  test('CALL with several result sets and the final OK', async () => {
    const r = asDone(await runSqlText(mkEnv(), input('CALL p()')))
    expect(r.results.map((x) => `${x.index}:${x.status}`)).toEqual([
      '0:rows',
      '0:rows',
      '0:rows',
      '0:ok',
    ])
    expect(rowsOf(r.results[1]).rows).toEqual([
      ['1', 'n1'],
      ['2', 'n2'],
      ['3', 'n3'],
    ])
    expect(rowsOf(r.results[1]).columns.map((c) => c.name)).toEqual(['id', 'name'])
  })

  test('session variables and sql_mode do not leak to the next run or the pool', async () => {
    const env = mkEnv()
    const r = asDone(
      await runSqlText(
        env,
        input("SET SESSION sql_mode = 'ANSI'; SET @x := 7; SELECT @@sql_mode, @x"),
      ),
    )
    const g = rowsOf(r.results[2])
    expect(g.rows[0]![0]).toMatch(/ANSI/)
    expect(g.rows[0]![1]).toBe('7')
    const r2 = asDone(await runSqlText(env, input('SELECT @x, @@sql_mode')))
    const g2 = rowsOf(r2.results[0])
    expect(g2.rows[0]![0]).toBeNull()
    expect(g2.rows[0]![1]).not.toMatch(/(^|,)ANSI(,|$)/)
    const [rows] = await pool.query('SELECT @x AS x')
    expect((rows as { x: unknown }[])[0]!.x).toBeNull()
  })

  test('USE tracking and the selected database', async () => {
    const env = mkEnv()
    const r = asDone(await runSqlText(env, input('SELECT DATABASE()')))
    expect(rowsOf(r.results[0]).rows[0]![0]).toBe(DB)
    expect(r.db).toBeUndefined()
    const u = asDone(await runSqlText(env, input(`USE ${DB2}; SELECT DATABASE()`)))
    expect(u.db).toBe(DB2)
    expect(rowsOf(u.results[1]).rows[0]![0]).toBe(DB2)
    await expect(runSqlText(env, input('SELECT 1', { db: 'no_such_db_xyz' }))).rejects.toThrow(
      /not_found/,
    )
  })

  test('foreign key option: needs the hard confirmation, deletes, and does not leak', async () => {
    const env = mkEnv()
    const plain = asDone(await runSqlText(env, input('DELETE FROM parent WHERE id = 1')))
    const f = plain.results[0]!
    if (f.status !== 'failed') throw new Error('x')
    expect(f.error.errno).toBe(1451)
    expect(f.error.hint).toBeTruthy()

    const c = asConfirm(
      await runSqlText(
        env,
        input('DELETE FROM parent WHERE id = 1', {
          options: opts({ disableForeignKeyChecks: true }),
        }),
      ),
    )
    expect(c.maxClass).toBe('hard')
    expect(c.statements.some((s) => s.sql.includes('foreign_key_checks'))).toBe(true)
    const r = asDone(
      await confirmSqlRun(env, {
        runId: 'run-test-fk',
        planId: c.planId,
        confirmToken: c.confirmToken,
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.notes.join(' ')).toMatch(/Foreign key checks were off/)
    const next = asDone(await runSqlText(env, input('SELECT @@foreign_key_checks')))
    expect(rowsOf(next.results[0]).rows[0]![0]).toBe('1')
    await pool.query(`INSERT INTO ${DB}.parent VALUES (1)`)
  })

  test('run in one transaction: error rolls back; DDL commits earlier changes', async () => {
    const env = mkEnv()
    await pool.query(`CREATE TABLE ${DB}.tx (id INT PRIMARY KEY) ENGINE=InnoDB`)
    const t = opts({ singleTransaction: true, continueOnError: true })
    const r = asDone(
      await runSqlText(
        env,
        input('INSERT INTO tx VALUES (1); INSERT INTO tx VALUES (1); INSERT INTO tx VALUES (2)', {
          options: t,
        }),
      ),
    )
    expect(statuses(r)).toEqual(['0:ok', '1:failed', '2:not-run'])
    expect(r.notes.join(' ')).toMatch(/rolled back/)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.tx`)).toBe(0)

    const ok = asDone(
      await runSqlText(
        env,
        input('INSERT INTO tx VALUES (1); INSERT INTO tx VALUES (2)', { options: t }),
      ),
    )
    expect(ok.ok).toBe(true)
    expect(ok.notes.join(' ')).toMatch(/committed/)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.tx`)).toBe(2)

    await pool.query(`DELETE FROM ${DB}.tx`)
    const ddl = asDone(
      await runSqlText(
        env,
        input(
          'INSERT INTO tx VALUES (1); ALTER TABLE tx ADD COLUMN z INT; INSERT INTO tx VALUES (1)',
          { options: t },
        ),
      ),
    )
    expect(statuses(ddl)).toEqual(['0:ok', '1:ok', '2:failed'])
    expect(ddl.notes.join(' ')).toMatch(/end a transaction implicitly/)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.tx`)).toBe(1) // the first insert stays
    await pool.query(`DROP TABLE ${DB}.tx`)
  })

  test('an open transaction in the text is rolled back and the result says so', async () => {
    const env = mkEnv()
    await pool.query(`CREATE TABLE ${DB}.tx2 (id INT) ENGINE=InnoDB`)
    const r = asDone(await runSqlText(env, input('START TRANSACTION; INSERT INTO tx2 VALUES (1)')))
    expect(r.notes.join(' ')).toMatch(/left open/)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.tx2`)).toBe(0)
    await pool.query(`DROP TABLE ${DB}.tx2`)
  })

  test('warnings come from SHOW WARNINGS', async () => {
    const r = asDone(
      await runSqlText(mkEnv(), input("SELECT 1/0 AS z; SELECT CAST('a' AS SIGNED)")),
    )
    const g = rowsOf(r.results[0])
    expect(g.warnings[0]).toMatchObject({ level: 'Warning', code: 1365 })
    const g2 = rowsOf(r.results[1])
    expect(g2.warnings[0]!.code).toBe(1292)
  })

  test('audit: counts and hashes only, never SQL text or literals', async () => {
    captureLog()
    const env = mkEnv()
    await pool.query(`CREATE TABLE ${DB}.au (a VARCHAR(30))`)
    const c = asConfirm(await runSqlText(env, input("DROP TABLE au; SELECT 'topsecretliteral'")))
    await confirmSqlRun(env, {
      runId: 'run-test-au',
      planId: c.planId,
      confirmToken: c.confirmToken,
    })
    await expect(confirmSqlRun(env, { runId: 'run-test-au2', planId: c.planId })).rejects.toThrow()
    const lines = logs.filter((l) => l.includes('"audit"'))
    expect(lines.some((l) => l.includes('sql.run'))).toBe(true)
    expect(lines.some((l) => l.includes('sql.statement') && l.includes('"class":"hard"'))).toBe(
      true,
    )
    expect(lines.some((l) => l.includes('"outcome":"refused"'))).toBe(true)
    const all = logs.join('\n')
    expect(all).not.toMatch(/topsecretliteral|DROP TABLE/i)
    expect(all).not.toContain(c.confirmToken!)
    for (const l of lines.filter((x) => x.includes('sql.statement'))) {
      expect(JSON.parse(l).statementHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('history never fails a run', async () => {
    const env = mkEnv({
      recordHistory: () => {
        throw new Error('store down')
      },
    })
    expect(asDone(await runSqlText(env, input('SELECT 1'))).ok).toBe(true)
  })

  // ---- explain, estimate, hooks -----------------------------------------------------------------------------

  test('explain: json parses to a tree; text; analyse of a SELECT runs it', async () => {
    const env = mkEnv()
    const e = await explainSql(env, {
      db: DB,
      text: 'SELECT * FROM customer WHERE id = 5',
      mode: 'explain',
      format: 'json',
    })
    expect(e.format).toBe('json')
    const tree = parsePlan(e.raw)!
    expect(tree.children[0]).toMatchObject({ table: 'customer' })

    const t = await explainSql(env, {
      db: DB,
      text: 'SELECT * FROM customer WHERE id = 5',
      mode: 'explain',
      format: 'text',
    })
    expect(t.format).toBe('text')
    expect(t.raw).toMatch(/customer/)

    const a = await explainSql(env, {
      db: DB,
      text: 'SELECT * FROM customer WHERE id > 5',
      mode: 'analyse',
      format: 'json',
    })
    if (product === 'mysql') {
      expect(a.format).toBe('tree')
      expect(a.raw).toMatch(/actual time/)
    } else {
      expect(a.format).toBe('json')
      expect(a.raw).toMatch(/r_total_time_ms/)
    }
    expect(parsePlan(a.raw)).toBeDefined()
  })

  test('explain: two statements and unexplainable kinds are refused; read-only allows EXPLAIN only', async () => {
    const env = mkEnv()
    await expect(
      explainSql(env, { db: DB, text: 'SELECT 1; SELECT 2', mode: 'explain', format: 'json' }),
    ).rejects.toThrow(/select_one_statement/)
    await expect(
      explainSql(env, { db: DB, text: 'DROP TABLE customer', mode: 'explain', format: 'json' }),
    ).rejects.toThrow(/cannot_explain/)
    // D3: the server's own message comes along with the generic text.
    await expect(
      explainSql(env, { db: DB, text: 'SHOW TABLES', mode: 'explain', format: 'json' }),
    ).rejects.toThrow(/cannot_explain.*cannot be explained: .*(syntax|SHOW)/is)
    const ro = mkEnv({ guard: { forcedReadOnly: true, sessionReadOnly: false } })
    const e = await explainSql(ro, {
      db: DB,
      text: "UPDATE customer SET name = 'y' WHERE id = 5",
      mode: 'explain',
      format: 'json',
    })
    expect(e.raw).toBeTruthy()
    await expect(
      explainSql(ro, {
        db: DB,
        text: "UPDATE customer SET name = 'y' WHERE id = 5",
        mode: 'analyse',
        format: 'json',
      }),
    ).rejects.toThrow(/read-only/)
    await expect(
      planAnalyse(ro, { db: DB, text: "UPDATE customer SET name = 'y' WHERE id = 5" }),
    ).rejects.toThrow(/read-only/)
  })

  test('analyse of a changing statement needs the hard token and then runs once', async () => {
    const env = mkEnv()
    const text = "UPDATE customer SET name = 'analysed' WHERE id = 5"
    const req = { db: DB, text, mode: 'analyse' as const, format: 'json' as const }
    await expect(explainSql(env, req)).rejects.toThrow(/confirm_required/)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer WHERE name = 'analysed'`)).toBe(0)

    const plan = await planAnalyse(env, { db: DB, text })
    expect(plan.maxClass).toBe('hard')
    await expect(explainSql(env, { ...req, planId: plan.planId })).rejects.toThrow(/token-missing/)
    await expect(
      explainSql(env, {
        ...req,
        text: `${text} `,
        planId: plan.planId,
        confirmToken: plan.confirmToken,
      }),
    ).rejects.toThrow(/plan_expired/)
    const r = await explainSql(env, {
      ...req,
      planId: plan.planId,
      confirmToken: plan.confirmToken,
    })
    expect(r.raw).toBeTruthy()
    // MySQL 8.4 reports a single-table UPDATE as '<not executable by iterator executor>' and changes nothing;
    // MariaDB executes it. The token is required on both.
    if (product === 'mysql') expect(r.raw).toMatch(/not executable/)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer WHERE name = 'analysed'`)).toBe(
      product === 'mariadb' ? 1 : 0,
    )
    await expect(
      explainSql(env, { ...req, planId: plan.planId, confirmToken: plan.confirmToken }),
    ).rejects.toThrow(/plan_expired/)
    await pool.query(`UPDATE ${DB}.customer SET name = CONCAT('n', id) WHERE id = 5`)
  })

  test('D1: an aborted request signal cancels the running statement and the explain', async () => {
    const ac = new AbortController()
    const env = mkEnv({ signal: ac.signal })
    const started = Date.now()
    const p = runSqlText(env, input('SELECT SLEEP(30) AS s; SELECT 2'))
    await vi.waitFor(async () => expect(await sleepers()).toBe(1))
    ac.abort()
    const r = asDone(await p)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.results[0]?.status).toBe('failed')
    expect(r.results[1]?.status).toBe('not-run')
    expect(history.at(-1)?.outcome).toBe('cancelled')
    await vi.waitFor(async () => expect(await sleepers()).toBe(0))
    expect(env.registry!.size).toBe(0)

    // A signal that is already aborted ends the run at the first statement.
    const pre = new AbortController()
    pre.abort()
    const r2 = asDone(await runSqlText(mkEnv({ signal: pre.signal }), input('SELECT SLEEP(30)')))
    expect(r2.results[0]?.status).not.toBe('rows')

    const analysing = () =>
      count(
        "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'EXPLAIN ANALYZE SELECT SLEEP%' OR INFO LIKE 'ANALYZE FORMAT%SELECT SLEEP%'",
      )
    // Explain: ANALYZE of a slow SELECT is killed when the request goes away.
    const ac3 = new AbortController()
    const ex = explainSql(mkEnv({ signal: ac3.signal }), {
      db: DB,
      text: 'SELECT SLEEP(30)',
      mode: 'analyse',
      format: 'json',
    }).catch((e: unknown) => e)
    await vi.waitFor(async () => expect(await analysing()).toBe(1))
    ac3.abort()
    await ex
    await vi.waitFor(async () => expect(await analysing()).toBe(0))
  }, 60_000)

  test('estimate of affected rows is within a factor of two and executes nothing', async () => {
    const env = mkEnv()
    const e = await estimateAffected(env, { db: DB, text: "UPDATE customer SET name = 'x'" })
    expect(e.estimatedRows).toBeGreaterThan(500)
    expect(e.estimatedRows).toBeLessThan(2000)
    const d = await estimateAffected(env, { db: DB, text: 'DELETE FROM customer' })
    expect(d.estimatedRows).toBeGreaterThan(500)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
    expect((await estimateAffected(env, { db: DB, text: 'SELECT 1' })).estimatedRows).toBeNull()
    expect(
      (await estimateAffected(env, { db: DB, text: 'DELETE FROM nope_missing' })).estimatedRows,
    ).toBeNull()
    expect(
      (await estimateAffected(env, { db: DB, text: 'DELETE FROM customer; DELETE FROM seq' }))
        .estimatedRows,
    ).toBeNull()
  })

  test('assistant hook: SELECT runs inline with a cap, DROP never runs, writes fail read-only', async () => {
    const env = mkEnv()
    const ok = await runForAssistant(env, {
      db: DB,
      text: 'SELECT id FROM customer',
      conversationId: 'c1',
      maxRows: 100,
    })
    if (ok.needsUser) throw new Error('x')
    const g = rowsOf(ok.result)
    expect(g.rows).toHaveLength(100)
    expect(g.truncated).toEqual({ reason: 'rows', limit: 100 })
    const drop = await runForAssistant(env, {
      db: DB,
      text: 'DROP TABLE customer',
      conversationId: 'c1',
    })
    expect(drop.needsUser).toBe(true)
    const two = await runForAssistant(env, {
      db: DB,
      text: 'SELECT 1; SELECT 2',
      conversationId: 'c1',
    })
    expect(two.needsUser).toBe(true)
    expect(await count(`SELECT COUNT(*) AS n FROM ${DB}.customer`)).toBe(1000)
    const fn = await runForAssistant(env, { db: DB, text: 'SELECT wf()', conversationId: 'c1' })
    if (fn.needsUser) throw new Error('x')
    expect(fn.result.status).toBe('failed')
    expect(history.some((h) => h.source === 'assistant')).toBe(true)
  })

  test('export hook streams a result without the grid caps and refuses writes', async () => {
    const env = mkEnv({}, { rowCap: 10, responseBytes: 1000 })
    const s = await openResultStream(env, {
      db: DB,
      text: 'SELECT n FROM seq; SELECT 2',
      statementIndex: 0,
    })
    expect(s.columns.map((c) => c.name)).toEqual(['n'])
    let n = 0
    for await (const row of s.rows) {
      expect(row).toHaveLength(1)
      n++
    }
    expect(n).toBe(300)
    expect(env.registry!.size).toBe(0)
    await expect(
      openResultStream(env, {
        db: DB,
        text: 'DELETE FROM customer WHERE id = 1',
        statementIndex: 0,
      }),
    ).rejects.toThrow(/not_exportable/)
    await expect(
      openResultStream(env, { db: DB, text: 'SELECT 1', statementIndex: 3 }),
    ).rejects.toThrow(/not_exportable/)
    // closing early ends the run and kills the statement
    const early = await openResultStream(env, {
      db: DB,
      text: 'SELECT n, SLEEP(0.01) FROM seq',
      statementIndex: 0,
    })
    await early.close()
    expect(env.registry!.size).toBe(0)
  })
})
