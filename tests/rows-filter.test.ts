import { describe, expect, it } from 'vitest'
import {
  OPERATORS_BY_KIND,
  isEmptyFilter,
  operatorAllowed,
  operatorArity,
} from '../src/lib/rows/filter-tree'
import { combineAnd, compileFilter, compileSearch } from '../src/server/rows/filter'
import { RowValueError } from '../src/server/rows/codecs'
import {
  FILTER_OPERATORS,
  filterNode,
  type FilterCondition,
  type FilterNode,
  type FilterOperator,
  type TypeKind,
} from '../src/server/rows/types'
import { ALL_KINDS, col, tbl } from './rows-a-helpers'

const cond = (
  column: string,
  op: FilterOperator,
  values: string[] = [],
  extra: Partial<FilterCondition> = {},
): FilterCondition => ({ type: 'condition', column, op, values, ...extra })

const SAMPLES: Record<TypeKind, [string, string]> = {
  int: ['1', '2'],
  decimal: ['1.5', '2.5'],
  float: ['1.5', '2.5'],
  year: ['2024', '2025'],
  bit: ['5', '6'],
  date: ['2024-01-01', '2024-01-02'],
  time: ['01:02:03', '01:02:04'],
  datetime: ['2024-01-01 00:00:00', '2024-01-02 00:00:00'],
  timestamp: ['2024-01-01 00:00:00', '2024-01-02 00:00:00'],
  char: ['a', 'b'],
  text: ['a', 'b'],
  enum: ['a', 'b'],
  set: ['a', 'b'],
  binary: ['0x0102', '0x0304'],
  blob: ['0x0102', '0x0304'],
  json: ['a', 'b'],
  geometry: ['POINT(1 1)', 'POINT(2 2)'],
  uuid: ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001'],
  inet6: ['::1', '::2'],
  unknown: ['1', '2'],
}

function tableFor(kind: TypeKind) {
  return tbl([
    col('c', kind, {
      precision: 10,
      scale: 2,
      length: 8,
      members: ['a', 'b'],
      nullable: true,
    }),
  ])
}

function valuesFor(kind: TypeKind, op: FilterOperator): string[] {
  const [a, b] = SAMPLES[kind]
  switch (operatorArity(op)) {
    case 'none':
      return []
    case 'one':
      return [a]
    default:
      return [a, b]
  }
}

describe('operator allow-list matrix (FR-ROW-008)', () => {
  for (const kind of ALL_KINDS) {
    it(`${kind}: exactly the listed operators compile, every other one is refused`, () => {
      const t = tableFor(kind)
      for (const op of FILTER_OPERATORS) {
        const run = () => compileFilter(t, cond('c', op, valuesFor(kind, op)))
        if (OPERATORS_BY_KIND[kind].includes(op)) {
          const out = run()
          expect(out, `${kind} ${op}`).not.toBeNull()
          expect(out!.sql).toContain('`c`')
          // every value is a parameter: the count of ? matches the params
          expect(out!.sql.match(/\?/g)?.length ?? 0).toBe(out!.params.length)
        } else {
          expect(run, `${kind} ${op}`).toThrow(RowValueError)
          try {
            run()
          } catch (e) {
            expect((e as RowValueError).code).toBe('operator-not-allowed')
          }
        }
      }
    })
  }

  it('the table itself is as the spec lists it (reviewable in one place)', () => {
    expect(OPERATORS_BY_KIND.json).toEqual(['text contains', 'is null', 'is not null'])
    expect(OPERATORS_BY_KIND.geometry).toEqual(['is null', 'is not null'])
    expect(OPERATORS_BY_KIND.unknown).toEqual(['is null', 'is not null'])
    expect(OPERATORS_BY_KIND.set).toEqual(['has', 'has not', 'is null', 'is not null'])
    expect(operatorAllowed('binary', 'starts with hex')).toBe(true)
    expect(operatorAllowed('int', 'contains')).toBe(false)
    expect(operatorAllowed('char', 'regexp')).toBe(true)
    expect(operatorAllowed('date', 'in')).toBe(false)
    for (const kind of ALL_KINDS) {
      for (const op of OPERATORS_BY_KIND[kind]) expect(FILTER_OPERATORS).toContain(op)
    }
  })

  it('arity: unary operators take no value, between two, in a list', () => {
    const t = tableFor('int')
    expect(() => compileFilter(t, cond('c', 'is null', ['1']))).toThrow(RowValueError)
    expect(() => compileFilter(t, cond('c', '=', []))).toThrow(RowValueError)
    expect(() => compileFilter(t, cond('c', '=', ['1', '2']))).toThrow(RowValueError)
    expect(() => compileFilter(t, cond('c', 'between', ['1']))).toThrow(RowValueError)
    expect(() => compileFilter(t, cond('c', 'in', []))).toThrow(RowValueError)
  })
})

describe('compile output', () => {
  const t = tbl([
    col('n', 'int', { nullable: true }),
    col('s', 'char', { nullable: true }),
    col('b', 'binary', { nullable: true, length: 4 }),
    col('f', 'set', { members: ['x', 'y'] }),
    col('bits', 'bit', { length: 8 }),
    col('j', 'json'),
    col('d', 'decimal', { precision: 10, scale: 2 }),
  ])
  const sql = (n: FilterNode) => compileFilter(t, n)

  it('numbers, between, in, not between', () => {
    expect(sql(cond('n', '>=', ['5']))).toEqual({ sql: '`n` >= ?', params: ['5'] })
    expect(sql(cond('n', '!=', ['5']))).toEqual({ sql: '`n` <> ?', params: ['5'] })
    expect(sql(cond('n', 'between', ['1', '9']))).toEqual({
      sql: '`n` BETWEEN ? AND ?',
      params: ['1', '9'],
    })
    expect(sql(cond('n', 'not between', ['1', '9']))!.sql).toBe('`n` NOT BETWEEN ? AND ?')
    expect(sql(cond('n', 'in', ['1', '2', '0x10']))).toEqual({
      sql: '`n` IN (?, ?, ?)',
      params: ['1', '2', '16'],
    })
    expect(sql(cond('d', '=', ['1.50']))!.params).toEqual(['1.50'])
    expect(sql(cond('bits', '=', ['0b101']))).toEqual({ sql: '(`bits` + 0) = ?', params: ['5'] })
  })

  it('text: LIKE patterns are escaped, user patterns are not', () => {
    expect(sql(cond('s', 'contains', ['50%_!']))).toEqual({
      sql: "`s` LIKE ? ESCAPE '!'",
      params: ['%50!%!_!!%'],
    })
    expect(sql(cond('s', 'starts with', ['a%']))!.params).toEqual(['a!%%'])
    expect(sql(cond('s', 'ends with', ['_a']))!.params).toEqual(['%!_a'])
    expect(sql(cond('s', 'not contains', ['x']))!.sql).toBe("`s` NOT LIKE ? ESCAPE '!'")
    expect(sql(cond('s', 'like', ['a_b%']))).toEqual({ sql: '`s` LIKE ?', params: ['a_b%'] })
    expect(sql(cond('s', 'regexp', ['^a']))).toEqual({ sql: '`s` REGEXP ?', params: ['^a'] })
    expect(sql(cond('s', 'empty'))!.sql).toBe('CHAR_LENGTH(`s`) = 0')
    expect(sql(cond('s', 'not empty'))!.sql).toBe('CHAR_LENGTH(`s`) <> 0')
  })

  it('match case compares bytes', () => {
    expect(sql(cond('s', 'contains', ['A'], { matchCase: true }))).toEqual({
      sql: "CAST(`s` AS BINARY) LIKE CAST(? AS BINARY) ESCAPE '!'",
      params: ['%A%'],
    })
    expect(sql(cond('s', '=', ['A'], { matchCase: true }))!.sql).toBe(
      'CAST(`s` AS BINARY) = CAST(? AS BINARY)',
    )
    expect(sql(cond('s', 'regexp', ['A'], { matchCase: true }))!.sql).toBe(
      '`s` COLLATE utf8mb4_bin REGEXP ?',
    )
    expect(() => sql(cond('n', '=', ['1'], { matchCase: true }))).toThrow(RowValueError)
  })

  it('binary, set and JSON', () => {
    expect(sql(cond('b', '=', ['0x7F000001']))).toEqual({
      sql: '`b` = ?',
      params: [Buffer.from([0x7f, 0, 0, 1])],
    })
    expect(sql(cond('b', 'starts with hex', ['0x7F']))).toEqual({
      sql: 'LEFT(`b`, 1) = ?',
      params: [Buffer.from([0x7f])],
    })
    expect(() => sql(cond('b', '=', ['plain']))).toThrow(RowValueError)
    expect(sql(cond('f', 'has', ['x']))).toEqual({ sql: 'FIND_IN_SET(?, `f`) > 0', params: ['x'] })
    expect(sql(cond('f', 'has not', ['y']))!.sql).toBe('FIND_IN_SET(?, `f`) = 0')
    expect(() => sql(cond('f', 'has', ['z']))).toThrow(RowValueError)
    expect(sql(cond('j', 'text contains', ['a_b']))).toEqual({
      sql: "CAST(`j` AS CHAR) LIKE ? ESCAPE '!'",
      params: ['%a!_b%'],
    })
  })

  it('groups: parenthesised AND/OR, NOT, empty parts vanish', () => {
    const tree: FilterNode = {
      type: 'group',
      op: 'or',
      children: [
        {
          type: 'group',
          op: 'and',
          negate: true,
          children: [cond('n', '=', ['1']), cond('s', 'is null')],
        },
        { type: 'group', op: 'and', children: [] },
        cond('n', '<', ['0']),
      ],
    }
    expect(sql(tree)).toEqual({
      sql: '(NOT (`n` = ? AND `s` IS NULL) OR `n` < ?)',
      params: ['1', '0'],
    })
    expect(sql({ type: 'group', op: 'and', children: [] })).toBeNull()
    expect(
      isEmptyFilter({
        type: 'group',
        op: 'and',
        children: [{ type: 'group', op: 'or', children: [] }],
      }),
    ).toBe(true)
    expect(combineAnd(null, { sql: 'a', params: [] }, undefined)).toEqual({ sql: 'a', params: [] })
    expect(combineAnd(null)).toBeNull()
  })

  it('limits: depth, condition count and duplicate IN values', () => {
    let deep: FilterNode = cond('n', '=', ['1'])
    for (let i = 0; i < 5; i++) deep = { type: 'group', op: 'and', children: [deep] }
    expect(() => sql(deep)).toThrow(RowValueError)
    const many: FilterNode = {
      type: 'group',
      op: 'or',
      children: Array.from({ length: 51 }, () => cond('n', '=', ['1'])),
    }
    expect(() => sql(many)).toThrow(RowValueError)
    expect(() => sql(cond('n', 'in', ['1', '1']))).toThrow(RowValueError)
  })

  it('unknown columns are rejected before any SQL exists', () => {
    for (const name of ['nope', 'N', 'n`', 'n; DROP TABLE t', '`n`', 'n OR 1=1', '']) {
      try {
        sql(cond(name, '=', ['1']))
        throw new Error('compiled')
      } catch (e) {
        expect(e).toBeInstanceOf(RowValueError)
        expect((e as RowValueError).code).toBe('unknown-column')
      }
    }
  })
})

describe('injection corpus', () => {
  const t = tbl([col('s', 'char', { nullable: true }), col('n', 'int', { nullable: true })])
  const corpus = [
    "'",
    "' OR '1'='1",
    "'; DROP TABLE customer; --",
    '" OR ""="',
    '\\',
    "\\' OR 1=1 -- ",
    '`',
    '/* x */',
    '-- x',
    '#',
    ';',
    '‘ OR 1=1 --',
    'ʼ',
    '%',
    '_',
    '\u0000',
    '1; SELECT SLEEP(10)',
    'UNION SELECT password FROM mysql.user',
    '${jndi:ldap://x}',
    '😀',
  ]
  const ops: FilterOperator[] = [
    'contains',
    'starts with',
    'ends with',
    'like',
    'regexp',
    '=',
    '!=',
    'in',
  ]

  it('text values never change the SQL text, they are parameters', () => {
    for (const op of ops) {
      const baseline = compileFilter(t, cond('s', op, op === 'in' ? ['abc', 'abd'] : ['abc']))!
      for (const bad of corpus) {
        const out = compileFilter(t, cond('s', op, op === 'in' ? [bad, bad + 'x'] : [bad]))!
        expect(out.sql).toBe(baseline.sql)
        expect(out.params.length).toBe(baseline.params.length)
      }
    }
    const search = compileSearch(t, { text: 'abc', allColumns: true, matchCase: false })!
    for (const bad of corpus) {
      expect(compileSearch(t, { text: bad, allColumns: true, matchCase: false })!.sql).toBe(
        search.sql,
      )
    }
  })

  it('typed values that are not valid for their type are refused, not passed on', () => {
    for (const bad of corpus) {
      expect(() => compileFilter(t, cond('n', '=', [bad]))).toThrow(RowValueError)
    }
  })

  it('column names from the corpus are unknown columns', () => {
    for (const bad of corpus) {
      expect(() => compileFilter(t, cond(bad, '=', ['1']))).toThrow(/Unknown column/)
    }
  })

  it('a forged operator is not on the allow-list', () => {
    const forged = { type: 'condition', column: 's', op: '= 1 OR 1=1 --', values: ['x'] }
    expect(filterNode.safeParse(forged).success).toBe(false)
    expect(() => compileFilter(t, forged as unknown as FilterNode)).toThrow(RowValueError)
  })

  it('the request schema is strict: no where, sql or other extra field', () => {
    expect(filterNode.safeParse({ ...cond('s', '=', ['x']), where: '1=1' }).success).toBe(false)
    expect(filterNode.safeParse({ type: 'group', op: 'and', children: [], sql: 'x' }).success).toBe(
      false,
    )
  })
})

describe('quick search (FR-ROW-009)', () => {
  const t = tbl([
    col('id', 'int'),
    col('name', 'char'),
    col('note', 'text', { nullable: true }),
    col('kind', 'enum', { members: ['a'] }),
    col('created', 'datetime'),
    col('raw', 'binary', { length: 4 }),
    col('j', 'json'),
  ])
  it('searches text-like columns only, escaped; all columns adds a CAST', () => {
    const s = compileSearch(t, { text: '50%', allColumns: false, matchCase: false })!
    expect(s.sql).toBe(
      "(`name` LIKE ? ESCAPE '!' OR `note` LIKE ? ESCAPE '!' OR `kind` LIKE ? ESCAPE '!')",
    )
    expect(s.params).toEqual(['%50!%%', '%50!%%', '%50!%%'])
    const all = compileSearch(t, { text: 'x', allColumns: true, matchCase: true })!
    expect(all.sql).toContain("CAST(`id` AS CHAR) LIKE ? ESCAPE '!'")
    expect(all.sql).toContain("CAST(`created` AS CHAR) LIKE ? ESCAPE '!'")
    expect(all.sql).toContain("CAST(`name` AS BINARY) LIKE CAST(? AS BINARY) ESCAPE '!'")
    expect(all.sql).not.toContain('`j`')
    expect(all.sql).not.toContain('`raw`')
  })
  it('0x text also compares binary columns by their bytes (DATA-ISS-125)', () => {
    const s = compileSearch(t, { text: '0x7F000001', allColumns: false, matchCase: false })!
    expect(s.sql).toContain('`raw` = ?')
    expect(s.params).toContainEqual(Buffer.from([0x7f, 0, 0, 1]))
    expect(
      compileSearch(t, { text: '0x7F0', allColumns: false, matchCase: false })!.sql,
    ).not.toContain('`raw`')
  })
  it('at most 30 columns; nothing to search gives null', () => {
    const wide = tbl(Array.from({ length: 40 }, (_, i) => col(`c${i}`, 'char')))
    const s = compileSearch(wide, { text: 'x', allColumns: false, matchCase: false })!
    expect(s.params).toHaveLength(30)
    expect(
      compileSearch(tbl([col('id', 'int')]), { text: 'x', allColumns: false, matchCase: false }),
    ).toBeNull()
  })
  it('the injection string is searched as plain text', () => {
    const text = "o'brien; DROP TABLE customer; --"
    const s = compileSearch(t, { text, allColumns: true, matchCase: false })!
    expect(s.sql).not.toContain('brien')
    expect(s.params[0]).toBe(`%${text}%`)
  })
})
