import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConnection, type Connection } from 'mysql2/promise'
import { quoteIdent, InvalidIdentifierError } from '~/server/db/identifiers'
import { pageRows } from '~/server/db/rows'
import { listDatabases, listTables, NotFoundError, resolveTable } from '~/server/db/schema'
import { openTargetPool, type TargetPool } from '~/server/db/target-pool'
import type { Config } from '~/server/config'

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
]
const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const DB = 'dbloom_it'
const HOSTILE_TABLE = 'we`ird"; DROP TABLE x; -- ünï'
const HOSTILE_COLUMN = 'col`1'

test('quoteIdent doubles backticks and rejects bad names', () => {
  expect(quoteIdent('a`b')).toBe('`a``b`')
  expect(() => quoteIdent('')).toThrow(InvalidIdentifierError)
  expect(() => quoteIdent('a\u0000b')).toThrow(InvalidIdentifierError)
  expect(() => quoteIdent('x'.repeat(65))).toThrow(InvalidIdentifierError)
})

describe.each(servers)('database helpers on $name', ({ port }) => {
  let admin: Connection
  let pool: TargetPool

  beforeAll(async () => {
    admin = await createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`)
    await admin.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4`)
    await admin.query(
      `CREATE TABLE ${DB}.\`items\` (id INT PRIMARY KEY, name VARCHAR(20), note TEXT, blobby BLOB, big BIGINT, meta JSON)`,
    )
    const longText = 'x'.repeat(1200)
    await admin.query(
      `INSERT INTO ${DB}.items VALUES (1,'<b>one</b>',?, X'DEADBEEF', 9007199254740993, '{"a": 1}'), (2,'two',NULL,NULL,2,NULL), (3,'three',NULL,NULL,3,NULL)`,
      [longText],
    )
    await admin.query(
      `CREATE TABLE ${DB}.${quoteIdent(HOSTILE_TABLE)} (id INT, ${quoteIdent(HOSTILE_COLUMN)} VARCHAR(10))`,
    )
    await admin.query(`INSERT INTO ${DB}.${quoteIdent(HOSTILE_TABLE)} VALUES (1,'b'),(2,'a')`)
    await admin.query(`CREATE VIEW ${DB}.v_items AS SELECT id FROM ${DB}.items`)
    pool = await openTargetPool(
      { host: '127.0.0.1', port, username: 'root' },
      '127.0.0.1',
      'root',
      config,
    )
  })
  afterAll(async () => {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`)
    await admin.end()
  })

  test('lists databases and tables, marking views', async () => {
    expect((await listDatabases(pool)).map((d) => d.name)).toContain(DB)
    const tables = await listTables(pool, DB)
    expect(tables.map((t) => t.name)).toEqual(['items', HOSTILE_TABLE, 'v_items'].sort())
    expect(tables.find((t) => t.name === 'v_items')?.kind).toBe('view')
  })

  test('resolveTable rejects names the server does not report', async () => {
    await expect(resolveTable(pool, DB, 'nope')).rejects.toBeInstanceOf(NotFoundError)
    await expect(resolveTable(pool, DB, 'ITEMS')).rejects.toBeInstanceOf(NotFoundError)
    await expect(resolveTable(pool, "x' OR '1'='1", 'items')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('first page, cells escaped as data, binary and long values summarised', async () => {
    const t = await resolveTable(pool, DB, 'items')
    const r = await pageRows(pool, t, { page: 0, pageSize: 50 })
    expect(r.columns).toEqual(['id', 'name', 'note', 'blobby', 'big', 'meta'])
    expect(r.rows).toHaveLength(3)
    const first = r.rows[0]!
    expect(first[1]).toBe('<b>one</b>')
    expect(first[2]).toEqual({ cut: 'x'.repeat(500), length: 1200 })
    expect(first[3]).toEqual({ binary: 'deadbeef', size: 4 })
    expect(first[4]).toBe('9007199254740993')
    expect(r.rows[1]![2]).toBeNull()
    expect(r.sql).toContain('FROM `dbloom_it`.`items` LIMIT 50 OFFSET 0')
  })

  test('paging and sorting run on the server', async () => {
    const t = await resolveTable(pool, DB, 'items')
    const p1 = await pageRows(pool, t, { page: 1, pageSize: 1, sort: 'id', direction: 'desc' })
    expect(p1.rows.map((r) => Number(r[0]))).toEqual([2])
  })

  test('sorting by an unknown column is refused', async () => {
    const t = await resolveTable(pool, DB, 'items')
    await expect(
      pageRows(pool, t, { page: 0, pageSize: 10, sort: 'id; DROP TABLE items' }),
    ).rejects.toThrow()
  })

  test('page size is capped', async () => {
    const t = await resolveTable(pool, DB, 'items')
    const r = await pageRows(pool, t, { page: 0, pageSize: 10_000_000 })
    expect(r.sql).toContain('LIMIT 1000')
  })

  test('hostile table and column names work end to end', async () => {
    const t = await resolveTable(pool, DB, HOSTILE_TABLE)
    expect(t.columns.map((c) => c.name)).toEqual(['id', HOSTILE_COLUMN])
    const r = await pageRows(pool, t, { page: 0, pageSize: 10, sort: HOSTILE_COLUMN })
    expect(r.rows.map((row) => row[1])).toEqual(['a', 'b'])
  })

  test('views can be read', async () => {
    const t = await resolveTable(pool, DB, 'v_items')
    expect(t.kind).toBe('view')
    expect((await pageRows(pool, t, { page: 0, pageSize: 10 })).rows).toHaveLength(3)
  })
})
