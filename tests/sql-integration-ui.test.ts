import { describe, expect, test, vi } from 'vitest'
import { describeRefusal } from '~/components/structure/refusal'
import { refreshAfterSql } from '~/components/sql/helpers'
import { groupByIndex } from '~/components/sql/result-panels'
import { describeSqlError } from '~/components/sql/errors'
import type { SqlStatementResult } from '~/server/sql/types'
import { StructureRefusal, relativePosition, toClientError } from '~/server/structure/errors'

describe('result groups (CALL gives several entries per statement)', () => {
  const ok = (index: number): SqlStatementResult => ({
    status: 'ok',
    index,
    sql: 'x',
    affectedRows: 0,
    warnings: [],
    durationMs: 1,
  })
  test('adjacent results with the same index form one group', () => {
    const groups = groupByIndex([ok(0), ok(1), ok(1), ok(1), ok(2)])
    expect(groups.map((g) => g.length)).toEqual([1, 3, 1])
    expect(groups.map((g) => g[0]!.index)).toEqual([0, 1, 2])
  })
})

describe('refreshAfterSql', () => {
  const keysOf = (response: Parameters<typeof refreshAfterSql>[1]) => {
    const calls: unknown[][] = []
    const client = {
      invalidateQueries: vi.fn((o: { queryKey: unknown[] }) => {
        calls.push([...o.queryKey])
        return Promise.resolve()
      }),
    }
    refreshAfterSql(client as never, response)
    return calls
  }
  test('does nothing for a run without structure changes', () => {
    expect(keysOf({})).toEqual([])
  })
  test('table DDL refreshes databases, the table list and the rows of the table', () => {
    const k = keysOf({ changed: [{ db: 'shop', table: 'orders' }] })
    expect(k).toContainEqual(['databases'])
    expect(k).toContainEqual(['tables', 'shop'])
    expect(k).toContainEqual(['rows', 'shop', 'orders'])
  })
  test('database DDL refreshes the lists of that database', () => {
    const k = keysOf({ changed: [{ db: 'shop', database: true }] })
    expect(k).toContainEqual(['databases'])
    expect(k).toContainEqual(['tables', 'shop'])
  })
  test('a change without a database, or a USE, refreshes all table lists', () => {
    expect(keysOf({ changed: [{ table: 't' }] })).toContainEqual(['tables'])
    expect(keysOf({ db: 'other', changed: [{ db: 'a', table: 't' }] })).toContainEqual(['tables'])
  })
})

describe('error position and offset', () => {
  test('a lexical refusal carries a structured offset that the UI reads', () => {
    const e = toClientError(new StructureRefusal('unterminated-string', 'Unterminated string', 14))
    expect(e.message).toBe('unterminated-string@14: Unterminated string')
    expect(describeRefusal(e)).toMatchObject({ code: 'unterminated-string', at: 14 })
    expect(describeSqlError(e)).toMatchObject({ code: 'unterminated-string', at: 14 })
    expect(describeRefusal(new Error('read-only: no')).at).toBeUndefined()
  })
  test('relativePosition is 1-based and relative to the statement', () => {
    const text = 'SELECT 1;\n\nSELECT 1\n  FROM t\n  WHERE'
    const start = text.indexOf('SELECT 1\n')
    expect(relativePosition(text, start, start)).toEqual({ line: 1, column: 1 })
    expect(relativePosition(text, start, text.indexOf('FROM'))).toEqual({ line: 2, column: 3 })
    expect(relativePosition(text, start, text.indexOf('WHERE'))).toEqual({ line: 3, column: 3 })
  })
})
