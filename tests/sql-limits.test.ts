import { describe, expect, test } from 'vitest'
import { resolveSqlLimits } from '~/server/sql/limits'
import { DEFAULT_SQL_LIMITS } from '~/server/sql/types'
import * as fx from '~/server/sql/fixed'
import { mapMysqlError, positionOf } from '~/server/structure/errors'

const cfg = { statementTimeoutMs: 30_000 }

describe('resolveSqlLimits', () => {
  test('defaults, with the timeout from config', () => {
    const l = resolveSqlLimits(cfg, {}, {})
    expect(l).toEqual({ ...DEFAULT_SQL_LIMITS, timeoutMs: 30_000 })
  })

  test('.env bounds lower the defaults', () => {
    const l = resolveSqlLimits(
      cfg,
      {},
      {
        DBLOOM_SQL_ROW_CAP: '500',
        DBLOOM_SQL_RESPONSE_MB: '2',
        DBLOOM_SQL_CELL_KB: '4',
        DBLOOM_SQL_MAX_STATEMENTS: '20',
        DBLOOM_SQL_MAX_CONCURRENT_RUNS: '1',
      },
    )
    expect(l.rowCap).toBe(500)
    expect(l.responseBytes).toBe(2 * 1048576)
    expect(l.cellBytes).toBe(4096)
    expect(l.maxStatements).toBe(20)
    expect(l.maxConcurrentRuns).toBe(1)
  })

  test('a user preference may only lower the bound', () => {
    const env = { DBLOOM_SQL_ROW_CAP: '1000' }
    expect(resolveSqlLimits(cfg, { rowCap: 100 }, env).rowCap).toBe(100)
    expect(resolveSqlLimits(cfg, { rowCap: 5000 }, env).rowCap).toBe(1000)
    expect(resolveSqlLimits(cfg, { timeoutMs: 2000 }, {}).timeoutMs).toBe(2000)
    expect(resolveSqlLimits(cfg, { timeoutMs: 90_000 }, {}).timeoutMs).toBe(30_000)
  })

  test('zero or negative preferences are rejected (ST-110)', () => {
    expect(() => resolveSqlLimits(cfg, { timeoutMs: 0 }, {})).toThrow()
    expect(() => resolveSqlLimits(cfg, { rowCap: -1 }, {})).toThrow()
  })

  test('invalid env values are rejected, the ceiling holds', () => {
    expect(() => resolveSqlLimits(cfg, {}, { DBLOOM_SQL_ROW_CAP: 'abc' })).toThrow()
    expect(() => resolveSqlLimits(cfg, {}, { DBLOOM_SQL_ROW_CAP: '0' })).toThrow()
    expect(() => resolveSqlLimits(cfg, {}, { DBLOOM_SQL_ROW_CAP: '1.5' })).toThrow()
    expect(
      resolveSqlLimits(cfg, {}, { DBLOOM_SQL_MAX_CONCURRENT_RUNS: '99' }).maxConcurrentRuns,
    ).toBe(3)
    expect(resolveSqlLimits(cfg, {}, { DBLOOM_SQL_ROW_CAP: '999999999999' }).rowCap).toBe(
      10_000_000,
    )
  })
})

describe('fixed fragments', () => {
  test('USE quotes the name', () => {
    expect(fx.useDatabase('a`b')).toBe('USE `a``b`')
    expect(() => fx.useDatabase('')).toThrow()
  })
  test('timeout variable per product, one second above the limit', () => {
    expect(fx.setTimeoutVariable('mysql', 2000)).toBe('SET SESSION max_execution_time = 3000')
    expect(fx.setTimeoutVariable('mariadb', 2000)).toBe('SET SESSION max_statement_time = 3.000')
  })
  test('KILL QUERY takes only an integer thread id', () => {
    expect(fx.killQuery(12)).toBe('KILL QUERY 12')
    expect(() => fx.killQuery(Number.NaN)).toThrow()
    expect(() => fx.killQuery(-1)).toThrow()
  })
  test('explain prefixes per product, mode and format', () => {
    expect(fx.explainPrefix('mysql', 'explain', 'json')).toMatchObject({
      prefix: 'EXPLAIN FORMAT=JSON',
      executes: false,
    })
    expect(fx.explainPrefix('mysql', 'explain', 'tree').prefix).toBe('EXPLAIN FORMAT=JSON')
    expect(fx.explainPrefix('mysql', 'analyse', 'json')).toMatchObject({
      prefix: 'EXPLAIN ANALYZE',
      format: 'tree',
      executes: true,
    })
    expect(fx.explainPrefix('mariadb', 'analyse', 'json').prefix).toBe('ANALYZE FORMAT=JSON')
    expect(fx.explainPrefix('mariadb', 'analyse', 'text').prefix).toBe('ANALYZE')
    expect(fx.explainPrefix('mariadb', 'explain', 'text').prefix).toBe('EXPLAIN')
  })
})

describe('error position and hints', () => {
  const msg = (line: number, near: string) =>
    `You have an error in your SQL syntax; check the manual for the right syntax to use near '${near}' at line ${line}`

  test('line 1 of a statement that starts on line 3', () => {
    const text = 'SELECT 1;\n\nSELEC 2'
    const start = text.indexOf('SELEC 2')
    const p = positionOf(msg(1, 'SELEC 2'), start, text)
    expect(p).toMatchObject({ line: 3, column: 1, offset: start })
  })
  test('a later line inside the statement and the column from near', () => {
    const text = 'SELECT 1\nFROM t\nWHERE ) = 1'
    const p = positionOf(msg(3, ') = 1'), 0, text)
    expect(p.line).toBe(3)
    expect(p.column).toBe(7)
  })
  test('no position in the message: first character of the statement', () => {
    const p = positionOf('Table x.y does not exist', 11, 'aaaaaaaaaa SELECT 1')
    expect(p.offset).toBe(11)
  })
  test('hints for the new codes; 1064 names DELIMITER', () => {
    for (const errno of [1235, 1792, 1290, 1969]) {
      expect(mapMysqlError({ errno, code: 'X', sqlMessage: 'm' }).hint).toBeTruthy()
    }
    expect(mapMysqlError({ errno: 1064, code: 'X', sqlMessage: 'm' }).hint).toMatch(/DELIMITER/)
  })
})
