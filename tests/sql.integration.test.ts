import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConnection, type Connection } from 'mysql2/promise'
import type { Config } from '~/server/config'
import { openTargetPool, type TargetPool } from '~/server/db/target-pool'
import { createTokenIssuer } from '~/server/structure/deps'
import { PlanStore } from '~/server/structure/plans'
import { MemorySqlState } from '~/server/sql/state'
import {
  assertSqlEnabled,
  cancelSqlImpl,
  explainSqlImpl,
  getSqlLimitsImpl,
  parsePlanAnalyseInput,
  planAnalyseImpl,
  confirmSqlImpl,
  deleteBookmarkImpl,
  deleteHistoryImpl,
  getCompletionSchemaImpl,
  historySink,
  listBookmarksImpl,
  listHistoryImpl,
  parseCompletionInput,
  parseConfirmInput,
  parseDeleteHistoryInput,
  parseRunInput,
  renameBookmarkImpl,
  runSqlImpl,
  saveBookmarkImpl,
  type SqlEnv,
} from '~/server/sql/service'
import { DEFAULT_SQL_LIMITS } from '~/server/sql/types'

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
] as const
const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const DB = 'sqltab_c_scratch'
const HOSTILE_DB = 'sqltab_c_we`ird"; DROP TABLE x; -- ü'
const HOSTILE_TABLE = 't`1\'"; --'
const HOSTILE_COLUMN = 'c`1\'"%_ü'

const runId = (n: string) => `run-${n}-${Math.random().toString(36).slice(2, 10)}`

test('requests with unknown keys are rejected (FR-SQL-001)', () => {
  const ok = { runId: 'abcdefgh', tabId: 't', text: 'SELECT 1' }
  expect(parseRunInput(ok).text).toBe('SELECT 1')
  expect(() => parseRunInput({ ...ok, statements: ['SELECT 1'] })).toThrow()
  expect(() => parseRunInput({ ...ok, class: 'none' })).toThrow()
  expect(() => parseRunInput({ ...ok, options: { continueOnError: true, extra: 1 } })).toThrow()
  expect(() => parseConfirmInput({ runId: 'abcdefgh', planId: 'abcdefgh', sql: 'DROP' })).toThrow()
  expect(() => parseCompletionInput({ db: 'x', sql: 'y' })).toThrow()
  expect(() => parseDeleteHistoryInput({ ids: [1], all: true })).toThrow()
  expect(parseDeleteHistoryInput({ all: true })).toEqual({ all: true })
})

describe.each(servers)('sql-tab server functions on $name', ({ port }) => {
  let admin: Connection
  let pool: TargetPool
  const tokens = createTokenIssuer()
  const plans = new PlanStore()
  const state = new MemorySqlState()
  const target = { host: '127.0.0.1', port, username: 'root' }

  const env = (sessionId = 'session-a', over: Partial<SqlEnv> = {}): SqlEnv => {
    const e: SqlEnv = {
      session: { idHash: sessionId, target, pool, readOnly: false },
      guard: { forcedReadOnly: false, sessionReadOnly: false },
      tokens,
      limits: { ...DEFAULT_SQL_LIMITS },
      plans,
      state,
      ownerKey: `owner-${sessionId}`,
      ...over,
    }
    e.recordHistory = historySink(e)
    return e
  }

  beforeAll(async () => {
    admin = await createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`CREATE DATABASE \`${DB}\``)
    await admin.query(`CREATE TABLE \`${DB}\`.t (id INT PRIMARY KEY, name VARCHAR(20))`)
    await admin.query(`INSERT INTO \`${DB}\`.t VALUES (1,'a'),(2,'b')`)
    const hostileDb = HOSTILE_DB.replace(/`/g, '``')
    await admin.query(`DROP DATABASE IF EXISTS \`${hostileDb}\``)
    await admin.query(`CREATE DATABASE \`${hostileDb}\``)
    await admin.query(
      `CREATE TABLE \`${hostileDb}\`.\`${HOSTILE_TABLE.replace(/`/g, '``')}\` (\`${HOSTILE_COLUMN.replace(/`/g, '``')}\` INT)`,
    )
    await admin.query(`CREATE VIEW \`${hostileDb}\`.\`v1\` AS SELECT 1 AS a`)
    pool = await openTargetPool({ ...target }, '127.0.0.1', 'root', config)
  })

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`DROP DATABASE IF EXISTS \`${HOSTILE_DB.replace(/`/g, '``')}\``)
    await admin.end()
    await pool.end()
  })

  describe('history and bookmarks through the sink and the service', () => {
    test('the sink stores a redacted entry; tokens and plan ids are not part of it', async () => {
      const e = env('hist-1')
      const fakeRunner: SqlEnv['runner'] = async (en, input) => {
        en.recordHistory?.({
          text: input.text,
          db: input.db ?? null,
          statements: 1,
          executed: 1,
          failedIndex: null,
          maxClass: 'hard',
          outcome: 'ok',
          durationMs: 5,
        })
        return { kind: 'done', runId: input.runId, ok: true, results: [], notes: [] }
      }
      e.runner = fakeRunner
      await runSqlImpl(
        e,
        parseRunInput({
          runId: runId('h'),
          tabId: 't1',
          db: DB,
          text: "CREATE USER 'u1'@'%' IDENTIFIED BY 'hunter2-secret'",
        }),
      )
      const list = await listHistoryImpl(e, { limit: 50 })
      expect(list.entries).toHaveLength(1)
      const h = list.entries[0]!
      expect(h).toMatchObject({ source: 'user', db: DB, outcome: 'ok', maxClass: 'hard' })
      expect(h.targetKey).toBe(`127.0.0.1:${port}`)
      expect(h.sql).not.toContain('hunter2-secret')
      expect(JSON.stringify(h)).not.toMatch(/confirmToken|planId/)
      // another owner sees nothing
      expect((await listHistoryImpl(env('hist-2'), { limit: 50 })).entries).toEqual([])
      expect(await deleteHistoryImpl(env('hist-2'), { ids: [h.id] })).toEqual({ deleted: 0 })
      expect(await deleteHistoryImpl(e, { ids: [h.id] })).toEqual({ deleted: 1 })
    })

    test('a failing history store never fails the run', async () => {
      const broken = {
        addHistory: () => {
          throw new Error('disk full')
        },
      } as unknown as SqlEnv['state']
      const e = env('hist-3', { state: broken })
      e.runner = async (en, input) => {
        en.recordHistory?.({
          text: input.text,
          db: null,
          statements: 1,
          executed: 1,
          failedIndex: null,
          maxClass: 'none',
          outcome: 'ok',
          durationMs: 1,
        })
        return { kind: 'done', runId: input.runId, ok: true, results: [], notes: [] }
      }
      await expect(
        runSqlImpl(e, parseRunInput({ runId: runId('b'), tabId: 't', text: 'SELECT 1' })),
      ).resolves.toMatchObject({ kind: 'done' })
    })

    test('bookmarks: save, list, rename, duplicate, delete, isolation', async () => {
      const e = env('bm-1')
      const b = await saveBookmarkImpl(e, { name: 'q', sql: "SELECT 'x'", db: DB })
      expect(b.targetKey).toBe(`127.0.0.1:${port}`)
      await expect(saveBookmarkImpl(e, { name: 'q', sql: 'SELECT 2' })).rejects.toThrow(
        /^bookmark_exists:/,
      )
      expect((await listBookmarksImpl(e)).bookmarks).toHaveLength(1)
      expect((await listBookmarksImpl(env('bm-2'))).bookmarks.length).toBe(0)
      await expect(renameBookmarkImpl(env('bm-2'), { id: b.id, name: 'z' })).rejects.toThrow(
        /^not_found:/,
      )
      await expect(deleteBookmarkImpl(env('bm-2'), { id: b.id })).rejects.toThrow(/^not_found:/)
      expect((await renameBookmarkImpl(e, { id: b.id, name: 'z' })).name).toBe('z')
      expect(await deleteBookmarkImpl(e, { id: b.id })).toEqual({ ok: true })
    })

    test('a bookmark with a password literal is stored redacted', async () => {
      const e = env('bm-3')
      const b = await saveBookmarkImpl(e, {
        name: 'pw',
        sql: "ALTER USER 'a'@'%' IDENTIFIED BY 'topsecret'",
      })
      expect(b.sql).not.toContain('topsecret')
    })
  })

  describe('completion schema', () => {
    test('databases, lazy tables and columns; system schemas readable', async () => {
      const e = env()
      const top = await getCompletionSchemaImpl(e, {})
      expect(top.databases).toEqual(expect.arrayContaining([DB, 'information_schema', 'mysql']))
      expect(top.tables).toEqual([])
      expect(top.columns).toBeUndefined()
      const tabs = await getCompletionSchemaImpl(e, { db: DB })
      expect(tabs.tables).toEqual([{ name: 't', kind: 'table' }])
      const cols = await getCompletionSchemaImpl(e, { db: DB, table: 't' })
      expect(cols.columns?.map((c) => c.name)).toEqual(['id', 'name'])
      const sys = await getCompletionSchemaImpl(e, { db: 'information_schema' })
      expect(sys.tables.length).toBeGreaterThan(5)
    })

    test('hostile names are data; unknown names are refused', async () => {
      const e = env()
      const top = await getCompletionSchemaImpl(e, {})
      expect(top.databases).toContain(HOSTILE_DB)
      const tabs = await getCompletionSchemaImpl(e, { db: HOSTILE_DB })
      expect(tabs.tables).toEqual(
        expect.arrayContaining([
          { name: HOSTILE_TABLE, kind: 'table' },
          { name: 'v1', kind: 'view' },
        ]),
      )
      const cols = await getCompletionSchemaImpl(e, { db: HOSTILE_DB, table: HOSTILE_TABLE })
      expect(cols.columns?.map((c) => c.name)).toEqual([HOSTILE_COLUMN])
      await expect(getCompletionSchemaImpl(e, { db: `${DB}' OR '1'='1` })).rejects.toThrow(
        /^not_found:/,
      )
      await expect(getCompletionSchemaImpl(e, { db: DB, table: 'nope' })).rejects.toThrow(
        /^not_found:/,
      )
      await expect(getCompletionSchemaImpl(e, { db: DB, table: "t' OR '1'='1" })).rejects.toThrow(
        /^not_found:/,
      )
    })
  })

  // These need package B's runner.
  describe('runner flow', () => {
    const mkRun = (text: string, id = runId('r')) =>
      parseRunInput({ runId: id, tabId: 't', db: DB, text })

    test('a run writes one history entry without tokens', async () => {
      const e = env('real-1')
      const res = await runSqlImpl(e, mkRun('SELECT id FROM t ORDER BY id'))
      expect(res.kind).toBe('done')
      const list = await listHistoryImpl(e, { limit: 10 })
      expect(list.entries).toHaveLength(1)
      expect(list.entries[0]).toMatchObject({ outcome: 'ok', statements: 1, maxClass: 'none' })
      expect(JSON.stringify(list)).not.toMatch(/confirmToken/)
    })

    test('forged, replayed and foreign confirm tokens are refused; the statement runs once', async () => {
      const e = env('real-2')
      const id = runId('c')
      const first = await runSqlImpl(e, mkRun('DELETE FROM t', id))
      expect(first.kind).toBe('confirm')
      if (first.kind !== 'confirm') return
      const rows = async () =>
        ((await admin.query(`SELECT COUNT(*) AS n FROM \`${DB}\`.t`))[0] as { n: number }[])[0]!.n
      expect(await rows()).toBe(2)
      const call = (en: SqlEnv, token?: string) =>
        confirmSqlImpl(
          en,
          parseConfirmInput({
            runId: id,
            planId: first.planId,
            ...(token ? { confirmToken: token } : {}),
          }),
        )
      await expect(call(e)).rejects.toThrow()
      await expect(call(e, 'forged.token')).rejects.toThrow()
      await expect(call(env('real-3'), first.confirmToken)).rejects.toThrow()
      expect(await rows()).toBe(2)
      await expect(call(e, first.confirmToken)).resolves.toMatchObject({ kind: 'done' })
      expect(await rows()).toBe(0)
      await expect(call(e, first.confirmToken)).rejects.toThrow()
      await admin.query(`INSERT INTO \`${DB}\`.t VALUES (1,'a'),(2,'b')`)
    })

    test('list responses and limits say whether the data lasts for the session only', async () => {
      const e = env('stateless-1')
      expect((await listHistoryImpl(e, { limit: 5 })).stateless).toBe(false)
      expect((await listBookmarksImpl(e)).stateless).toBe(false)
      expect(getSqlLimitsImpl(e).stateless).toBe(false)
      process.env.DBLOOM_STORE = 'none'
      try {
        expect((await listHistoryImpl(e, { limit: 5 })).stateless).toBe(true)
        expect((await listBookmarksImpl(e)).stateless).toBe(true)
        expect(getSqlLimitsImpl(e)).toMatchObject({ stateless: true, rowCap: 10_000 })
      } finally {
        delete process.env.DBLOOM_STORE
      }
    })

    test('analyse of a data-changing statement: plan first, then explain with the token', async () => {
      const e = env('analyse-1')
      const text = `UPDATE t SET name = 'a' WHERE id = 1`
      const plan = await planAnalyseImpl(e, parsePlanAnalyseInput({ db: DB, text }))
      expect(plan).toMatchObject({ kind: 'confirm', maxClass: 'hard', confirmRequired: true })
      expect(plan.statements[0]!.fullSql).toBe(text)
      await expect(
        explainSqlImpl(e, { db: DB, text, mode: 'analyse', format: 'text' }),
      ).rejects.toThrow(/^confirm_required:/)
      const res = await explainSqlImpl(e, {
        db: DB,
        text,
        mode: 'analyse',
        format: 'text',
        planId: plan.planId,
        confirmToken: plan.confirmToken!,
      })
      expect(res.mode).toBe('analyse')
      await expect(planAnalyseImpl(e, { db: DB, text: 'SELECT id FROM t' })).rejects.toThrow(
        /^no_confirmation_needed:/,
      )
      expect(() => parsePlanAnalyseInput({ db: DB, text, mode: 'analyse' })).toThrow()
    })

    test('an unterminated string is refused with a structured offset', async () => {
      await expect(runSqlImpl(env('lex-1'), mkRun("SELECT 'abc"))).rejects.toThrow(
        /^unterminated-string@7: /,
      )
    })

    test('DBLOOM_SQL_DISABLED refuses every function with sql_disabled (FR-SQL-028)', () => {
      expect(() => assertSqlEnabled({})).not.toThrow()
      expect(() => assertSqlEnabled({ DBLOOM_SQL_DISABLED: 'false' })).not.toThrow()
      expect(() => assertSqlEnabled({ DBLOOM_SQL_DISABLED: 'true' })).toThrow(/^sql_disabled:/)
      expect(() => assertSqlEnabled({ DBLOOM_SQL_DISABLED: ' TRUE ' })).toThrow(/^sql_disabled:/)
    })

    test('cancel of an unknown run gives the neutral answer', async () => {
      await expect(cancelSqlImpl(env(), { runId: runId('x') })).resolves.toEqual({ ok: true })
    })
  })
})
