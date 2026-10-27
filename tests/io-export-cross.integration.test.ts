import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExport } from '~/server/io/export'
import { TempStore } from '~/server/io/temp'
import { exportRequest, MiB } from '~/server/io/types'
import { PRODUCTS, compareDatabases, containerOf, runDump } from './io-roundtrip-helpers'

// SCN-063, FR-IO-027: a MySQL export imports on MariaDB and the reverse, for the subset both products support.

const [mysql, mariadb] = PRODUCTS as [(typeof PRODUCTS)[number], (typeof PRODUCTS)[number]]
const containers = { mysql: containerOf(mysql.port), mariadb: containerOf(mariadb.port) }
const SRC = 'io_cross_src'
const DST = 'io_cross_dst'

describe.skipIf(!containers.mysql || !containers.mariadb)('export across products', () => {
  let pools: Record<'mysql' | 'mariadb', Pool>
  let temp: TempStore
  let root: string

  const open = (port: number) =>
    createPool({ host: '127.0.0.1', port, user: 'root', password: 'root', connectionLimit: 4, charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })

  beforeAll(async () => {
    pools = { mysql: open(mysql.port), mariadb: open(mariadb.port) }
    root = mkdtempSync(join(tmpdir(), 'io-cross-'))
    temp = new TempStore({ dir: root, quotaBytes: 1024 * MiB })
    for (const p of Object.values(pools)) {
      await p.query(`DROP DATABASE IF EXISTS ${SRC}`)
      await p.query(`DROP DATABASE IF EXISTS ${DST}`)
      await p.query(`CREATE DATABASE ${SRC} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
      const c = await p.getConnection()
      await c.query(`USE ${SRC}`)
      await c.query(
        `CREATE TABLE parent (id INT PRIMARY KEY, name VARCHAR(60), amount DECIMAL(12,4), at DATETIME(3), raw VARBINARY(20), note TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      )
      await c.query(
        `CREATE TABLE child (id INT PRIMARY KEY, pid INT NOT NULL, KEY (pid), CONSTRAINT fk_cross FOREIGN KEY (pid) REFERENCES parent (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
      )
      await c.query(`INSERT INTO parent VALUES (1, 'Ünïcode 日本 😀', 12345.6789, '2026-10-27 01:02:03.456', 0x00ff, 'a''b\\c\nd'), (2, NULL, -0.0001, NULL, '', NULL)`)
      await c.query('INSERT INTO child VALUES (10, 1), (11, 2)')
      await c.query('CREATE VIEW v_parent AS SELECT id, name FROM parent')
      c.release()
    }
  }, 60_000)

  afterAll(async () => {
    for (const p of Object.values(pools)) {
      await p.query(`DROP DATABASE IF EXISTS ${SRC}`)
      await p.query(`DROP DATABASE IF EXISTS ${DST}`)
      await p.end()
    }
    rmSync(root, { recursive: true, force: true })
  })

  const cases = [
    { from: 'mysql' as const, to: 'mariadb' as const },
    { from: 'mariadb' as const, to: 'mysql' as const },
  ]
  test.each(cases)('$from export imports on $to', async ({ from, to }) => {
    const target = PRODUCTS.find((p) => p.product === to)!
    const o = await runExport({
      pool: pools[from],
      temp,
      owner: { sessionId: 's', user: 'u' },
      request: exportRequest.parse({ scope: { kind: 'database', db: SRC }, format: 'sql', compression: 'none' }),
      limits: { maxExportBytes: 100 * MiB, jobMs: 60_000 },
      signal: new AbortController().signal,
      serverLabel: 'x',
      neutraliseFormulas: true,
    })
    expect(o.state, JSON.stringify(o.result)).toBe('done')
    const pool = pools[to]
    await pool.query(`DROP DATABASE IF EXISTS ${DST}`)
    await pool.query(`CREATE DATABASE ${DST} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    await runDump(containers[to]!, target.client, DST, readFileSync(o.file!.path, 'utf8'))
    const [rows] = await pool.query(`SELECT id, name, amount, at, HEX(raw) AS raw, note FROM ${DST}.parent ORDER BY id`)
    expect(rows).toEqual([
      { id: 1, name: 'Ünïcode 日本 😀', amount: '12345.6789', at: '2026-10-27 01:02:03.456', raw: '00FF', note: 'a\'b\c\nd' },
      { id: 2, name: null, amount: '-0.0001', at: null, raw: '', note: null },
    ])
    const [kids] = await pool.query(`SELECT COUNT(*) AS n FROM ${DST}.child c JOIN ${DST}.parent p ON p.id = c.pid`)
    expect(Number((kids as { n: unknown }[])[0]!.n)).toBe(2)
    const [views] = await pool.query(`SELECT COUNT(*) AS n FROM ${DST}.v_parent`)
    expect(Number((views as { n: unknown }[])[0]!.n)).toBe(2)
  }, 60_000)

  test('same-product comparison helper finds no difference after a restore on each product', async () => {
    for (const p of PRODUCTS) {
      const pool = pools[p.product]
      const o = await runExport({
        pool,
        temp,
        owner: { sessionId: 's', user: 'u' },
        request: exportRequest.parse({ scope: { kind: 'database', db: SRC }, format: 'sql', compression: 'none' }),
        limits: { maxExportBytes: 100 * MiB, jobMs: 60_000 },
        signal: new AbortController().signal,
        serverLabel: 'x',
        neutraliseFormulas: true,
      })
      await pool.query(`DROP DATABASE IF EXISTS ${DST}`)
      await pool.query(`CREATE DATABASE ${DST} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
      await runDump(containers[p.product]!, p.client, DST, readFileSync(o.file!.path, 'utf8'))
      expect(await compareDatabases(pool, SRC, DST)).toEqual([])
    }
  }, 60_000)
})
