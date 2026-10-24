/**
 * Package A round trips against the real servers (MySQL 8.4 on 33064, MariaDB 10.11 on 33061, root/root):
 * the model read, every type kind written and read back through the builder and the codecs, the conflict
 * check with found rows, digest guards, the filter against an independent computation, hostile values with
 * NO_BACKSLASH_ESCAPES, and "no warnings" for the SQL the builder produces.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise'
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
  type RowKey,
} from '../src/server/rows/builder'
import { combineAnd, compileFilter, compileSearch } from '../src/server/rows/filter'
import { identityFor, loadRowTable, readPrivileges } from '../src/server/rows/model'
import type {
  BuiltStatement,
  Cell,
  FilterNode,
  GuardValue,
  Identity,
  RowTable,
  WireValue,
} from '../src/server/rows/types'

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
] as const

const read = { cellBytes: 1000 }
const v = (s: string): WireValue => ({ t: 'v', v: s })

type Spec = {
  col: string
  ddl: string
  v1: string
  v2: string
  show1?: Cell
  show2?: Cell
  /** Compare the shown text as JSON documents (MySQL normalises). */
  json?: boolean
  only?: 'mysql' | 'mariadb'
}

const bits64 = (s: string) => `b'${s.padStart(64, '0')}'`

const SPECS: Spec[] = [
  { col: 'c_tiny', ddl: 'TINYINT UNSIGNED', v1: '255', v2: '0', show1: '255', show2: '0' },
  { col: 'c_hex', ddl: 'INT', v1: '0x10', v2: "X'ff'", show1: '16', show2: '255' },
  {
    col: 'c_big',
    ddl: 'BIGINT',
    v1: '9223372036854775807',
    v2: '-9223372036854775808',
    show1: '9223372036854775807',
    show2: '-9223372036854775808',
  },
  {
    col: 'c_ubig',
    ddl: 'BIGINT UNSIGNED',
    v1: '18446744073709551615',
    v2: '9007199254740993',
    show1: '18446744073709551615',
    show2: '9007199254740993',
  },
  {
    col: 'c_dec',
    ddl: 'DECIMAL(30,10)',
    v1: '12345678901234567890.0123456789',
    v2: '-0.0000000001',
    show1: '12345678901234567890.0123456789',
    show2: '-0.0000000001',
  },
  {
    col: 'c_dec65',
    ddl: 'DECIMAL(65,30)',
    v1: '12345678901234567890123456789012345.123456789012345678901234567890',
    v2: '0.000000000000000000000000000001',
    show1: '12345678901234567890123456789012345.123456789012345678901234567890',
    show2: '0.000000000000000000000000000001',
  },
  { col: 'c_dbl', ddl: 'DOUBLE', v1: '0.1', v2: '-2.5', show1: '0.1', show2: '-2.5' },
  { col: 'c_flt', ddl: 'FLOAT', v1: '0.1', v2: '16777216', show1: '0.1', show2: '16777200' },
  {
    col: 'c_bit12',
    ddl: 'BIT(12)',
    v1: "b'000000000101'",
    v2: '0xFFF',
    show1: "b'000000000101'",
    show2: "b'111111111111'",
  },
  {
    col: 'c_bit64',
    ddl: 'BIT(64)',
    v1: '0xFFFFFFFFFFFFFFFF',
    v2: "b'1'",
    show1: bits64('1'.repeat(64)),
    show2: bits64('1'),
  },
  {
    col: 'c_date',
    ddl: 'DATE',
    v1: '0099-01-01',
    v2: '2024-02-29',
    show1: '0099-01-01',
    show2: '2024-02-29',
  },
  {
    col: 'c_dt',
    ddl: 'DATETIME(6)',
    v1: '2024-03-05 12:34:56.123456',
    v2: '1000-01-01 00:00:00.000000',
    show1: '2024-03-05 12:34:56.123456',
    show2: '1000-01-01 00:00:00.000000',
  },
  {
    col: 'c_ts',
    ddl: 'TIMESTAMP(6) NULL',
    v1: '2024-03-05 12:34:56.123456',
    v2: '2030-01-01 00:00:00.000001',
    show1: '2024-03-05 12:34:56.123456',
    show2: '2030-01-01 00:00:00.000001',
  },
  {
    col: 'c_time',
    ddl: 'TIME(3)',
    v1: '01:02:03.456',
    v2: '-838:59:59.000',
    show1: '01:02:03.456',
    show2: '-838:59:59.000',
  },
  { col: 'c_year', ddl: 'YEAR', v1: '2024', v2: '1901', show1: '2024', show2: '1901' },
  {
    col: 'c_str',
    ddl: 'VARCHAR(50)',
    v1: 'a\r\nb  \u{1F600}',
    v2: ' leading and trailing ',
    show1: 'a\r\nb  \u{1F600}',
    show2: ' leading and trailing ',
  },
  {
    col: 'c_latin',
    ddl: 'VARCHAR(20) CHARACTER SET latin1',
    v1: 'é',
    v2: 'ü ',
    show1: 'é',
    show2: 'ü ',
  },
  {
    col: 'c_text',
    ddl: 'TEXT',
    v1: 'line1\nline2\t',
    v2: 'it\'s \\ `q` "d" ?',
    show1: 'line1\nline2\t',
    show2: 'it\'s \\ `q` "d" ?',
  },
  { col: 'c_enum', ddl: "ENUM('a','b c')", v1: 'b c', v2: 'a', show1: 'b c', show2: 'a' },
  { col: 'c_set', ddl: "SET('x','y','z')", v1: 'x,z', v2: '', show1: 'x,z', show2: '' },
  {
    col: 'c_bin',
    ddl: 'BINARY(16)',
    v1: '0x000102030405060708090a0b0c0d0e0f',
    v2: '0xffffffffffffffffffffffffffffffff',
    show1: { binary: '000102030405060708090a0b0c0d0e0f', size: 16 },
    show2: { binary: 'ffffffffffffffffffffffffffffffff', size: 16 },
  },
  {
    col: 'c_vbin',
    ddl: 'VARBINARY(8)',
    v1: '0x00ff0a',
    v2: '0x',
    show1: { binary: '00ff0a', size: 3 },
    show2: { binary: '', size: 0 },
  },
  {
    col: 'c_blob',
    ddl: 'BLOB',
    v1: '0x0102',
    v2: '0xff',
    show1: { binary: '0102', size: 2 },
    show2: { binary: 'ff', size: 1 },
  },
  { col: 'c_json', ddl: 'JSON', v1: '{"b": 2, "a": 1}', v2: '[1, 2, 3]', json: true },
  {
    col: 'c_uuid',
    ddl: 'UUID',
    v1: '123e4567-e89b-12d3-a456-426614174000',
    v2: '123e4567-e89b-12d3-a456-426614174001',
    show1: '123e4567-e89b-12d3-a456-426614174000',
    show2: '123e4567-e89b-12d3-a456-426614174001',
    only: 'mariadb',
  },
  {
    col: 'c_inet',
    ddl: 'INET6',
    v1: '::1',
    v2: '2001:db8::ff00:42:8329',
    show1: '::1',
    show2: '2001:db8::ff00:42:8329',
    only: 'mariadb',
  },
]

describe.each(servers)('rows package A against $name', ({ port, product }) => {
  const DB = `rows_a_${product}`
  let pool: Pool
  let conn: PoolConnection

  const exec = async (b: BuiltStatement) => {
    const [res] = await conn.execute(b.sql, b.params as never[])
    return res as { affectedRows: number; changedRows: number; insertId: number }
  }
  const select = async (b: BuiltStatement) => {
    const [rows] = await conn.execute(
      { sql: b.sql, rowsAsArray: true } as never,
      b.params as never[],
    )
    return rows as unknown[][]
  }
  const warnings = async () => {
    const [w] = await conn.query('SHOW WARNINGS')
    return w as { Level: string; Code: number; Message: string }[]
  }
  const model = (table: string) => loadRowTable(pool, DB, table)
  const readRow = async (t: RowTable, id: Identity, key: RowKey) => {
    const { statement, layout } = buildRowByIdentity(t, id, {
      key,
      read,
      digests: true,
      includeInvisible: true,
    })
    const rows = await select(statement)
    if (rows.length === 0) return null
    return { ...decodeRow(layout, rows[0]!), names: layout.columns.map((c) => c.name) }
  }
  const guard = (cell: Cell, digest?: string): GuardValue => {
    if (digest !== undefined) return { t: 'digest', v: digest }
    if (cell === null) return { t: 'null' }
    if (typeof cell === 'string') return { t: 'v', v: cell }
    if ('binary' in cell) return { t: 'v', v: '0x' + cell.binary }
    return { t: 'v', v: cell.cut }
  }

  beforeAll(async () => {
    pool = createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      charset: 'utf8mb4',
      connectionLimit: 3,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      jsonStrings: true,
      multipleStatements: false,
    })
    conn = await pool.getConnection()
    await conn.query(`DROP DATABASE IF EXISTS ${DB}`)
    await conn.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4`)
    await conn.query(`USE ${DB}`)
    const cols = SPECS.filter((s) => !s.only || s.only === product)
    const geom = product === 'mysql' ? 'GEOMETRY SRID 4326' : 'GEOMETRY'
    await conn.query(
      `CREATE TABLE rt (id INT AUTO_INCREMENT PRIMARY KEY, ${cols
        .map((s) => `${s.col} ${s.ddl.includes('NULL') ? s.ddl : s.ddl + ' NULL'}`)
        .join(', ')}, c_geom ${geom} NULL) ENGINE=InnoDB`,
    )
  })
  afterAll(async () => {
    await conn?.query(`DROP DATABASE IF EXISTS ${DB}`)
    conn?.release()
    await pool?.end()
  })

  test('the product is the expected one', async () => {
    const [r] = await conn.query('SELECT VERSION() AS v')
    expect(
      String((r as { v: string }[])[0]!.v)
        .toLowerCase()
        .includes('mariadb'),
    ).toBe(product === 'mariadb')
  })

  describe('catalog model', () => {
    test('kinds, keys and details of the round-trip table', async () => {
      const t = await model('rt')
      expect(t.kind).toBe('table')
      expect(t.engine).toBe('InnoDB')
      expect(t.transactional).toBe(true)
      expect(t.primaryKey).toEqual(['id'])
      expect(identityFor(t)).toEqual({ kind: 'primary', columns: ['id'] })
      const by = Object.fromEntries(t.columns.map((c) => [c.name, c]))
      expect(by.id).toMatchObject({ kind: 'int', autoIncrement: true, nullable: false })
      expect(by.c_ubig).toMatchObject({ kind: 'int', unsigned: true, baseType: 'bigint' })
      expect(by.c_dec65).toMatchObject({ kind: 'decimal', precision: 65, scale: 30 })
      expect(by.c_dbl!.kind).toBe('float')
      expect(by.c_bit12).toMatchObject({ kind: 'bit', length: 12 })
      expect(by.c_dt).toMatchObject({ kind: 'datetime', fsp: 6 })
      expect(by.c_time).toMatchObject({ kind: 'time', fsp: 3 })
      expect(by.c_str).toMatchObject({ kind: 'char', length: 50, charset: 'utf8mb4' })
      expect(by.c_latin).toMatchObject({ kind: 'char', charset: 'latin1' })
      expect(by.c_enum).toMatchObject({ kind: 'enum', members: ['a', 'b c'] })
      expect(by.c_set).toMatchObject({ kind: 'set', members: ['x', 'y', 'z'] })
      expect(by.c_bin).toMatchObject({ kind: 'binary', length: 16 })
      expect(by.c_blob!.kind).toBe('blob')
      expect(by.c_json!.kind).toBe('json')
      expect(by.c_geom!.kind).toBe('geometry')
      if (product === 'mysql') expect(by.c_geom!.srid).toBe(4326)
      else {
        expect(by.c_uuid!.kind).toBe('uuid')
        expect(by.c_inet!.kind).toBe('inet6')
      }
      expect(t.estimatedRows === null || typeof t.estimatedRows === 'number').toBe(true)
    })

    test('unknown names are not found; a view has no identity', async () => {
      await expect(loadRowTable(pool, DB, 'nope')).rejects.toThrow(/Not found/)
      await expect(loadRowTable(pool, 'nodb', 'rt')).rejects.toThrow(/Not found/)
      await conn.query('CREATE OR REPLACE VIEW vw AS SELECT id FROM rt')
      const v = await model('vw')
      expect(v.kind).toBe('view')
      expect(identityFor(v)).toEqual({ kind: 'none', reason: 'view' })
    })

    test('defaults, generated, invisible, on update and unknown columns', async () => {
      await conn.query(`CREATE TABLE d1 (
        id INT PRIMARY KEY,
        a INT NOT NULL DEFAULT 5,
        b VARCHAR(10) NOT NULL DEFAULT '',
        c VARCHAR(10) NULL,
        d VARCHAR(10) NOT NULL,
        e VARCHAR(10) NOT NULL DEFAULT 'NULL',
        f TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        g INT AS (a + 1) VIRTUAL,
        h INT AS (a + 2) STORED,
        i INT NULL INVISIBLE,
        j INT NOT NULL DEFAULT (1 + 1)
      )`)
      const t = await model('d1')
      const by = Object.fromEntries(t.columns.map((c) => [c.name, c]))
      expect(by.a!.default).toEqual({ kind: 'literal', text: '5' })
      expect(by.b!.default).toEqual({ kind: 'literal', text: '' })
      expect(by.c!.default).toEqual({ kind: 'null' })
      expect(by.d!.default).toEqual({ kind: 'none' })
      expect(by.e!.default).toEqual({ kind: 'literal', text: 'NULL' })
      expect(by.f!.default.kind).toBe('expression')
      expect(by.f!.onUpdate?.toLowerCase()).toContain('current_timestamp')
      expect(by.g).toMatchObject({ generated: 'virtual', default: { kind: 'none' } })
      expect(by.h!.generated).toBe('stored')
      expect(by.i!.invisible).toBe(true)
      expect(by.j!.default.kind).toBe('expression')
      expect(by.a!.invisible).toBe(false)
    })

    test('foreign keys, outgoing and incoming, with rules; unique keys', async () => {
      await conn.query(
        'CREATE TABLE fk_p (id INT PRIMARY KEY, u VARCHAR(10) NOT NULL, w INT NULL, UNIQUE KEY uk (u), UNIQUE KEY uw (w))',
      )
      await conn.query(
        'CREATE TABLE fk_c (id INT PRIMARY KEY, p INT, q INT, CONSTRAINT fkc FOREIGN KEY (p) REFERENCES fk_p (id) ON DELETE CASCADE ON UPDATE RESTRICT)',
      )
      const p = await model('fk_p')
      expect(p.uniqueKeys).toEqual([
        { name: 'uk', columns: ['u'], allNotNull: true },
        { name: 'uw', columns: ['w'], allNotNull: false },
      ])
      expect(p.incoming).toEqual([
        {
          name: 'fkc',
          columns: ['p'],
          refDb: DB,
          refTable: 'fk_c',
          refColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        },
      ])
      const c = await model('fk_c')
      expect(c.outgoing).toEqual([
        {
          name: 'fkc',
          columns: ['p'],
          refDb: DB,
          refTable: 'fk_p',
          refColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        },
      ])
    })

    test('a table without a key gets the all-columns identity; a MariaDB-style JSON column is json', async () => {
      await conn.query('CREATE TABLE nokey0 (a INT, b VARCHAR(5))')
      const t = await model('nokey0')
      expect(identityFor(t)).toEqual({ kind: 'all-columns', columns: ['a', 'b'] })
      await conn.query('CREATE TABLE js (id INT PRIMARY KEY, j JSON, k LONGTEXT)')
      const j = await model('js')
      expect(j.columns.map((c) => c.kind)).toEqual(['int', 'json', 'text'])
    })

    test.runIf(product === 'mysql')(
      'generated invisible primary key (GIPK) is the identity',
      async () => {
        await conn.query('SET SESSION sql_generate_invisible_primary_key = 1')
        await conn.query('CREATE TABLE gipk (a INT, b VARCHAR(5))')
        await conn.query('SET SESSION sql_generate_invisible_primary_key = 0')
        const t = await model('gipk')
        expect(t.primaryKey).toEqual(['my_row_id'])
        expect(t.columns[0]).toMatchObject({
          name: 'my_row_id',
          invisible: true,
          autoIncrement: true,
        })
        const id = identityFor(t)
        expect(id).toEqual({ kind: 'primary', columns: ['my_row_id'] })
        // the page selects the invisible key, hides nothing else
        const page = buildPage(t, id, { page: 0, pageSize: 10, sort: [], read })
        expect(page.layout.columns.map((c) => c.name)).toEqual(['my_row_id', 'a', 'b'])
        // never written, but usable as key
        const ins = await exec(buildInsert(t, encodeSet(t, { a: v('1'), b: v('x') })))
        const row = await readRow(t, id, { my_row_id: { t: 'v', v: String(ins.insertId) } })
        expect(row?.cells).toEqual([String(ins.insertId), '1', 'x'])
      },
    )

    test('privileges of root are all there', async () => {
      const t = await model('rt')
      const p = await readPrivileges(pool, t)
      expect(p).not.toBeNull()
      expect(p).toMatchObject({ select: true, insert: true, update: true, delete: true })
    })
  })

  describe('round trip per type (FR-ROW-003)', () => {
    const specs = SPECS.filter((s) => !s.only || s.only === product)
    const same = (spec: Spec, actual: Cell, expected: Cell | undefined, wireValue: string) => {
      if (spec.json) {
        expect(JSON.parse(actual as string)).toEqual(JSON.parse(wireValue))
      } else {
        expect(actual).toEqual(expected)
      }
    }

    test.each(specs.map((s) => [s.col, s] as const))(
      '%s: write, read, change, unchanged, stale',
      async (_n, spec) => {
        const t = await model('rt')
        const id = identityFor(t)
        const ins = await exec(buildInsert(t, encodeSet(t, { [spec.col]: v(spec.v1) })))
        expect(ins.affectedRows).toBe(1)
        expect((await warnings()).filter((w) => w.Level !== 'Note')).toEqual([])
        const key: RowKey = { id: { t: 'v', v: String(ins.insertId) } }

        let row = await readRow(t, id, key)
        const i = row!.names.indexOf(spec.col)
        same(spec, row!.cells[i]!, spec.show1, spec.v1)
        // untouched columns are NULL
        expect(row!.cells.filter((c, k) => k !== 0 && k !== i && c !== null)).toEqual([])
        const g1 = guard(row!.cells[i]!, row!.digests[spec.col])

        // change: only this column is in SET, the old value guards it
        let b = buildUpdate(
          t,
          id,
          { key, old: { [spec.col]: g1 } },
          encodeSet(t, { [spec.col]: v(spec.v2) }),
        )
        expect(b.sql.match(/SET (.*) WHERE/)![1]).toMatch(/^`[a-z0-9_]+` = [^,]+$/)
        let res = await exec(b)
        expect(res.affectedRows).toBe(1)
        row = await readRow(t, id, key)
        same(spec, row!.cells[i]!, spec.show2, spec.v2)
        const g2 = guard(row!.cells[i]!, row!.digests[spec.col])

        // the same value again: found rows 1, changed rows 0 -> no conflict
        b = buildUpdate(
          t,
          id,
          { key, old: { [spec.col]: g2 } },
          encodeSet(t, { [spec.col]: v(spec.v2) }),
        )
        res = await exec(b)
        expect(res.affectedRows).toBe(1)
        expect(res.changedRows).toBe(0)

        // stale old value: nothing matches
        b = buildUpdate(
          t,
          id,
          { key, old: { [spec.col]: g1 } },
          encodeSet(t, { [spec.col]: v(spec.v1) }),
        )
        res = await exec(b)
        expect(res.affectedRows).toBe(0)

        // NULL and back
        b = buildUpdate(
          t,
          id,
          { key, old: { [spec.col]: g2 } },
          encodeSet(t, { [spec.col]: { t: 'null' } }),
        )
        expect((await exec(b)).affectedRows).toBe(1)
        row = await readRow(t, id, key)
        expect(row!.cells[i]).toBeNull()
        const gNull = guard(null, usesDigestFor(t, spec.col) ? row!.digests[spec.col] : undefined)
        b = buildUpdate(
          t,
          id,
          { key, old: { [spec.col]: gNull } },
          encodeSet(t, { [spec.col]: v(spec.v1) }),
        )
        expect((await exec(b)).affectedRows).toBe(1)

        // delete with the old values of the row as loaded
        row = await readRow(t, id, key)
        const old: Record<string, GuardValue> = {}
        row!.names.forEach((n, k) => {
          old[n] = guard(row!.cells[k]!, row!.digests[n])
        })
        const del = await exec(buildDelete(t, id, { key, old }))
        expect(del.affectedRows).toBe(1)
        expect((await warnings()).filter((w) => w.Level !== 'Note')).toEqual([])
      },
    )

    test('geometry: WKT with SRID round trips, the axis order stays', async () => {
      const t = await model('rt')
      const id = identityFor(t)
      const value = product === 'mysql' ? 'POINT(10 20)' : 'SRID=4326;POINT(10 20)'
      const ins = await exec(buildInsert(t, encodeSet(t, { c_geom: v(value) })))
      const key: RowKey = { id: { t: 'v', v: String(ins.insertId) } }
      let row = await readRow(t, id, key)
      const i = row!.names.indexOf('c_geom')
      expect(row!.cells[i]).toBe(value)
      expect(row!.digests.c_geom).toMatch(/^[0-9a-f]{64}$/)
      const next = product === 'mysql' ? 'POINT(30 40)' : 'SRID=4326;POINT(30 40)'
      const b = buildUpdate(
        t,
        id,
        { key, old: { c_geom: { t: 'digest', v: row!.digests.c_geom! } } },
        encodeSet(t, { c_geom: v(next) }),
      )
      expect((await exec(b)).affectedRows).toBe(1)
      row = await readRow(t, id, key)
      expect(row!.cells[i]).toBe(next)
      // a digest of the old value no longer matches
      const stale = buildUpdate(
        t,
        id,
        { key, old: { c_geom: { t: 'digest', v: '0'.repeat(64) } } },
        encodeSet(t, { c_geom: v(value) }),
      )
      expect((await exec(stale)).affectedRows).toBe(0)
      // a wrong SRID is refused by MySQL (3643), accepted by MariaDB
      if (product === 'mysql') {
        await expect(
          exec(buildInsert(t, encodeSet(t, { c_geom: v('SRID=3857;POINT(1 1)') }))),
        ).rejects.toMatchObject({ errno: 3643 })
      }
      // a null SRID prefix does not change the text for a value without one
      const plain = await exec(buildInsert(t, encodeSet(t, { c_geom: { t: 'null' } })))
      expect(plain.affectedRows).toBe(1)
    })

    test('the digest the server computes equals the SHA-256 of the text it reads', async () => {
      const t = await model('rt')
      const id = identityFor(t)
      const ins = await exec(
        buildInsert(t, encodeSet(t, { c_dbl: v('0.1'), c_json: v('{"a": 1}') })),
      )
      const key: RowKey = { id: { t: 'v', v: String(ins.insertId) } }
      const row = await readRow(t, id, key)
      const { createHash } = await import('node:crypto')
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      expect(row!.digests.c_dbl).toBe(sha('0.1'))
      const j = row!.names.indexOf('c_json')
      expect(row!.digests.c_json).toBe(sha(row!.cells[j] as string))
      // readCell returns the same digest
      const c = buildCellRead(t, id, key, 'c_json', 100)
      const rows = await select(c.statement)
      const out = c.projection.decode(rows[0]!)
      expect(out.digest).toBe(row!.digests.c_json)
      expect(out.value).toMatchObject({ t: 'text', truncated: false })
    })
  })

  describe('conflicts and identity (FR-ROW-004, 005)', () => {
    test('text is compared as bytes: PAD SPACE and case cannot hide a change', async () => {
      await conn.query(
        'CREATE TABLE pad (id INT PRIMARY KEY, s VARCHAR(10) COLLATE utf8mb4_general_ci)',
      )
      await conn.query("INSERT INTO pad VALUES (1, 'a')")
      const t = await model('pad')
      const id = identityFor(t)
      const key: RowKey = { id: { t: 'v', v: '1' } }
      const set = encodeSet(t, { s: v('b') })
      for (const wrong of ['a ', 'A']) {
        const res = await exec(buildUpdate(t, id, { key, old: { s: { t: 'v', v: wrong } } }, set))
        expect(res.affectedRows, wrong).toBe(0)
      }
      const ok = await exec(buildUpdate(t, id, { key, old: { s: { t: 'v', v: 'a' } } }, set))
      expect(ok.affectedRows).toBe(1)
    })

    test('a latin1 column with non-ASCII text is guarded by its own bytes', async () => {
      await conn.query('CREATE TABLE lat (id INT PRIMARY KEY, s VARCHAR(10) CHARACTER SET latin1)')
      await conn.query("INSERT INTO lat VALUES (1, 'é')")
      const t = await model('lat')
      const id = identityFor(t)
      const res = await exec(
        buildUpdate(
          t,
          id,
          { key: { id: { t: 'v', v: '1' } }, old: { s: { t: 'v', v: 'é' } } },
          encodeSet(t, { s: v('ü') }),
        ),
      )
      expect(res.affectedRows).toBe(1)
    })

    test('a table without a key: exactly one of two identical rows changes (G1)', async () => {
      await conn.query('CREATE TABLE nokey (a INT, b VARCHAR(10))')
      await conn.query("INSERT INTO nokey VALUES (1, 'x'), (1, 'x'), (2, 'y')")
      const t = await model('nokey')
      const id = identityFor(t)
      expect(id.kind).toBe('all-columns')
      const key: RowKey = { a: { t: 'v', v: '1' }, b: { t: 'v', v: 'x' } }
      const res = await exec(
        buildUpdate(t, id, { key, old: { b: { t: 'v', v: 'x' } } }, encodeSet(t, { b: v('z') })),
      )
      expect(res.affectedRows).toBe(1)
      const [rows] = await conn.query('SELECT a, b FROM nokey ORDER BY a, b')
      expect(rows).toEqual([
        { a: 1, b: 'x' },
        { a: 1, b: 'z' },
        { a: 2, b: 'y' },
      ])
      // null-safe: a NULL column matches itself
      await conn.query('INSERT INTO nokey VALUES (NULL, NULL)')
      const del = await exec(
        buildDelete(t, id, { key: { a: { t: 'null' }, b: { t: 'null' } }, old: {} }),
      )
      expect(del.affectedRows).toBe(1)
    })

    test('a key change is found by the old key; unique keys identify rows', async () => {
      await conn.query('CREATE TABLE uq (a VARCHAR(10) NOT NULL, b INT, UNIQUE KEY (a))')
      await conn.query("INSERT INTO uq VALUES ('k1', 1), ('k2', 2)")
      const t = await model('uq')
      const id = identityFor(t)
      expect(id).toEqual({ kind: 'unique', columns: ['a'] })
      const res = await exec(
        buildUpdate(
          t,
          id,
          { key: { a: { t: 'v', v: 'k1' } }, old: { a: { t: 'v', v: 'k1' } } },
          encodeSet(t, { a: v('k3') }),
        ),
      )
      expect(res.affectedRows).toBe(1)
      const row = await readRow(t, id, { a: { t: 'v', v: 'k3' } })
      expect(row?.cells).toEqual(['k3', '1'])
    })

    test('a delete of the wrong old values does not delete', async () => {
      const t = await model('uq')
      const id = identityFor(t)
      const key: RowKey = { a: { t: 'v', v: 'k2' } }
      expect(
        (await exec(buildDelete(t, id, { key, old: { b: { t: 'v', v: '9' } } }))).affectedRows,
      ).toBe(0)
      expect(
        (await exec(buildDelete(t, id, { key, old: { b: { t: 'v', v: '2' } } }))).affectedRows,
      ).toBe(1)
    })

    test('buildChange: an insert batch, a bulk update, a bulk delete run as planned', async () => {
      const t = await model('uq')
      const id = identityFor(t)
      const ins = buildChange(t, id, {
        op: 'insert',
        ignore: false,
        rows: [
          { a: v('m1'), b: v('1') },
          { a: v('m2'), b: v('2') },
          { a: v('m3'), b: { t: 'null' } },
        ],
      })
      for (const s of ins) expect((await exec(s)).affectedRows).toBe(1)
      const upd = buildChange(t, id, {
        op: 'update',
        set: { b: v('7') },
        targets: [
          { key: { a: { t: 'v', v: 'm1' } }, old: { b: { t: 'v', v: '1' } } },
          { key: { a: { t: 'v', v: 'm3' } }, old: { b: { t: 'null' } } },
        ],
      })
      for (const s of upd) expect((await exec(s)).affectedRows).toBe(1)
      const del = buildChange(t, id, {
        op: 'delete',
        targets: ['m1', 'm2', 'm3'].map((a) => ({
          key: { a: { t: 'v' as const, v: a } },
          old: {},
        })),
      })
      let n = 0
      for (const s of del) n += (await exec(s)).affectedRows
      expect(n).toBe(3)
    })
  })

  describe('hostile values (NO_BACKSLASH_ESCAPES, ANSI_QUOTES)', () => {
    const hostile = [
      "x\\' OR 1=1 -- \\",
      "'; DROP TABLE hs; --",
      '\\',
      '`',
      '"',
      '‘ʼ',
      'a\u0000b',
      '?',
      '%_!',
      '\u{1F600}\r\n\t',
    ]
    for (const mode of [
      '',
      'NO_BACKSLASH_ESCAPES',
      'ANSI_QUOTES',
      'NO_BACKSLASH_ESCAPES,ANSI_QUOTES',
    ]) {
      test(`values stay values with sql_mode +[${mode}]`, async () => {
        const c = await pool.getConnection()
        try {
          await c.query(`USE ${DB}`)
          await c.query('DROP TABLE IF EXISTS hs')
          await c.query(
            'CREATE TABLE hs (id INT AUTO_INCREMENT PRIMARY KEY, s TEXT, n VARCHAR(64))',
          )
          if (mode) await c.query(`SET SESSION sql_mode = CONCAT(@@sql_mode, ',${mode}')`)
          const t = await model('hs')
          const id = identityFor(t)
          const run = async (b: BuiltStatement) =>
            (await c.execute(b.sql, b.params as never[]))[0] as {
              affectedRows: number
              insertId: number
            }
          for (const h of hostile) {
            const ins = await run(buildInsert(t, encodeSet(t, { s: v(h), n: v(h.slice(0, 20)) })))
            const key: RowKey = { id: { t: 'v', v: String(ins.insertId) } }
            const page = buildRowByIdentity(t, id, { key, read })
            const [rows] = await c.execute(
              { sql: page.statement.sql, rowsAsArray: true } as never,
              page.statement.params as never[],
            )
            expect((rows as unknown[][])[0]![1]).toBe(h)
            // the old value guard with the hostile text matches exactly
            const upd = await run(
              buildUpdate(
                t,
                id,
                { key, old: { s: { t: 'v', v: h } } },
                encodeSet(t, { s: v('ok') }),
              ),
            )
            expect(upd.affectedRows).toBe(1)
            // a filter with the hostile text finds nothing or the literal row, never everything
            const where = compileFilter(t, {
              type: 'condition',
              column: 'n',
              op: 'contains',
              values: [h],
            })
            const cnt = buildCount(t, where)
            const [cr] = await c.execute(
              { sql: cnt.sql, rowsAsArray: true } as never,
              cnt.params as never[],
            )
            expect(Number((cr as unknown[][])[0]![0])).toBeLessThanOrEqual(hostile.length)
          }
          const [total] = await c.query('SELECT COUNT(*) AS n FROM hs')
          expect(Number((total as { n: number }[])[0]!.n)).toBe(hostile.length)
        } finally {
          await c.query('SET SESSION sql_mode = DEFAULT').catch(() => undefined)
          c.release()
        }
      })
    }

    test('hostile table and column names round trip', async () => {
      const dbn = 'we`ird;name'
      await conn.query('DROP DATABASE IF EXISTS `we``ird;name`')
      await conn.query('CREATE DATABASE `we``ird;name`')
      try {
        await conn.query(
          'CREATE TABLE `we``ird;name`.`t?a.b` (`i?d` INT PRIMARY KEY, `x``y` VARCHAR(10), `a.b` INT)',
        )
        const t = await loadRowTable(pool, dbn, 't?a.b')
        const id = identityFor(t)
        expect(id).toEqual({ kind: 'primary', columns: ['i?d'] })
        const ins = await exec(
          buildInsert(t, encodeSet(t, { 'i?d': v('1'), 'x`y': v("q'"), 'a.b': v('2') })),
        )
        expect(ins.affectedRows).toBe(1)
        const page = buildPage(t, id, {
          page: 0,
          pageSize: 5,
          sort: [
            { column: 'a.b', direction: 'desc' },
            { column: 'x`y', direction: 'asc' },
          ],
          read,
        })
        const rows = await select(page.statement)
        expect(rows).toHaveLength(1)
        expect(decodeRow(page.layout, rows[0]!).cells).toEqual(['1', "q'", '2'])
      } finally {
        await conn.query('DROP DATABASE IF EXISTS `we``ird;name`')
      }
    })
  })

  describe('filter and search against an independent computation (FR-ROW-008, 009)', () => {
    type Person = {
      id: number
      name: string
      email: string | null
      age: number
      born: string
      raw: string
      tags: string
      meta: string
    }
    const people: Person[] = [
      {
        id: 1,
        name: 'Ann Lee',
        email: 'ann@x.org',
        age: 31,
        born: '1993-04-01',
        raw: '7f000001',
        tags: 'a,b',
        meta: '{"k": "alpha"}',
      },
      {
        id: 2,
        name: 'ann-marie',
        email: null,
        age: 17,
        born: '2007-12-31',
        raw: '7f000002',
        tags: 'b',
        meta: '{"k": "beta"}',
      },
      {
        id: 3,
        name: "O'Brien; DROP TABLE people; --",
        email: 'ob@y.org',
        age: 64,
        born: '1960-01-01',
        raw: '0a000001',
        tags: '',
        meta: '{"k": "50%"}',
      },
      {
        id: 4,
        name: '100%_sure',
        email: 'p@z.org',
        age: 31,
        born: '1993-04-02',
        raw: '7f000001',
        tags: 'a',
        meta: '{"k": "a_b"}',
      },
      {
        id: 5,
        name: 'ANN',
        email: '',
        age: 0,
        born: '2024-02-29',
        raw: '00000000',
        tags: 'a,b',
        meta: '{}',
      },
    ]
    let t: RowTable
    let id: Identity

    beforeAll(async () => {
      await conn.query(
        "CREATE TABLE people (id INT PRIMARY KEY, name VARCHAR(60), email VARCHAR(60) NULL, age INT, born DATE, raw BINARY(4), tags SET('a','b'), meta JSON)",
      )
      for (const p of people) {
        await conn.execute('INSERT INTO people VALUES (?,?,?,?,?,UNHEX(?),?,?)', [
          p.id,
          p.name,
          p.email,
          p.age,
          p.born,
          p.raw,
          p.tags,
          p.meta,
        ])
      }
      t = await model('people')
      id = identityFor(t)
    })

    const ids = async (where: ReturnType<typeof compileFilter>) => {
      const page = buildPage(t, id, { page: 0, pageSize: 100, sort: [], where, read })
      const rows = await select(page.statement)
      expect((await warnings()).filter((w) => w.Level !== 'Note')).toEqual([])
      return rows.map((r) => Number(r[0]))
    }
    const cond = (
      column: string,
      op: never,
      values: string[] = [],
      extra: object = {},
    ): FilterNode => ({ type: 'condition', column, op, values, ...extra }) as FilterNode

    test('contains is case-insensitive by collation and escapes wildcards', async () => {
      expect(await ids(compileFilter(t, cond('name', 'contains' as never, ['ann'])))).toEqual([
        1, 2, 5,
      ])
      expect(await ids(compileFilter(t, cond('name', 'contains' as never, ['%'])))).toEqual([4])
      expect(await ids(compileFilter(t, cond('name', 'contains' as never, ['_'])))).toEqual([4])
      expect(await ids(compileFilter(t, cond('name', 'starts with' as never, ['ann'])))).toEqual([
        1, 2, 5,
      ])
      expect(await ids(compileFilter(t, cond('name', 'ends with' as never, ['sure'])))).toEqual([4])
      expect(await ids(compileFilter(t, cond('name', 'not contains' as never, ['ann'])))).toEqual([
        3, 4,
      ])
    })

    test('match case compares bytes', async () => {
      expect(
        await ids(
          compileFilter(t, cond('name', 'contains' as never, ['ann'], { matchCase: true })),
        ),
      ).toEqual([2])
      expect(
        await ids(compileFilter(t, cond('name', '=' as never, ['ANN'], { matchCase: true }))),
      ).toEqual([5])
      expect(
        await ids(compileFilter(t, cond('name', 'regexp' as never, ['^ann'], { matchCase: true }))),
      ).toEqual([2])
      expect(await ids(compileFilter(t, cond('name', 'regexp' as never, ['^ann'])))).toEqual([
        1, 2, 5,
      ])
    })

    test('numbers, between, in, null, empty', async () => {
      expect(await ids(compileFilter(t, cond('age', '>=' as never, ['31'])))).toEqual([1, 3, 4])
      expect(await ids(compileFilter(t, cond('age', 'between' as never, ['17', '31'])))).toEqual([
        1, 2, 4,
      ])
      expect(
        await ids(compileFilter(t, cond('age', 'not between' as never, ['17', '31']))),
      ).toEqual([3, 5])
      expect(await ids(compileFilter(t, cond('age', 'in' as never, ['0', '64', '0x1f'])))).toEqual([
        1, 3, 4, 5,
      ])
      expect(await ids(compileFilter(t, cond('email', 'is null' as never)))).toEqual([2])
      expect(await ids(compileFilter(t, cond('email', 'empty' as never)))).toEqual([5])
      expect(await ids(compileFilter(t, cond('email', 'not empty' as never)))).toEqual([1, 3, 4])
    })

    test('dates, set, binary hex and JSON text', async () => {
      expect(
        await ids(compileFilter(t, cond('born', 'between' as never, ['1993-04-01', '1993-04-30']))),
      ).toEqual([1, 4])
      expect(await ids(compileFilter(t, cond('tags', 'has' as never, ['a'])))).toEqual([1, 4, 5])
      expect(await ids(compileFilter(t, cond('tags', 'has not' as never, ['a'])))).toEqual([2, 3])
      expect(await ids(compileFilter(t, cond('raw', '=' as never, ['0x7F000001'])))).toEqual([1, 4])
      expect(
        await ids(compileFilter(t, cond('raw', 'starts with hex' as never, ['0x7f']))),
      ).toEqual([1, 2, 4])
      expect(
        await ids(compileFilter(t, cond('raw', 'in' as never, ['0x0a000001', '0x00000000']))),
      ).toEqual([3, 5])
      expect(await ids(compileFilter(t, cond('meta', 'text contains' as never, ['%'])))).toEqual([
        3,
      ])
      expect(await ids(compileFilter(t, cond('meta', 'text contains' as never, ['a_b'])))).toEqual([
        4,
      ])
    })

    test('groups, NOT, the search, and the injection strings', async () => {
      const tree: FilterNode = {
        type: 'group',
        op: 'or',
        children: [
          {
            type: 'group',
            op: 'and',
            children: [
              cond('name', 'contains' as never, ['ann']),
              cond('born', 'between' as never, ['1990-01-01', '2000-01-01']),
            ],
          },
          cond('email', 'is null' as never),
        ],
      }
      expect(await ids(compileFilter(t, tree))).toEqual([1, 2])
      expect(await ids(compileFilter(t, { ...tree, negate: true } as FilterNode))).toEqual([
        3, 4, 5,
      ])
      const inj = "o'brien; DROP TABLE people; --"
      expect(
        await ids(compileSearch(t, { text: inj, allColumns: true, matchCase: false })),
      ).toEqual([3]) // the literal row, found as text
      expect(
        await ids(compileSearch(t, { text: "O'Brien", allColumns: false, matchCase: false })),
      ).toEqual([3])
      expect(
        await ids(compileSearch(t, { text: '31', allColumns: true, matchCase: false })),
      ).toEqual([1, 2, 4]) // ages 31 and the date 2007-12-31
      expect(
        await ids(compileSearch(t, { text: '0x7F000001', allColumns: false, matchCase: false })),
      ).toEqual([1, 4])
      expect(
        await ids(
          combineAnd(
            compileSearch(t, { text: 'ann', allColumns: false, matchCase: false }),
            compileFilter(t, cond('age', '<' as never, ['20'])),
          ),
        ),
      ).toEqual([2, 5])
      const [still] = await conn.query('SELECT COUNT(*) AS n FROM people')
      expect(Number((still as { n: number }[])[0]!.n)).toBe(5)
    })
  })

  describe('reads', () => {
    test('page, sort, hasNext, count, capped count and lookup execute and decode', async () => {
      await conn.query('CREATE TABLE pg (id INT PRIMARY KEY, grp INT, name VARCHAR(10), note TEXT)')
      for (let i = 1; i <= 7; i++)
        await conn.execute('INSERT INTO pg VALUES (?,?,?,?)', [i, i % 2, `n${i}`, 'z'.repeat(300)])
      const t = await model('pg')
      const id = identityFor(t)
      const first = buildPage(t, id, {
        page: 0,
        pageSize: 3,
        sort: [
          { column: 'grp', direction: 'desc' },
          { column: 'name', direction: 'asc' },
        ],
        read: { cellBytes: 50 },
      })
      const rows = await select(first.statement)
      expect(rows).toHaveLength(4) // pageSize + 1: there is a next page
      const cells = rows.slice(0, 3).map((r) => decodeRow(first.layout, r).cells)
      expect(cells.map((c) => c[0])).toEqual(['1', '3', '5'])
      expect(cells[0]![3]).toEqual({ cut: 'z'.repeat(50), length: 300 })
      const last = buildPage(t, id, { page: 2, pageSize: 3, sort: [], read })
      expect(await select(last.statement)).toHaveLength(1)
      const c = await select(buildCount(t))
      expect(Number(c[0]![0])).toBe(7)
      const capped = await select(buildCount(t, null, 4))
      expect(Number(capped[0]![0])).toBe(5)
      const l = buildLookup(t, {
        keyColumns: ['id'],
        displayColumns: ['name'],
        query: 'n',
        page: 0,
        pageSize: 50,
      })
      const lr = l.decode(await select(l.statement))
      expect(lr.options).toHaveLength(7)
      const k = buildLookup(t, {
        keyColumns: ['id'],
        displayColumns: ['name'],
        keys: [{ id: { t: 'v', v: '2' } }, { id: { t: 'v', v: '5' } }],
        page: 0,
        pageSize: 50,
      })
      expect(k.decode(await select(k.statement)).options).toEqual([
        { key: { id: '2' }, display: 'n2' },
        { key: { id: '5' }, display: 'n5' },
      ])
      expect((await warnings()).filter((w) => w.Level !== 'Note')).toEqual([])
    })

    test('a binary foreign key is read as 0x hex for the picker', async () => {
      await conn.query('CREATE TABLE bk (k BINARY(4) PRIMARY KEY, label VARCHAR(10))')
      await conn.query("INSERT INTO bk VALUES (UNHEX('7F000001'), 'local')")
      const t = await model('bk')
      const l = buildLookup(t, {
        keyColumns: ['k'],
        displayColumns: ['label'],
        keys: [{ k: { t: 'v', v: '0x7f000001' } }],
        page: 0,
        pageSize: 50,
      })
      expect(l.decode(await select(l.statement)).options).toEqual([
        { key: { k: '0x7f000001' }, display: 'local' },
      ])
    })
  })
})

function usesDigestFor(t: RowTable, name: string): boolean {
  const c = t.columns.find((x) => x.name === name)!
  return c.kind === 'float' || c.kind === 'json' || c.kind === 'geometry'
}
