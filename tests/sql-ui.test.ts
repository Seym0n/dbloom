import { describe, expect, test } from 'vitest'
import { matchScore, quoteIfNeeded, tablesInStatement } from '~/components/sql/completion'
import { buildPlan } from '~/components/sql/plan-adapter'
import {
  columnWidths,
  confirmPosition,
  commitsImplicitly,
  expiryMs,
  firstKeywordOf,
  formatDuration,
  locateStatement,
  newRunId,
  nextSort,
  offsetFromMessage,
  offsetOfPosition,
  pickList,
  readOnlyBlocked,
  sortRows,
  splitLocal,
  statementAt,
  toSingleLine,
} from '~/components/sql/helpers'

describe('splitLocal', () => {
  test('splits on semicolons outside quotes and comments', () => {
    const text = "SELECT ';' ; -- a; b\nSELECT /* x; */ 2;\n# c; d\nSELECT `a;b`"
    const { statements } = splitLocal(text)
    expect(statements.map((s) => s.text)).toEqual([
      "SELECT ';'",
      '-- a; b\nSELECT /* x; */ 2',
      '# c; d\nSELECT `a;b`',
    ])
    for (const s of statements) expect(text.slice(s.start, s.end)).toBe(s.text)
  })

  test('keeps executable comments and honours DELIMITER', () => {
    const text =
      'SELECT /*! STRAIGHT_JOIN */ 1;\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END $$\nDELIMITER ;\nSELECT 3'
    const { statements } = splitLocal(text)
    expect(statements).toHaveLength(3)
    expect(statements[1]?.text).toContain('SELECT 1; SELECT 2; END')
    expect(statements[2]?.text).toBe('SELECT 3')
  })

  test('reports an unterminated string', () => {
    expect(splitLocal("SELECT 'abc").unterminated).toEqual({ at: 7 })
    expect(splitLocal('SELECT 1 /* open').unterminated).toEqual({ at: 9 })
    expect(splitLocal('SELECT 1').unterminated).toBeUndefined()
  })

  test('dash dash needs a following blank to be a comment', () => {
    expect(splitLocal('SELECT 1--1; SELECT 2').statements).toHaveLength(2)
    expect(splitLocal('SELECT 1 -- x; y\n; SELECT 2').statements).toHaveLength(2)
  })

  test('first keyword skips comments and parentheses', () => {
    expect(firstKeywordOf('/* c */ -- d\n  select 1')).toBe('SELECT')
    expect(firstKeywordOf('(select 1)')).toBe('SELECT')
    expect(firstKeywordOf('-- only')).toBe('')
  })
})

describe('statementAt', () => {
  const text = 'SELECT 1;\n\nSELECT 2;\nSELECT 3'
  const { statements } = splitLocal(text)
  test('inside, after delimiter and between statements', () => {
    expect(statementAt(statements, 3)?.text).toBe('SELECT 1')
    expect(statementAt(statements, 9)?.text).toBe('SELECT 1')
    expect(statementAt(statements, 10)?.text).toBe('SELECT 1')
    expect(statementAt(statements, 14)?.text).toBe('SELECT 2')
    expect(statementAt(statements, text.length)?.text).toBe('SELECT 3')
  })
  test('empty text has none', () => {
    expect(statementAt([], 0)).toBeUndefined()
  })
})

describe('gates', () => {
  test('read-only gate lets reads through', () => {
    expect(readOnlyBlocked('SELECT 1; SHOW TABLES; DESCRIBE t; EXPLAIN SELECT 1; USE x')).toBe(
      false,
    )
    expect(readOnlyBlocked('SELECT 1; DROP TABLE t')).toBe(true)
    expect(readOnlyBlocked('INSERT INTO t VALUES (1)')).toBe(true)
    expect(readOnlyBlocked('CALL p()')).toBe(true)
    expect(readOnlyBlocked('')).toBe(false)
  })
  test('implicit commit detection', () => {
    expect(commitsImplicitly('INSERT INTO a VALUES (1); ALTER TABLE a ADD b INT')).toBe(true)
    expect(commitsImplicitly('SET autocommit = 1')).toBe(true)
    expect(commitsImplicitly('INSERT INTO a VALUES (1); UPDATE a SET b = 2')).toBe(false)
  })
})

describe('toSingleLine', () => {
  test('turns line comments into block comments and joins lines', () => {
    expect(toSingleLine('SELECT 1 -- one\nFROM t\n  WHERE a = 1')).toBe(
      'SELECT 1 /* one */ FROM t WHERE a = 1',
    )
  })
  test('keeps string contents and executable comments', () => {
    expect(toSingleLine("SELECT 'a  b\nc' ,\n  /*! 1 */ 2")).toBe("SELECT 'a  b\nc' , /*! 1 */ 2")
  })
  test('leaves broken text unchanged', () => {
    expect(toSingleLine("SELECT 'x\n  y")).toBe("SELECT 'x\n  y")
  })
  test('a comment containing a block terminator stays closed', () => {
    expect(toSingleLine('SELECT 1 -- a */ b\n, 2')).toBe('SELECT 1 /* a * / b */ , 2')
  })
})

describe('positions', () => {
  test('offsetOfPosition is absolute and clamped', () => {
    const stmt = 'SELEC 1\nFROM t'
    expect(offsetOfPosition(stmt, 20, { line: 1, column: 1 })).toBe(20)
    expect(offsetOfPosition(stmt, 20, { line: 2, column: 3 })).toBe(20 + 8 + 2)
    expect(offsetOfPosition(stmt, 20, { line: 9, column: 99 })).toBe(20 + 8 + 6)
  })
  test('locateStatement by index, then by text', () => {
    const text = 'SELECT 1;\nINSERT INTO nope VALUES (1);\nSELECT 3'
    const w = locateStatement(text, undefined, 1, 'INSERT INTO nope VALUES (1)')
    expect(text.slice(w?.from, w?.to)).toBe('INSERT INTO nope VALUES (1)')
    const sel = locateStatement(
      text,
      { from: 10, to: text.length },
      0,
      'INSERT INTO nope VALUES (1)',
    )
    expect(sel?.from).toBe(10)
  })
  test('offset from a refusal message', () => {
    expect(offsetFromMessage('A string is not closed at 14')).toBe(14)
    expect(offsetFromMessage('position: 3')).toBe(3)
    expect(offsetFromMessage('nothing here')).toBeUndefined()
  })
})

describe('grid helpers', () => {
  const rows = [
    ['b', '10'],
    ['a', '9'],
    [null, '100'],
    ['c', null],
  ] as (string | null)[][]
  test('sorting is local, numeric aware, NULL last', () => {
    expect(sortRows(rows, { column: 1, direction: 'asc' }).map((r) => r[1])).toEqual([
      '9',
      '10',
      '100',
      null,
    ])
    expect(sortRows(rows, { column: 0, direction: 'desc' }).map((r) => r[0])).toEqual([
      'c',
      'b',
      'a',
      null,
    ])
    expect(sortRows(rows, undefined)).toBe(rows)
    expect(rows[0]?.[0]).toBe('b')
  })
  test('sort cycle', () => {
    const a = nextSort(undefined, 2)
    const b = nextSort(a, 2)
    expect(a).toEqual({ column: 2, direction: 'asc' })
    expect(b).toEqual({ column: 2, direction: 'desc' })
    expect(nextSort(b, 2)).toBeUndefined()
    expect(nextSort(b, 1)).toEqual({ column: 1, direction: 'asc' })
  })
  test('column widths are clamped', () => {
    const w = columnWidths(['id', 'x'], [['1', 'y'.repeat(500)]])
    expect(w[0]).toBe(96)
    expect(w[1]).toBe(360)
  })
})

describe('misc', () => {
  test('run ids fit the server schema', () => {
    const id = newRunId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(newRunId()).not.toBe(id)
  })
  test('expiry in seconds or milliseconds', () => {
    expect(expiryMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(expiryMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
  test('pickList accepts arrays and objects', () => {
    expect(pickList<number>([1], 'x')).toEqual([1])
    expect(pickList<number>({ x: [2] }, 'x')).toEqual([2])
    expect(pickList<number>(undefined, 'x')).toEqual([])
  })
  test('durations', () => {
    expect(formatDuration(12)).toBe('12 ms')
    expect(formatDuration(2500)).toBe('2.50 s')
    expect(formatDuration(125_000)).toBe('2 min 5 s')
  })
})

describe('completion helpers', () => {
  test('matching: prefix before substring before subsequence', () => {
    const prefix = matchScore('cus', 'customer') as number
    const sub = matchScore('mer', 'customer') as number
    const seq = matchScore('cstr', 'customer') as number
    expect(prefix).toBeLessThan(sub)
    expect(sub).toBeLessThan(seq)
    expect(matchScore('pmu', 'prefix_modulename_users')).toBeDefined()
    expect(matchScore('zzz', 'customer')).toBeUndefined()
  })
  test('quoting only when needed', () => {
    expect(quoteIfNeeded('customer')).toBe('customer')
    expect(quoteIfNeeded('my table')).toBe('`my table`')
    expect(quoteIfNeeded('a`b')).toBe('`a``b`')
  })
  test('tables and aliases of a statement', () => {
    expect(tablesInStatement('SELECT * FROM shop.customer c JOIN `order` o ON 1 WHERE 1')).toEqual([
      { db: 'shop', table: 'customer', alias: 'c' },
      { table: 'order', alias: 'o' },
    ])
  })
})

describe('plan adapter', () => {
  test('builds a tree from MySQL JSON', () => {
    const raw = JSON.stringify({
      query_block: {
        select_id: 1,
        nested_loop: [
          { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 10 } },
          { table: { table_name: 'b', access_type: 'ref', key: 'k' } },
        ],
      },
    })
    const tree = buildPlan(raw)
    expect(tree).toHaveLength(1)
    expect(JSON.stringify(tree)).toContain('"a"')
    expect(JSON.stringify(tree)).toContain('rows 10')
  })
  test('builds a tree from EXPLAIN ANALYZE text', () => {
    const raw =
      '-> Filter: (a = 1)  (cost=1.2 rows=3) (actual time=0.1..0.2 rows=3 loops=1)\n    -> Table scan on t  (cost=1 rows=3)\n'
    const tree = buildPlan(raw)
    expect(JSON.stringify(tree)).toContain('Table scan')
  })
  test('unknown shapes give no tree', () => {
    expect(buildPlan('garbage')).toEqual([])
    expect(buildPlan('{not json')).toEqual([])
  })
})

describe('confirmPosition (D2)', () => {
  test('counts the whole batch, not only the statements that need confirmation', () => {
    // SELECT 1; DROP TABLE x: one statement to confirm, at position 2 of 2
    expect(confirmPosition(1, 1, 2)).toEqual({ n: 2, total: 2 })
    expect(confirmPosition(0, 2, 5)).toEqual({ n: 1, total: 5 })
  })
  test('falls back to the shown list and never shows n above total', () => {
    expect(confirmPosition(0, 1)).toEqual({ n: 1, total: 1 })
    expect(confirmPosition(3, 1, 2)).toEqual({ n: 4, total: 4 })
  })
  test('the foreign-key switch (index -1) has no position', () => {
    expect(confirmPosition(-1, 2, 3)).toBeNull()
  })
})
