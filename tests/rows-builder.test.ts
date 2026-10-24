import { describe, expect, it } from 'vitest'
import {
  buildCellRead,
  buildChange,
  buildCount,
  buildDelete,
  buildInsert,
  buildLookup,
  buildPage,
  buildRowByIdentity,
  buildUpdate,
  decodeRow,
  encodeSet,
  renderPreview,
  toStatement,
} from '../src/server/rows/builder'
import { compileFilter, compileSearch, combineAnd } from '../src/server/rows/filter'
import { identityFor } from '../src/server/rows/model'
import { BuildRefusal } from '../src/server/structure/types'
import type { Identity, RowChange } from '../src/server/rows/types'
import { col, tbl } from './rows-a-helpers'

const customer = tbl(
  [
    col('id', 'int', { autoIncrement: true }),
    col('name', 'char', { length: 100 }),
    col('email', 'char', { length: 100 }),
    col('note', 'text', { nullable: true }),
    col('created', 'datetime', { nullable: true, fsp: 6 }),
    col('flag', 'int', { baseType: 'tinyint' }),
    col('price', 'float', { nullable: true }),
    col('doc', 'blob', { nullable: true, baseType: 'longblob' }),
  ],
  { db: 'e2e_x', table: 'customer', primaryKey: ['id'] },
)
const pk: Identity = { kind: 'primary', columns: ['id'] }
const read = { cellBytes: 100 }
const v = (s: string) => ({ t: 'v' as const, v: s })
const gv = (s: string) => ({ t: 'v' as const, v: s })

describe('golden SQL (FR-ROW-001)', () => {
  it('page: names qualified and quoted, pageSize + 1 rows, identity as final tie-break', () => {
    const { statement, limit, offset } = buildPage(customer, pk, {
      page: 2,
      pageSize: 25,
      sort: [{ column: 'name', direction: 'desc' }],
      read,
    })
    expect(limit).toBe(25)
    expect(offset).toBe(50)
    expect(statement.sql).toBe(
      'SELECT `id`, LEFT(`name`, 101), CHAR_LENGTH(`name`), LEFT(`email`, 101), CHAR_LENGTH(`email`), ' +
        'LEFT(`note`, 101), CHAR_LENGTH(`note`), CAST(`created` AS CHAR), `flag`, CAST(`price` AS CHAR), ' +
        'SUBSTRING(`doc`, 1, 32), OCTET_LENGTH(`doc`) ' +
        'FROM `e2e_x`.`customer` ORDER BY `name` DESC, `id` ASC LIMIT 26 OFFSET 50',
    )
    expect(statement.params).toEqual([])
    expect(statement.kind).toBe('rowSelect')
  })

  it('page with filter: the WHERE carries placeholders and the parameters in order', () => {
    const where = compileFilter(customer, {
      type: 'group',
      op: 'or',
      children: [
        {
          type: 'group',
          op: 'and',
          children: [
            { type: 'condition', column: 'name', op: 'contains', values: ['ann'] },
            {
              type: 'condition',
              column: 'created',
              op: 'between',
              values: ['2024-01-01', '2024-02-01'],
            },
          ],
        },
        { type: 'condition', column: 'email', op: 'is null', values: [] },
      ],
    })
    const { statement } = buildPage(customer, pk, { page: 0, pageSize: 50, sort: [], where, read })
    expect(statement.sql).toContain(
      " WHERE ((`name` LIKE ? ESCAPE '!' AND `created` BETWEEN ? AND ?) OR `email` IS NULL) ORDER BY `id` ASC LIMIT 51",
    )
    expect(statement.params).toEqual(['%ann%', '2024-01-01', '2024-02-01'])
  })

  it('page: invisible key column is selected, other invisible columns are not', () => {
    const t = tbl(
      [
        col('my_row_id', 'int', { invisible: true }),
        col('a', 'int'),
        col('h', 'int', { invisible: true }),
      ],
      {
        primaryKey: ['my_row_id'],
      },
    )
    const { layout } = buildPage(
      t,
      { kind: 'primary', columns: ['my_row_id'] },
      { page: 0, pageSize: 5, sort: [], read },
    )
    expect(layout.columns.map((c) => c.name)).toEqual(['my_row_id', 'a'])
    const all = buildPage(
      t,
      { kind: 'primary', columns: ['my_row_id'] },
      { page: 0, pageSize: 5, sort: [], read, includeInvisible: true },
    )
    expect(all.layout.columns.map((c) => c.name)).toEqual(['my_row_id', 'a', 'h'])
  })

  it('count, and the capped count for views', () => {
    expect(buildCount(customer).sql).toBe('SELECT COUNT(*) FROM `e2e_x`.`customer`')
    const where = compileFilter(customer, {
      type: 'condition',
      column: 'flag',
      op: '>',
      values: ['0'],
    })
    const c = buildCount(customer, where)
    expect(c.sql).toBe('SELECT COUNT(*) FROM `e2e_x`.`customer` WHERE `flag` > ?')
    expect(c.params).toEqual(['0'])
    expect(buildCount(customer, null, 10000).sql).toBe(
      'SELECT COUNT(*) FROM (SELECT 1 FROM `e2e_x`.`customer` LIMIT 10001) AS capped',
    )
  })

  it('insert: columns in model order, DEFAULT as keyword, functions from templates, NULL as parameter', () => {
    const row = encodeSet(customer, {
      email: v('a@b.c'),
      id: { t: 'default' },
      name: v('Ann'),
      note: { t: 'null' },
      created: { t: 'fn', name: 'now' },
    })
    const b = buildInsert(customer, row)
    expect(b.sql).toBe(
      'INSERT INTO `e2e_x`.`customer` (`id`, `name`, `email`, `note`, `created`) VALUES (DEFAULT, ?, ?, ?, NOW())',
    )
    expect(b.params).toEqual(['Ann', 'a@b.c', null])
    expect(b.kind).toBe('rowInsert')
    expect(b.preview).toBe(
      "INSERT INTO `e2e_x`.`customer` (`id`, `name`, `email`, `note`, `created`) VALUES (DEFAULT, 'Ann', 'a@b.c', NULL, NOW())",
    )
    expect(buildInsert(customer, {}, true).sql).toBe(
      'INSERT IGNORE INTO `e2e_x`.`customer` () VALUES ()',
    )
  })

  it('update: only changed columns, key plus the old value of each changed column', () => {
    const b = buildUpdate(
      customer,
      pk,
      { key: { id: gv('7') }, old: { name: gv('Old '), flag: gv('1') } },
      encodeSet(customer, { name: v('New'), flag: v('0') }),
    )
    expect(b.sql).toBe(
      'UPDATE `e2e_x`.`customer` SET `name` = ?, `flag` = ? WHERE `id` = ? ' +
        'AND CAST(`name` AS BINARY) <=> CAST(? AS BINARY) AND `flag` <=> ?',
    )
    expect(b.params).toEqual(['New', '0', '7', 'Old ', '1'])
    expect(b.sql).not.toContain('LIMIT')
  })

  it('update of a float uses the digest of the value read; a missing old value is refused', () => {
    const digest = 'f'.repeat(64)
    const b = buildUpdate(
      customer,
      pk,
      { key: { id: gv('1') }, old: { price: { t: 'digest', v: digest } } },
      encodeSet(customer, { price: v('0.1') }),
    )
    expect(b.sql).toBe(
      'UPDATE `e2e_x`.`customer` SET `price` = ? WHERE `id` = ? AND SHA2(CAST(`price` AS BINARY), 256) <=> ?',
    )
    expect(b.params).toEqual(['0.1', '1', digest])
    expect(() =>
      buildUpdate(
        customer,
        pk,
        { key: { id: gv('1') }, old: {} },
        encodeSet(customer, { price: v('1') }),
      ),
    ).toThrow(BuildRefusal)
  })

  it('a key change compares the old key once for numbers', () => {
    const b = buildUpdate(
      customer,
      pk,
      { key: { id: gv('7') }, old: { id: gv('7') } },
      encodeSet(customer, { id: v('8') }),
    )
    expect(b.sql).toBe('UPDATE `e2e_x`.`customer` SET `id` = ? WHERE `id` = ?')
    expect(b.params).toEqual(['8', '7'])
  })

  it('delete: key plus the old values of the row as loaded', () => {
    const b = buildDelete(customer, pk, {
      key: { id: gv('7') },
      old: { id: gv('7'), name: gv('x'), note: { t: 'null' } },
    })
    expect(b.sql).toBe(
      'DELETE FROM `e2e_x`.`customer` WHERE `id` = ? AND CAST(`name` AS BINARY) <=> CAST(? AS BINARY) AND CAST(`note` AS BINARY) <=> CAST(? AS BINARY)',
    )
    expect(b.params).toEqual(['7', 'x', null])
  })

  it('all-columns identity compares every column null-safely and adds LIMIT 1', () => {
    const nokey = tbl([col('a', 'int', { nullable: true }), col('b', 'char', { nullable: true })], {
      db: 'd',
      table: 'nokey',
    })
    const id = identityFor(nokey)
    expect(id.kind).toBe('all-columns')
    const key = { a: gv('1'), b: gv('x') }
    const u = buildUpdate(nokey, id, { key, old: { b: gv('x') } }, encodeSet(nokey, { b: v('y') }))
    expect(u.sql).toBe(
      'UPDATE `d`.`nokey` SET `b` = ? WHERE `a` <=> ? AND CAST(`b` AS BINARY) <=> CAST(? AS BINARY) LIMIT 1',
    )
    expect(u.params).toEqual(['y', '1', 'x'])
    const d = buildDelete(nokey, id, { key: { a: { t: 'null' }, b: gv('x') }, old: {} })
    expect(d.sql).toBe(
      'DELETE FROM `d`.`nokey` WHERE `a` <=> ? AND CAST(`b` AS BINARY) <=> CAST(? AS BINARY) LIMIT 1',
    )
    expect(d.params).toEqual([null, 'x'])
  })

  it('row by identity, with digests of the digest-compared columns', () => {
    const { statement, layout } = buildRowByIdentity(customer, pk, {
      key: { id: gv('3') },
      read: { cellBytes: 5 },
      digests: true,
    })
    expect(statement.sql.startsWith('SELECT `id`, LEFT(`name`, 6)')).toBe(true)
    expect(statement.sql).toContain('SHA2(CAST(`price` AS BINARY), 256)')
    expect(statement.sql).toContain('SHA2(CAST(`doc` AS BINARY), 256)')
    expect(statement.sql.endsWith('FROM `e2e_x`.`customer` WHERE `id` = ? LIMIT 1')).toBe(true)
    const raw: unknown[] = Array(layout.width).fill(null)
    raw[layout.columns[6]!.start] = '0.1'
    raw[layout.columns[6]!.digestAt!] = 'a'.repeat(64)
    const out = decodeRow(layout, raw)
    expect(out.cells[6]).toBe('0.1')
    expect(out.digests).toEqual({ price: 'a'.repeat(64) })
    expect(out.cells).toHaveLength(8)
  })

  it('cell read and lookup', () => {
    const c = buildCellRead(customer, pk, { id: gv('3') }, 'note', 1000)
    expect(c.statement.sql).toBe(
      'SELECT LEFT(`note`, 1000), CHAR_LENGTH(`note`), SHA2(CAST(`note` AS BINARY), 256) FROM `e2e_x`.`customer` WHERE `id` = ? LIMIT 1',
    )
    const l = buildLookup(customer, {
      keyColumns: ['id'],
      displayColumns: ['name'],
      query: '50%_off!',
      page: 1,
      pageSize: 50,
    })
    expect(l.statement.sql).toBe(
      'SELECT `id`, LEFT(CAST(`name` AS CHAR), 200) FROM `e2e_x`.`customer` WHERE ' +
        "(CAST(`name` AS CHAR) LIKE ? ESCAPE '!' OR CAST(`id` AS CHAR) LIKE ? ESCAPE '!') ORDER BY `id` ASC LIMIT 51 OFFSET 50",
    )
    expect(l.statement.params).toEqual(['%50!%!_off!!%', '%50!%!_off!!%'])
    const keyed = buildLookup(customer, {
      keyColumns: ['id'],
      displayColumns: ['name'],
      keys: [{ id: gv('1') }, { id: gv('2') }],
      page: 0,
      pageSize: 50,
    })
    expect(keyed.statement.sql).toContain('WHERE ((`id` = ?) OR (`id` = ?))')
    expect(
      keyed.decode([
        [1, 'Ann'],
        [2, null],
      ]),
    ).toEqual({
      options: [
        { key: { id: '1' }, display: 'Ann' },
        { key: { id: '2' }, display: '2' },
      ],
      hasNext: false,
    })
  })

  it('buildChange: one statement per row or target, index preserved', () => {
    const insert: RowChange = {
      op: 'insert',
      ignore: false,
      rows: [{ name: v('a') }, { name: v('b') }],
    }
    expect(buildChange(customer, pk, insert).map((s) => s.params)).toEqual([['a'], ['b']])
    const upd: RowChange = {
      op: 'update',
      set: { flag: v('1') },
      targets: [
        { key: { id: gv('1') }, old: { flag: gv('0') } },
        { key: { id: gv('2') }, old: { flag: gv('0') } },
      ],
    }
    const stmts = buildChange(customer, pk, upd)
    expect(stmts).toHaveLength(2)
    expect(stmts[1]!.params).toEqual(['1', '2', '0'])
    expect(toStatement(stmts[0]!, 'soft')).toMatchObject({
      kind: 'rowUpdate',
      class: 'soft',
      params: ['1', '1', '0'],
    })
    const bad: RowChange = { ...upd, targets: [upd.targets[0]!, { key: { id: gv('2') }, old: {} }] }
    try {
      buildChange(customer, pk, bad)
      throw new Error('no refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(BuildRefusal)
      expect((e as { rowIndex?: number }).rowIndex).toBe(1)
    }
  })
})

describe('refusals', () => {
  it('views are read-only, identity none refuses, unknown or generated columns are refused', () => {
    const view = tbl([col('a', 'int')], { kind: 'view' })
    expect(() => buildInsert(view, {})).toThrow(/read-only/)
    expect(() =>
      buildDelete(customer, { kind: 'none', reason: 'view' }, { key: {}, old: {} }),
    ).toThrow(BuildRefusal)
    expect(() => encodeSet(customer, { nope: v('1') })).toThrow(/Unknown column/)
    const gen = tbl([col('g', 'int', { generated: 'virtual' })])
    expect(() => encodeSet(gen, { g: v('1') })).toThrow(BuildRefusal)
    expect(() => buildInsert(customer, { nope: { sql: '?', params: ['x'] } })).toThrow(BuildRefusal)
  })

  it('page numbers must be bounded integers', () => {
    const base = { sort: [], read }
    expect(() => buildPage(customer, pk, { ...base, page: -1, pageSize: 10 })).toThrow()
    expect(() => buildPage(customer, pk, { ...base, page: 0, pageSize: 1001 })).toThrow()
    expect(() => buildPage(customer, pk, { ...base, page: 1.5, pageSize: 10 })).toThrow()
    expect(() => buildPage(customer, pk, { ...base, page: 0, pageSize: Number.NaN })).toThrow()
    expect(() =>
      buildPage(customer, pk, {
        page: 0,
        pageSize: 10,
        sort: [{ column: 'zz', direction: 'asc' }],
        read,
      }),
    ).toThrow(/Unknown column/)
  })
})

// ---- hostile names and values --------------------------------------------------------------------

/** Small deterministic PRNG so the property test is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const PIECES = [
  "'",
  '"',
  '`',
  '\\',
  "\\'",
  '%',
  '_',
  '!',
  '?',
  ';',
  '--',
  '/*',
  '*/',
  '#',
  '‘',
  '“',
  'ʼ',
  'ǀ',
  '\u0000',
  '\n',
  '\r\n',
  '\t',
  ' OR 1=1 --',
  "'; DROP TABLE customer; --",
  '😀',
  ' ',
  'x',
  '0x41',
  'NULL',
  ')',
  '(',
  ',',
]

function hostile(r: () => number): string {
  let out = ''
  const n = 1 + Math.floor(r() * 8)
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(r() * PIECES.length)]!
  return out
}

describe('no literal in SQL text (property)', () => {
  const r = rng(20261024)
  const harmless = 'abc'

  function shape(name: string, email: string, oldName: string, key: string, filterValue: string) {
    const set = encodeSet(customer, { name: v(name), email: v(email), note: v(name) })
    const upd = buildUpdate(
      customer,
      pk,
      { key: { id: gv('1') }, old: { name: gv(oldName), email: gv(oldName), note: gv(oldName) } },
      set,
    )
    const keyed = buildDelete(customer, pk, { key: { id: gv(key) }, old: { name: gv(oldName) } })
    const ins = buildInsert(
      customer,
      encodeSet(customer, { name: v(name), email: v(email), note: v(name) }),
    )
    const where = combineAnd(
      compileFilter(customer, {
        type: 'group',
        op: 'or',
        children: [
          { type: 'condition', column: 'name', op: 'contains', values: [filterValue] },
          { type: 'condition', column: 'name', op: 'like', values: [filterValue] },
          { type: 'condition', column: 'email', op: 'regexp', values: [filterValue] },
          {
            type: 'condition',
            column: 'email',
            op: 'in',
            values: [filterValue, filterValue + 'x'],
          },
          {
            type: 'condition',
            column: 'name',
            op: 'starts with',
            values: [filterValue],
            matchCase: true,
          },
        ],
      }),
      compileSearch(customer, { text: filterValue, allColumns: true, matchCase: false }),
    )
    const page = buildPage(customer, pk, { page: 0, pageSize: 10, sort: [], where, read })
    return { upd, keyed, ins, page: page.statement }
  }

  it('the SQL of every statement is identical for harmless and hostile values', () => {
    const base = shape(harmless, harmless, harmless, '1', harmless)
    for (let i = 0; i < 300; i++) {
      const h = [hostile(r), hostile(r), hostile(r), hostile(r)] as const
      // keys are numbers: use a hostile text only where the codec accepts text
      const out = shape(h[0], h[1], h[2], String(Math.floor(r() * 1e6)), h[3])
      for (const k of ['upd', 'keyed', 'ins', 'page'] as const) {
        expect(out[k].sql).toBe(base[k].sql)
        for (const text of h) {
          if (text.length > 3) expect(out[k].sql).not.toContain(text)
        }
      }
      expect(out.upd.params).toContain(h[0])
      expect(out.page.params).toContain(
        `%${h[3]!.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`,
      )
    }
  })

  it('hostile column and table names are quoted, never interpreted', () => {
    const names = [
      'a`b',
      'x; DROP TABLE t',
      'we?ird',
      "q'uote",
      'back\\slash',
      'a.b',
      '`',
      '--',
      'ü/ä&x',
    ]
    for (const n of names) {
      const t = tbl([col(n, 'int'), col('c', 'char')], { db: n, table: n, primaryKey: [n] })
      const id = identityFor(t)
      const q = (s: string) => '`' + s.replaceAll('`', '``') + '`'
      const { statement } = buildPage(t, id, {
        page: 0,
        pageSize: 5,
        sort: [{ column: n, direction: 'asc' }],
        read,
      })
      expect(statement.sql).toContain(`FROM ${q(n)}.${q(n)} ORDER BY ${q(n)} ASC LIMIT 6`)
      const u = buildUpdate(
        t,
        id,
        { key: { [n]: gv('1') }, old: { c: gv('a') } },
        encodeSet(t, { c: v('b?') }),
      )
      expect(u.sql).toBe(
        `UPDATE ${q(n)}.${q(n)} SET \`c\` = ? WHERE ${q(n)} = ? AND CAST(\`c\` AS BINARY) <=> CAST(? AS BINARY)`,
      )
      // the ? inside a quoted name is not a placeholder in the preview
      expect(u.preview).toBe(
        `UPDATE ${q(n)}.${q(n)} SET \`c\` = 'b?' WHERE ${q(n)} = '1' AND CAST(\`c\` AS BINARY) <=> CAST('a' AS BINARY)`,
      )
    }
    // NUL and over-long names cannot be quoted
    const nul = tbl([col('a\u0000b', 'int')], { primaryKey: ['a\u0000b'] })
    expect(() =>
      buildPage(nul, identityFor(nul), { page: 0, pageSize: 5, sort: [], read }),
    ).toThrow()
    const long = tbl([col('x'.repeat(65), 'int')])
    expect(() =>
      buildPage(long, identityFor(long), { page: 0, pageSize: 5, sort: [], read }),
    ).toThrow()
  })

  it('the SQL contains no charset alias', () => {
    const latin = tbl([col('s', 'char', { charset: 'latin1' })], { primaryKey: ['s'] })
    const b = buildUpdate(
      latin,
      { kind: 'primary', columns: ['s'] },
      { key: { s: gv('a') }, old: { s: gv('a') } },
      encodeSet(latin, { s: v('b') }),
    )
    expect(b.sql).not.toMatch(/\butf8\b/i)
    expect(b.sql).toContain('CONVERT(? USING latin1)')
  })
})

describe('preview (display only)', () => {
  it('escapes quotes, backslashes and control characters; truncates bytes', () => {
    expect(renderPreview('SELECT ?, ?, ?, ?', ["it's", 'a\\b\n', null, Buffer.from([1, 2])])).toBe(
      "SELECT 'it''s', 'a\\\\b\\n', NULL, 0x0102",
    )
    const big = renderPreview('?', [Buffer.alloc(100, 0xab)])
    expect(big).toMatch(/^0x(ab){32}… \(100 bytes\)$/)
  })
  it('leaves ? inside quoted names and fixed literals alone', () => {
    expect(renderPreview("SELECT `a?b` LIKE ? ESCAPE '!' AND ?", ['x', 2])).toBe(
      "SELECT `a?b` LIKE 'x' ESCAPE '!' AND '2'",
    )
  })
})
