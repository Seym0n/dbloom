import { describe, expect, it } from 'vitest'
import {
  assembleRowTable,
  decideDefault,
  identityFor,
  parseMembers,
  type RawCatalog,
  type RawColumn,
} from '../src/server/rows/model'
import { col, tbl } from './rows-a-helpers'

function raw(
  name: string,
  ordinal: number,
  dataType: string,
  o: Partial<RawColumn> = {},
): RawColumn {
  return {
    name,
    ordinal,
    dataType,
    columnType: dataType,
    isNullable: 'NO',
    columnDefault: null,
    extra: '',
    charLength: null,
    numericPrecision: null,
    numericScale: null,
    datetimePrecision: null,
    charset: null,
    collation: null,
    generationExpression: null,
    comment: '',
    srsId: null,
    ...o,
  }
}

const empty = { columns: [], rules: [] }

function catalog(product: 'mysql' | 'mariadb', o: Partial<RawCatalog>): RawCatalog {
  return {
    product,
    db: 'shop',
    table: 'item',
    tableType: 'BASE TABLE',
    engine: 'InnoDB',
    tableRows: 3,
    columns: [],
    statistics: [],
    outgoing: empty,
    incoming: empty,
    checkClauses: [],
    ...o,
  }
}

describe('assembleRowTable', () => {
  it('maps types to kinds and keeps the server spelling of the full type', () => {
    const t = assembleRowTable(
      catalog('mysql', {
        columns: [
          raw('id', 1, 'bigint', { columnType: 'bigint unsigned', extra: 'auto_increment' }),
          raw('price', 2, 'decimal', {
            columnType: 'decimal(12,2)',
            numericPrecision: 12,
            numericScale: 2,
          }),
          raw('name', 3, 'varchar', {
            columnType: 'varchar(100)',
            charLength: 100,
            charset: 'utf8mb4',
          }),
          raw('b', 4, 'bit', { columnType: 'bit(12)', numericPrecision: 12 }),
          raw('t', 5, 'datetime', { columnType: 'datetime(6)', datetimePrecision: 6 }),
          raw('g', 6, 'point', { srsId: 4326 }),
          raw('w', 7, 'weird_type', { columnType: 'weird_type(3)' }),
        ],
      }),
    )
    const [id, price, name, b, ts, g, w] = t.columns
    expect(id).toMatchObject({
      kind: 'int',
      unsigned: true,
      autoIncrement: true,
      baseType: 'bigint',
    })
    expect(price).toMatchObject({ kind: 'decimal', precision: 12, scale: 2 })
    expect(name).toMatchObject({ kind: 'char', length: 100, charset: 'utf8mb4' })
    expect(b).toMatchObject({ kind: 'bit', length: 12 })
    expect(ts).toMatchObject({ kind: 'datetime', fsp: 6 })
    expect(g).toMatchObject({ kind: 'geometry', srid: 4326 })
    expect(w).toMatchObject({ kind: 'unknown', fullType: 'weird_type(3)' })
  })

  it('reads enum and set members including quotes and an empty member', () => {
    expect(parseMembers("enum('a','it''s','','x,y')")).toEqual(['a', "it's", '', 'x,y'])
    expect(parseMembers("set('ä','b\\'c')")).toEqual(['ä', "b'c"])
  })

  it('decides defaults per product (spec 5.7)', () => {
    expect(decideDefault(null, '', true, 'mysql')).toEqual({ kind: 'null' })
    expect(decideDefault(null, '', false, 'mysql')).toEqual({ kind: 'none' })
    expect(decideDefault('x', '', false, 'mysql')).toEqual({ kind: 'literal', text: 'x' })
    expect(decideDefault('', '', false, 'mysql')).toEqual({ kind: 'literal', text: '' })
    expect(decideDefault('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', false, 'mysql')).toEqual({
      kind: 'expression',
      text: 'CURRENT_TIMESTAMP',
    })
    expect(decideDefault('NULL', '', true, 'mariadb')).toEqual({ kind: 'null' })
    expect(decideDefault(null, '', false, 'mariadb')).toEqual({ kind: 'none' })
    expect(decideDefault("'x'", '', false, 'mariadb')).toEqual({ kind: 'literal', text: 'x' })
    expect(decideDefault("''", '', false, 'mariadb')).toEqual({ kind: 'literal', text: '' })
    expect(decideDefault("'NULL'", '', false, 'mariadb')).toEqual({ kind: 'literal', text: 'NULL' })
    expect(decideDefault('0', '', false, 'mariadb')).toEqual({ kind: 'literal', text: '0' })
    expect(decideDefault('current_timestamp()', '', false, 'mariadb')).toEqual({
      kind: 'expression',
      text: 'current_timestamp()',
    })
    expect(decideDefault('(1 + 1)', '', false, 'mariadb')).toEqual({
      kind: 'expression',
      text: '(1 + 1)',
    })
  })

  it('recognises generated, invisible and on-update columns from EXTRA', () => {
    const t = assembleRowTable(
      catalog('mysql', {
        columns: [
          raw('my_row_id', 1, 'bigint', {
            extra: 'auto_increment INVISIBLE',
            columnType: 'bigint unsigned',
          }),
          raw('v', 2, 'int', { extra: 'VIRTUAL GENERATED', columnDefault: '1' }),
          raw('s', 3, 'int', { extra: 'STORED GENERATED' }),
          raw('u', 4, 'timestamp', {
            extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
            columnDefault: 'CURRENT_TIMESTAMP',
          }),
        ],
      }),
    )
    expect(t.columns[0]).toMatchObject({ invisible: true, autoIncrement: true })
    expect(t.columns[1]).toMatchObject({ generated: 'virtual', default: { kind: 'none' } })
    expect(t.columns[2]).toMatchObject({ generated: 'stored' })
    expect(t.columns[3]).toMatchObject({ onUpdate: 'CURRENT_TIMESTAMP' })
    expect(t.columns[3]!.default.kind).toBe('expression')
  })

  it('recognises MariaDB JSON by its json_valid CHECK, not by the column type', () => {
    const t = assembleRowTable(
      catalog('mariadb', {
        columns: [
          raw('meta', 1, 'longtext', { columnType: 'longtext', charset: 'utf8mb4' }),
          raw('plain', 2, 'longtext', { columnType: 'longtext' }),
        ],
        checkClauses: [{ name: 'meta', clause: 'json_valid(`meta`)' }],
      }),
    )
    expect(t.columns[0]!.kind).toBe('json')
    expect(t.columns[1]!.kind).toBe('text')
  })

  it('finds the primary key, unique keys and their nullability; skips functional parts', () => {
    const t = assembleRowTable(
      catalog('mysql', {
        columns: [
          raw('a', 1, 'int'),
          raw('B', 2, 'int'),
          raw('c', 3, 'int', { isNullable: 'YES' }),
        ],
        statistics: [
          { indexName: 'PRIMARY', nonUnique: 0, seq: 2, columnName: 'b' },
          { indexName: 'PRIMARY', nonUnique: 0, seq: 1, columnName: 'a' },
          { indexName: 'u_nullable', nonUnique: 0, seq: 1, columnName: 'c' },
          { indexName: 'u_b', nonUnique: 0, seq: 1, columnName: 'B' },
          { indexName: 'idx', nonUnique: 1, seq: 1, columnName: 'a' },
          { indexName: 'fn', nonUnique: 0, seq: 1, columnName: null },
        ],
      }),
    )
    expect(t.primaryKey).toEqual(['a', 'B'])
    expect(t.uniqueKeys).toEqual([
      { name: 'u_nullable', columns: ['c'], allNotNull: false },
      { name: 'u_b', columns: ['B'], allNotNull: true },
    ])
  })

  it('groups foreign keys, outgoing and incoming, with their rules', () => {
    const t = assembleRowTable(
      catalog('mysql', {
        outgoing: {
          columns: [
            {
              constraint: 'fk1',
              schema: 'shop',
              table: 'item',
              column: 'x',
              refSchema: 'shop',
              refTable: 'p',
              refColumn: 'px',
              position: 1,
            },
            {
              constraint: 'fk1',
              schema: 'shop',
              table: 'item',
              column: 'y',
              refSchema: 'shop',
              refTable: 'p',
              refColumn: 'py',
              position: 2,
            },
          ],
          rules: [
            {
              schema: 'shop',
              constraint: 'fk1',
              table: 'item',
              updateRule: 'RESTRICT',
              deleteRule: 'CASCADE',
            },
          ],
        },
        incoming: {
          columns: [
            {
              constraint: 'fk2',
              schema: 'shop',
              table: 'orders',
              column: 'item_id',
              refSchema: 'shop',
              refTable: 'item',
              refColumn: 'id',
              position: 1,
            },
          ],
          rules: [
            {
              schema: 'shop',
              constraint: 'fk2',
              table: 'orders',
              updateRule: 'CASCADE',
              deleteRule: 'SET NULL',
            },
          ],
        },
      }),
    )
    expect(t.outgoing).toEqual([
      {
        name: 'fk1',
        columns: ['x', 'y'],
        refDb: 'shop',
        refTable: 'p',
        refColumns: ['px', 'py'],
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      },
    ])
    // incoming: db/table/columns describe the referencing table, refColumns this table's columns
    expect(t.incoming).toEqual([
      {
        name: 'fk2',
        columns: ['item_id'],
        refDb: 'shop',
        refTable: 'orders',
        refColumns: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
    ])
  })

  it('maps table types and engines', () => {
    expect(assembleRowTable(catalog('mysql', { tableType: 'VIEW', engine: null })).kind).toBe(
      'view',
    )
    expect(assembleRowTable(catalog('mariadb', { tableType: 'SYSTEM VERSIONED' })).kind).toBe(
      'table',
    )
    expect(assembleRowTable(catalog('mysql', {})).transactional).toBe(true)
    expect(assembleRowTable(catalog('mysql', { engine: 'MyISAM' })).transactional).toBe(false)
    expect(assembleRowTable(catalog('mysql', { tableRows: null })).estimatedRows).toBeNull()
  })
})

describe('identityFor (FR-ROW-004)', () => {
  const id = col('id', 'int')
  const name = col('name', 'char')
  const note = col('note', 'text', { nullable: true })

  it('prefers the primary key', () => {
    const t = tbl([id, name], {
      primaryKey: ['id'],
      uniqueKeys: [{ name: 'u', columns: ['name'], allNotNull: true }],
    })
    expect(identityFor(t)).toEqual({ kind: 'primary', columns: ['id'] })
  })

  it('falls back to the first unique key with only NOT NULL columns', () => {
    const t = tbl([id, name, note], {
      uniqueKeys: [
        { name: 'u1', columns: ['note'], allNotNull: false },
        { name: 'u2', columns: ['name'], allNotNull: true },
      ],
    })
    expect(identityFor(t)).toEqual({ kind: 'unique', columns: ['name'] })
  })

  it('a nullable-only unique key is no identity: all-columns applies', () => {
    const t = tbl([id, note], {
      uniqueKeys: [{ name: 'u1', columns: ['note'], allNotNull: false }],
    })
    expect(identityFor(t)).toEqual({ kind: 'all-columns', columns: ['id', 'note'] })
  })

  it('all-columns includes invisible columns', () => {
    const t = tbl([id, col('hid', 'int', { invisible: true })])
    expect(identityFor(t)).toEqual({ kind: 'all-columns', columns: ['id', 'hid'] })
  })

  it('a generated invisible primary key (GIPK) is a valid key', () => {
    const t = tbl([col('my_row_id', 'int', { invisible: true, autoIncrement: true }), name], {
      primaryKey: ['my_row_id'],
    })
    expect(identityFor(t)).toEqual({ kind: 'primary', columns: ['my_row_id'] })
  })

  it('key names are matched case-insensitively and returned as the model spells them', () => {
    const t = tbl([col('Id', 'int')], { primaryKey: ['id'] })
    expect(identityFor(t)).toEqual({ kind: 'primary', columns: ['Id'] })
  })

  it('refuses all-columns for unsafe or unknown columns and for views', () => {
    for (const kind of ['float', 'json', 'geometry'] as const) {
      expect(identityFor(tbl([id, col('x', kind)]))).toEqual({
        kind: 'none',
        reason: 'no-key-unsafe-columns',
      })
    }
    expect(identityFor(tbl([id, col('x', 'text', { baseType: 'longtext' })]))).toEqual({
      kind: 'none',
      reason: 'no-key-unsafe-columns',
    })
    expect(identityFor(tbl([id, col('x', 'blob', { baseType: 'mediumblob' })]))).toEqual({
      kind: 'none',
      reason: 'no-key-unsafe-columns',
    })
    // a plain TEXT / BLOB (64 KiB) is fine
    expect(identityFor(tbl([id, col('x', 'text'), col('y', 'blob')])).kind).toBe('all-columns')
    expect(identityFor(tbl([id, col('x', 'unknown')]))).toEqual({
      kind: 'none',
      reason: 'unknown-type',
    })
    expect(identityFor(tbl([id], { kind: 'view', primaryKey: ['id'] }))).toEqual({
      kind: 'none',
      reason: 'view',
    })
  })

  it('needs the key and, for all-columns, every column to be selected', () => {
    const t = tbl([id, name], { primaryKey: ['id'] })
    expect(identityFor(t, { selectedColumns: ['name'] })).toEqual({
      kind: 'none',
      reason: 'columns-not-selected',
    })
    expect(identityFor(tbl([id, name]), { selectedColumns: ['id'] })).toEqual({
      kind: 'none',
      reason: 'columns-not-selected',
    })
    expect(identityFor(tbl([id, name]), { selectedColumns: ['id', 'name'] }).kind).toBe(
      'all-columns',
    )
  })

  it('a key over an unknown-type column is skipped', () => {
    const t = tbl([col('k', 'unknown'), name], { primaryKey: ['k'] })
    expect(identityFor(t)).toEqual({ kind: 'none', reason: 'unknown-type' })
  })
})
