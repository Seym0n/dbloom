import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { informationSchemaSource, schemaKey } from '~/server/assistant/schema-source'
import { parseId, parseMode, parsePoll, parseRename, parseResolve, parseSend } from '~/server/assistant/impl'
import { MESSAGE_MAX } from '~/server/assistant/service'
import type { TargetPool } from '~/server/db/target-pool'

// SPEC/34 task 4: schema reads on real servers, and the checks on the inputs of the server functions.

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
]
const DB = 'assistant_schema_scratch'

describe.each(servers)('schema source on $name', ({ port }) => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPool({ host: '127.0.0.1', port, user: 'root', password: 'root', connectionLimit: 3, charset: 'utf8mb4' })
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.query(`CREATE DATABASE ${DB}`)
    await pool.query(`CREATE TABLE ${DB}.customers (id INT PRIMARY KEY, email VARCHAR(120) NOT NULL, kind ENUM('a','b'), UNIQUE KEY uq_email (email))`)
    await pool.query(`CREATE TABLE ${DB}.orders (id INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2), KEY ix_c (customer_id))`)
    await pool.query(`CREATE VIEW ${DB}.v_customers AS SELECT id, email AS mail FROM ${DB}.customers`)
  })
  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.end()
  })
  const target = () => pool as unknown as TargetPool

  it('the outline lists tables and views with their columns, in order, and leaves system schemas out', async () => {
    const tables = (await informationSchemaSource.outline(target())).filter((t) => t.db === DB)
    expect(tables.map((t) => [t.table, t.view === true])).toEqual([['customers', false], ['orders', false], ['v_customers', true]])
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'email', 'kind'])
    expect(tables[0]!.columns[2]!.type).toBe("enum('a','b')")
    const all = await informationSchemaSource.outline(target())
    for (const sys of ['information_schema', 'mysql', 'performance_schema', 'sys']) expect(all.some((t) => t.db === sys)).toBe(false)
  })

  it('columns of named tables: types, keys, views; missing tables have no entry; several databases at once', async () => {
    const found = await informationSchemaSource.columns(target(), [
      { db: DB, table: 'customers' },
      { db: DB, table: 'v_customers' },
      { db: DB, table: 'nope' },
      { db: 'mysql', table: 'user' },
    ])
    expect(found.get(schemaKey(DB, 'customers'))).toMatchObject({ view: false })
    expect(found.get(schemaKey(DB, 'customers'))!.columns[0]).toMatchObject({ name: 'id', key: 'PRI' })
    expect(found.get(schemaKey(DB, 'customers'))!.columns[0]!.type).toMatch(/^int/)
    expect(found.get(schemaKey(DB, 'customers'))!.columns[1]).toMatchObject({ name: 'email', key: 'UNI' })
    expect(found.get(schemaKey(DB, 'v_customers'))).toMatchObject({ view: true, columns: [{ name: 'id' }, { name: 'mail' }] })
    expect(found.has(schemaKey(DB, 'nope'))).toBe(false)
    expect(found.has(schemaKey('mysql', 'user'))).toBe(true)
  })

  it('names are parameters: a quote or an injection in a name finds nothing and breaks nothing', async () => {
    const found = await informationSchemaSource.columns(target(), [{ db: `${DB}' OR '1'='1`, table: "x') OR ('1'='1" }])
    expect(found.size).toBe(0)
    expect((await informationSchemaSource.columns(target(), [])).size).toBe(0)
  })
})

describe('input checks of the server functions', () => {
  it('ids are plain; unknown keys are refused', () => {
    expect(parseId({ id: 'cv_0123abcd' })).toEqual({ id: 'cv_0123abcd' })
    for (const bad of [{}, { id: '' }, { id: 'a b' }, { id: '../x' }, { id: 'x'.repeat(65) }, { id: 'cv_1', extra: 1 }]) expect(() => parseId(bad), JSON.stringify(bad)).toThrow()
  })
  it('messages are 1 to the limit; the cursor is a whole number', () => {
    expect(parseSend({ id: 'a', text: 'hi' })).toEqual({ id: 'a', text: 'hi' })
    expect(() => parseSend({ id: 'a', text: '' })).toThrow()
    expect(() => parseSend({ id: 'a', text: 'x'.repeat(MESSAGE_MAX + 1) })).toThrow()
    expect(parsePoll({ id: 'a', after: 0 })).toEqual({ id: 'a', after: 0 })
    for (const bad of [{ id: 'a', after: -1 }, { id: 'a', after: 1.5 }, { id: 'a' }, { id: 'a', after: '3' }]) expect(() => parsePoll(bad)).toThrow()
  })
  it('a decision is approve or deny; a mode is manual or auto; titles are bounded', () => {
    expect(parseResolve({ id: 'a', callId: 'call_1', decision: 'approve' })).toBeTruthy()
    for (const bad of [{ id: 'a', callId: 'c', decision: 'maybe' }, { id: 'a', decision: 'deny' }, { id: 'a', callId: '', decision: 'deny' }]) expect(() => parseResolve(bad)).toThrow()
    expect(parseMode({ id: 'a', mode: 'auto' })).toBeTruthy()
    expect(() => parseMode({ id: 'a', mode: 'wild' })).toThrow()
    expect(() => parseRename({ id: 'a', title: '' })).toThrow()
    expect(() => parseRename({ id: 'a', title: 'x'.repeat(201) })).toThrow()
  })
})
