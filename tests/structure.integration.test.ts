import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise'
import { lockWaitSeconds } from '~/server/structure/execute'
import type { Config } from '~/server/config'
import { openTargetPool, type TargetPool } from '~/server/db/target-pool'
import { createTokenIssuer } from '~/server/structure/deps'
import {
  fingerprint,
  introspectTable,
  readLists,
  readServerInfo,
} from '~/server/structure/introspect'
import { PlanStore } from '~/server/structure/plans'
import {
  executeImpl,
  parseExecuteInput,
  parsePreviewInput,
  previewImpl,
  type StructureEnv,
} from '~/server/structure/service'
import type { ColumnDef, PreviewInput, TableDefinition } from '~/server/structure/types'

/*
 * Observed server behaviour (filled from runs against the two test servers, spec 5.4 / 5.9 "verify" cells).
 * See the OBSERVATIONS block at the end of this file.
 */

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
] as const
const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const DB = 'structure_c_scratch'
const LIMITED = 'sc_limited'
const HOSTILE_TABLE = 'we`ird"; DROP TABLE x; -- ünï'
const HOSTILE_COLUMN = 'col`1\'"ü'

const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type,
  nullable: false,
  default: { kind: 'none' },
  ...extra,
})

function tableOf(
  name: string,
  columns: ColumnDef[],
  extra: Partial<TableDefinition> = {},
): PreviewInput {
  return {
    action: 'createTable',
    table: { db: DB, name, columns, indexes: [], fks: [], checks: [], ...extra },
  }
}

test('lock wait derives from the statement timeout, within 1 and 300 seconds', () => {
  expect(lockWaitSeconds(60_000)).toBe(48)
  expect(lockWaitSeconds(3000)).toBe(2)
  expect(lockWaitSeconds(500)).toBe(1)
  expect(lockWaitSeconds(0)).toBe(1)
  expect(lockWaitSeconds(86_400_000)).toBe(300)
})

describe.each(servers)('structure flow on $name', ({ port, product }) => {
  let admin: Connection
  let pool: TargetPool
  let limitedPool: TargetPool | undefined
  const tokens = createTokenIssuer()
  const plans = new PlanStore()
  const target = { host: '127.0.0.1', port, username: 'root' }

  const env = (over: Partial<StructureEnv> = {}, sessionId = 'session-a'): StructureEnv => ({
    session: { idHash: sessionId, target, pool },
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens,
    statementTimeoutMs: 20_000,
    plans,
    ...over,
  })

  /** Preview, then execute with the token when one was issued. */
  async function run(input: PreviewInput, e: StructureEnv = env()) {
    const preview = await previewImpl(e, input)
    const result = await executeImpl(e, {
      planId: preview.planId,
      ...(preview.confirmToken ? { confirmToken: preview.confirmToken } : {}),
    })
    return { preview, result }
  }

  const tableExists = async (name: string) => {
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB, name],
    )
    return rows.length > 0
  }
  const columnNames = async (name: string) => {
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [DB, name],
    )
    return rows.map((r) => String(r.c))
  }

  beforeAll(async () => {
    admin = await createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`DROP USER IF EXISTS '${LIMITED}'@'%'`)
    pool = await openTargetPool(target, '127.0.0.1', 'root', config)
  })
  afterAll(async () => {
    await limitedPool?.end()
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`DROP USER IF EXISTS '${LIMITED}'@'%'`)
    await admin.end()
  })

  test('DROP VIEW is chosen by the catalog, a wrong flag is refused', async () => {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``)
    await admin.query(`CREATE TABLE \`${DB}\`.vbase (id INT)`)
    await admin.query(`CREATE VIEW \`${DB}\`.vv AS SELECT id FROM \`${DB}\`.vbase`)
    await expect(previewImpl(env(), { action: 'dropTable', db: DB, table: 'vv' })).rejects.toThrow(
      /kind_mismatch/,
    )
    await expect(
      previewImpl(env(), { action: 'dropTable', db: DB, table: 'vbase', view: true }),
    ).rejects.toThrow(/kind_mismatch/)
    await expect(
      previewImpl(env(), { action: 'truncateTable', db: DB, table: 'vv' }),
    ).rejects.toThrow(/kind_mismatch/)
    const ran = await run({ action: 'dropTable', db: DB, table: 'vv', view: true })
    expect(ran.preview.statements[0]!.sql).toBe(`DROP VIEW \`${DB}\`.\`vv\``)
    expect(ran.result.ok).toBe(true)
    expect(await tableExists('vv')).toBe(false)
    expect(await tableExists('vbase')).toBe(true)
    await admin.query(`DROP DATABASE \`${DB}\``)
  })

  test('a metadata lock held elsewhere ends in a clean lock wait error (FR-STR-017)', async () => {
    const lockDb = `${DB}_lock`
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${lockDb}\``)
    await admin.query(`CREATE TABLE \`${lockDb}\`.held (id INT PRIMARY KEY)`)
    const holder = await createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
    })
    try {
      await holder.query('START TRANSACTION')
      await holder.query(`SELECT * FROM \`${lockDb}\`.held`) // shared metadata lock until commit
      const started = Date.now()
      const { result } = await run(
        { action: 'dropTable', db: lockDb, table: 'held', ignoreForeignKeys: true },
        env({ statementTimeoutMs: 3000 }), // lock wait = 2 s, before the 3 s watchdog
      )
      expect(Date.now() - started).toBeLessThan(2900)
      expect(result.ok).toBe(false)
      expect(result.results.map((r) => r.status)).toEqual(['executed', 'failed', 'not-run'])
      const failed = result.results[1]
      if (failed?.status !== 'failed') throw new Error('expected a failed statement')
      // observed: MySQL 8.4 and MariaDB 10.11 both report 1205 for a metadata lock wait
      expect(failed.error.errno).toBe(1205)
      expect(failed.error.hint).toMatch(/lock/i)
      expect(await admin.query(`SELECT 1 FROM \`${lockDb}\`.held`)).toBeTruthy()
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
      await admin.query(`DROP DATABASE IF EXISTS \`${lockDb}\``)
    }
  })

  test('the pooled connection does not keep the short lock wait', async () => {
    const before = await pool.query<RowDataPacket[]>('SELECT @@session.lock_wait_timeout AS v')
    await run({ action: 'createDatabase', name: `${DB}_lw` })
    const after = await pool.query<RowDataPacket[]>('SELECT @@session.lock_wait_timeout AS v')
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}_lw\``)
    expect(Number(after[0][0]!.v)).toBe(Number(before[0][0]!.v))
  })

  test('server info and form lists', async () => {
    const info = await readServerInfo(pool)
    expect(info.product).toBe(product)
    const lists = await readLists(pool)
    expect(lists.engines).toContain('InnoDB')
    expect(lists.charsets.find((c) => c.name === 'utf8mb4')).toBeTruthy()
    expect(lists.collations.some((c) => c.name === 'utf8mb4_unicode_ci')).toBe(true)
  })

  test('create database -> create table -> alter -> rename -> truncate -> drop', async () => {
    const created = await run({ action: 'createDatabase', name: DB })
    expect(created.preview.confirmRequired).toBe(false)
    expect(created.result.ok).toBe(true)

    const t1 = await run(
      tableOf(
        't1',
        [col('id', 'bigint', { autoIncrement: true }), col('name', 'varchar', { length: 50 })],
        { indexes: [{ kind: 'primary', parts: [{ column: 'id' }] }] },
      ),
    )
    expect(t1.result.ok).toBe(true)
    expect(await columnNames('t1')).toEqual(['id', 'name'])

    const add = await run({
      action: 'alterTable',
      db: DB,
      table: 't1',
      ops: [{ op: 'addColumn', column: col('note', 'text', { nullable: true }) }],
    })
    expect(add.preview.confirmRequired).toBe(false)
    expect(await columnNames('t1')).toEqual(['id', 'name', 'note'])

    const idx = await run({
      action: 'alterTable',
      db: DB,
      table: 't1',
      ops: [
        { op: 'addIndex', index: { name: 'idx_name', kind: 'index', parts: [{ column: 'name' }] } },
      ],
    })
    expect(idx.result.ok).toBe(true)
    const def = (await introspectTable(pool, DB, 't1')).def
    expect(def.indexes.map((i) => i.name ?? 'PRIMARY').sort()).toEqual(['PRIMARY', 'idx_name'])

    const dropIdx = await run({
      action: 'alterTable',
      db: DB,
      table: 't1',
      ops: [{ op: 'dropIndex', name: 'idx_name' }],
    })
    expect(dropIdx.result.ok).toBe(true)

    const dropCol = await previewImpl(env(), {
      action: 'alterTable',
      db: DB,
      table: 't1',
      ops: [{ op: 'dropColumn', name: 'note' }],
    })
    expect(dropCol.confirmRequired).toBe(true)
    expect(dropCol.confirmToken).toBeTruthy()
    const dropped = await executeImpl(env(), {
      planId: dropCol.planId,
      confirmToken: dropCol.confirmToken,
    })
    expect(dropped.ok).toBe(true)
    expect(await columnNames('t1')).toEqual(['id', 'name'])

    await admin.query(`INSERT INTO \`${DB}\`.t1 (name) VALUES ('a'), ('b')`)
    const renamed = await run({ action: 'renameTable', db: DB, table: 't1', newName: 't2' })
    expect(renamed.result.ok).toBe(true)
    expect(await tableExists('t1')).toBe(false)
    expect(await tableExists('t2')).toBe(true)

    const trunc = await previewImpl(env(), { action: 'truncateTable', db: DB, table: 't2' })
    expect(trunc.confirmName).toBe('t2')
    expect(
      (await executeImpl(env(), { planId: trunc.planId, confirmToken: trunc.confirmToken })).ok,
    ).toBe(true)
    const [cnt] = await admin.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM \`${DB}\`.t2`)
    expect(Number(cnt[0]?.n)).toBe(0)

    const drop = await previewImpl(env(), { action: 'dropTable', db: DB, table: 't2' })
    expect(drop.confirmName).toBe('t2')
    expect(
      (await executeImpl(env(), { planId: drop.planId, confirmToken: drop.confirmToken })).ok,
    ).toBe(true)
    expect(await tableExists('t2')).toBe(false)
  })

  test('a failing second statement reports executed / failed / not-run and keeps the first', async () => {
    const e = env()
    const plan = plans.create(e.session.idHash, {
      statements: [
        {
          sql: `CREATE TABLE \`${DB}\`.\`multi_a\` (id INT)`,
          kind: 'createTable',
          class: 'none',
          effect: 'x',
        },
        {
          sql: `RENAME TABLE \`${DB}\`.\`no_such_table\` TO \`${DB}\`.\`multi_b\``,
          kind: 'renameTable',
          class: 'none',
          effect: 'x',
        },
        {
          sql: `CREATE TABLE \`${DB}\`.\`multi_c\` (id INT)`,
          kind: 'createTable',
          class: 'none',
          effect: 'x',
        },
      ],
      warnings: [],
      statementsHash: 'h',
    })
    const out = await executeImpl(e, { planId: plan.planId })
    expect(out.ok).toBe(false)
    expect(out.results.map((r) => r.status)).toEqual(['executed', 'failed', 'not-run'])
    const failed = out.results[1]
    if (failed?.status !== 'failed') throw new Error('expected failure')
    expect(failed.error.errno).toBe(1146)
    expect(failed.error.hint).toBeTruthy()
    expect(failed.error.message).toContain('no_such_table')
    expect(await tableExists('multi_a')).toBe(true)
    expect(await tableExists('multi_c')).toBe(false)
    await admin.query(`DROP TABLE \`${DB}\`.multi_a`)
  })

  test('stale plan is refused and nothing runs', async () => {
    await run(tableOf('stale_t', [col('id', 'int')]))
    const preview = await previewImpl(env(), {
      action: 'alterTable',
      db: DB,
      table: 'stale_t',
      ops: [{ op: 'addColumn', column: col('x', 'int', { nullable: true }) }],
    })
    await admin.query(`ALTER TABLE \`${DB}\`.stale_t ADD COLUMN other INT NULL`)
    await expect(executeImpl(env(), { planId: preview.planId })).rejects.toThrow(/^stale_plan/)
    expect(await columnNames('stale_t')).toEqual(['id', 'other'])
    // The plan is spent: a second try answers plan_expired.
    await expect(executeImpl(env(), { planId: preview.planId })).rejects.toThrow(/^plan_expired/)
  })

  test('fingerprint is stable, ignores AUTO_INCREMENT counter, changes with the structure', async () => {
    await admin.query(
      `CREATE TABLE \`${DB}\`.fp (id INT AUTO_INCREMENT PRIMARY KEY, e ENUM('a','it''s') NOT NULL DEFAULT 'a', d DECIMAL(10,2) NULL, ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, c VARCHAR(10) NOT NULL DEFAULT 'x', UNIQUE KEY uq (c))`,
    )
    const a = (await introspectTable(pool, DB, 'fp')).def
    expect(a.columns.find((c) => c.name === 'e')?.values).toEqual(['a', "it's"])
    expect(a.columns.find((c) => c.name === 'd')).toMatchObject({
      type: 'decimal',
      precision: 10,
      scale: 2,
      nullable: true,
    })
    expect(a.columns.find((c) => c.name === 'ts')?.default).toMatchObject({
      kind: 'currentTimestamp',
    })
    expect(a.columns.find((c) => c.name === 'c')?.default).toEqual({ kind: 'literal', value: 'x' })
    expect(a.indexes.find((i) => i.name === 'uq')?.kind).toBe('unique')
    const before = fingerprint(a)
    await admin.query(`INSERT INTO \`${DB}\`.fp (c) VALUES ('1'),('2')`)
    expect(fingerprint((await introspectTable(pool, DB, 'fp')).def)).toBe(before)
    await admin.query(`ALTER TABLE \`${DB}\`.fp ADD COLUMN z INT NULL`)
    expect(fingerprint((await introspectTable(pool, DB, 'fp')).def)).not.toBe(before)
  })

  test('foreign keys and check constraints are read from the catalog', async () => {
    await admin.query(`CREATE TABLE \`${DB}\`.parent (id INT PRIMARY KEY)`)
    await admin.query(
      `CREATE TABLE \`${DB}\`.child (id INT PRIMARY KEY, pid INT NOT NULL, price INT, CONSTRAINT fk_p FOREIGN KEY (pid) REFERENCES parent(id) ON DELETE CASCADE, CONSTRAINT chk_price CHECK (price >= 0))`,
    )
    const def = (await introspectTable(pool, DB, 'child')).def
    expect(def.fks).toEqual([
      {
        name: 'fk_p',
        columns: ['pid'],
        refDb: DB,
        refTable: 'parent',
        refColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: product === 'mysql' ? 'no action' : 'restrict',
      },
    ])
    expect(def.checks.map((c) => c.name)).toEqual(['chk_price'])
  })

  test('drop of a referenced table fails with the server message; the FK-checks option restores the variable', async () => {
    const plain = await previewImpl(env(), { action: 'dropTable', db: DB, table: 'parent' })
    const failed = await executeImpl(env(), {
      planId: plain.planId,
      confirmToken: plain.confirmToken,
    })
    expect(failed.ok).toBe(false)
    const first = failed.results[0]
    if (first?.status !== 'failed') throw new Error('expected failure')
    expect([1451, 3730]).toContain(first.error.errno)
    expect(await tableExists('parent')).toBe(true)

    const forced = await run({
      action: 'dropTable',
      db: DB,
      table: 'parent',
      ignoreForeignKeys: true,
    })
    expect(forced.result.ok).toBe(true)
    expect(await tableExists('parent')).toBe(false)
    // every pooled connection has foreign_key_checks back at 1
    const conns = await Promise.all([1, 2, 3, 4].map(() => pool.getConnection()))
    for (const c of conns) {
      const [rows] = await c.query<RowDataPacket[]>('SELECT @@foreign_key_checks AS v')
      expect(Number(rows[0]?.v)).toBe(1)
    }
    conns.forEach((c) => c.release())
  })

  test('hard statement without token, with a replayed token, and with another plan token is refused', async () => {
    await admin.query(`CREATE TABLE \`${DB}\`.h1 (id INT)`)
    await admin.query(`CREATE TABLE \`${DB}\`.h2 (id INT)`)
    const p1 = await previewImpl(env(), { action: 'dropTable', db: DB, table: 'h1' })
    const p2 = await previewImpl(env(), { action: 'dropTable', db: DB, table: 'h2' })
    await expect(executeImpl(env(), { planId: p1.planId })).rejects.toThrow(/^token-missing/)
    await expect(
      executeImpl(env(), { planId: p1.planId, confirmToken: p2.confirmToken }),
    ).rejects.toThrow(/^token-invalid/)
    expect(await tableExists('h1')).toBe(true)
    // tampered
    await expect(
      executeImpl(env(), { planId: p1.planId, confirmToken: p1.confirmToken + 'x' }),
    ).rejects.toThrow(/^token-invalid/)
    // correct token works once
    expect(
      (await executeImpl(env(), { planId: p1.planId, confirmToken: p1.confirmToken })).ok,
    ).toBe(true)
    expect(await tableExists('h1')).toBe(false)
    // replay: plan is spent
    await expect(
      executeImpl(env(), { planId: p1.planId, confirmToken: p1.confirmToken }),
    ).rejects.toThrow(/^plan_expired/)
    // p2's token cannot be replayed onto a new plan for the same table either
    await admin.query(`CREATE TABLE \`${DB}\`.h1 (id INT)`)
    const p3 = await previewImpl(env(), { action: 'dropTable', db: DB, table: 'h1' })
    await expect(
      executeImpl(env(), { planId: p3.planId, confirmToken: p2.confirmToken }),
    ).rejects.toThrow(/^token-invalid/)
    await admin.query(`DROP TABLE \`${DB}\`.h1, \`${DB}\`.h2`)
  })

  test('a plan of another session answers plan_expired', async () => {
    const preview = await previewImpl(env(), tableOf('other_s', [col('id', 'int')]))
    await expect(executeImpl(env({}, 'session-b'), { planId: preview.planId })).rejects.toThrow(
      /^plan_expired/,
    )
    expect(await tableExists('other_s')).toBe(false)
  })

  test('read-only refuses execute before any connection use', async () => {
    const preview = await previewImpl(env(), tableOf('ro_t', [col('id', 'int')]))
    let uses = 0
    const trap = new Proxy(pool, {
      get(_t, prop) {
        uses++
        throw new Error(`pool used: ${String(prop)}`)
      },
    })
    for (const guard of [
      { forcedReadOnly: true, sessionReadOnly: false },
      { forcedReadOnly: false, sessionReadOnly: true },
    ]) {
      await expect(
        executeImpl(
          { ...env(), guard, session: { idHash: 'session-a', target, pool: trap } },
          { planId: preview.planId },
        ),
      ).rejects.toThrow(/^read-only/)
    }
    expect(uses).toBe(0)
    expect(await tableExists('ro_t')).toBe(false)
    // preview still works in a read-only session
    const ro = env({ guard: { forcedReadOnly: true, sessionReadOnly: false } })
    expect((await previewImpl(ro, tableOf('ro_t', [col('id', 'int')]))).statements).toHaveLength(1)
  })

  test('hostile table and column names', async () => {
    const created = await run(
      tableOf(HOSTILE_TABLE, [
        col('id', 'int'),
        col(HOSTILE_COLUMN, 'varchar', { length: 10, nullable: true }),
      ]),
    )
    expect(created.result.ok).toBe(true)
    expect(await columnNames(HOSTILE_TABLE)).toEqual(['id', HOSTILE_COLUMN])
    const def = (await introspectTable(pool, DB, HOSTILE_TABLE)).def
    expect(def.columns.map((c) => c.name)).toEqual(['id', HOSTILE_COLUMN])
    const renamed = await run({
      action: 'renameTable',
      db: DB,
      table: HOSTILE_TABLE,
      newName: 'h`2"',
    })
    expect(renamed.result.ok).toBe(true)
    const dropped = await run({ action: 'dropTable', db: DB, table: 'h`2"' })
    expect(dropped.result.ok).toBe(true)
    expect(await tableExists('h`2"')).toBe(false)
    // an existing-object name that the catalog does not hold is refused before the builder
    await expect(
      previewImpl(env(), { action: 'dropTable', db: DB, table: 'no`such' }),
    ).rejects.toThrow()
    await expect(
      previewImpl(env(), {
        action: 'alterTable',
        db: DB,
        table: 'no`such',
        ops: [{ op: 'dropIndex', name: 'x' }],
      }),
    ).rejects.toThrow()
  })

  test('system schemas are refused by name', async () => {
    await expect(previewImpl(env(), { action: 'dropDatabase', name: 'mysql' })).rejects.toThrow(
      /^system_schema/,
    )
    await expect(
      previewImpl(env(), { action: 'truncateTable', db: 'Information_Schema', table: 'tables' }),
    ).rejects.toThrow(/^system_schema/)
  })

  test('request bodies with raw SQL or unknown keys are rejected', () => {
    expect(() =>
      parsePreviewInput({ action: 'dropTable', db: 'a', table: 'b', sql: 'DROP DATABASE x' }),
    ).toThrow(/unknown field/)
    expect(() => parseExecuteInput({ planId: 'abcdefghij', sql: 'DROP' })).toThrow(/unknown field/)
    expect(() =>
      parsePreviewInput({
        action: 'createTable',
        table: {
          db: 'a',
          name: 'b',
          columns: [{ name: 'c', type: 'int', nullable: true, sql: 'x' }],
        },
      }),
    ).toThrow(/unknown field/)
    expect(parsePreviewInput({ action: 'dropTable', db: 'a', table: 'b' }).action).toBe('dropTable')
  })

  test('limited user: privilege errors are mapped with a hint and create nothing', async () => {
    await admin.query(`CREATE USER '${LIMITED}'@'%' IDENTIFIED BY 'limited-pw'`)
    await admin.query(`GRANT SELECT ON \`${DB}\`.* TO '${LIMITED}'@'%'`)
    limitedPool = await openTargetPool(
      { host: '127.0.0.1', port, username: LIMITED },
      '127.0.0.1',
      'limited-pw',
      config,
    )
    const e = env(
      {
        session: {
          idHash: 'session-lim',
          target: { ...target, username: LIMITED },
          pool: limitedPool,
        },
      },
      'session-lim',
    )
    const create = await run(tableOf('lim_t', [col('id', 'int')]), e)
    expect(create.result.ok).toBe(false)
    const r = create.result.results[0]
    if (r?.status !== 'failed') throw new Error('expected failure')
    expect(r.error.errno).toBe(1142)
    expect(r.error.hint).toMatch(/privilege/)
    expect(JSON.stringify(r.error)).not.toContain('limited-pw')
    expect(await tableExists('lim_t')).toBe(false)

    const dropDb = await previewImpl(e, { action: 'dropDatabase', name: DB })
    const dropped = await executeImpl(e, {
      planId: dropDb.planId,
      confirmToken: dropDb.confirmToken,
    })
    const d = dropped.results[0]
    if (d?.status !== 'failed') throw new Error('expected failure')
    expect(d.error.errno).toBe(1044)
    expect(await tableExists('stale_t')).toBe(true)
  })

  test('privileges observed for RENAME / ALTER / FK (recorded, see OBSERVATIONS)', async () => {
    const grants = async (privs: string) => {
      await admin.query(`REVOKE ALL PRIVILEGES ON \`${DB}\`.* FROM '${LIMITED}'@'%'`)
      await admin.query(`GRANT ${privs} ON \`${DB}\`.* TO '${LIMITED}'@'%'`)
    }
    const errnoOf = async (sql: string): Promise<number | 'ok'> => {
      try {
        await limitedPool!.query(sql)
        return 'ok'
      } catch (error) {
        return (error as { errno: number }).errno
      }
    }
    await admin.query(`CREATE TABLE \`${DB}\`.pv (id INT PRIMARY KEY, a INT)`)
    await admin.query(`CREATE TABLE \`${DB}\`.pv_ref (id INT PRIMARY KEY)`)
    const seen: Record<string, number | 'ok'> = {}
    await grants('SELECT, ALTER, DROP')
    seen['rename needs ALTER+DROP (no CREATE/INSERT)'] = await errnoOf(
      `RENAME TABLE \`${DB}\`.pv TO \`${DB}\`.pv2`,
    )
    await grants('SELECT, ALTER, DROP, CREATE, INSERT')
    seen['rename with ALTER+DROP+CREATE+INSERT'] = await errnoOf(
      `RENAME TABLE \`${DB}\`.pv TO \`${DB}\`.pv2`,
    )
    await admin.query(`RENAME TABLE \`${DB}\`.pv2 TO \`${DB}\`.pv`)
    await grants('SELECT, ALTER')
    seen['alter add column with ALTER'] = await errnoOf(
      `ALTER TABLE \`${DB}\`.pv ADD COLUMN b INT NULL`,
    )
    seen['alter add index with ALTER only'] = await errnoOf(
      `ALTER TABLE \`${DB}\`.pv ADD INDEX ia (a)`,
    )
    seen['alter add FK with ALTER only (no REFERENCES)'] = await errnoOf(
      `ALTER TABLE \`${DB}\`.pv ADD CONSTRAINT fk1 FOREIGN KEY (a) REFERENCES \`${DB}\`.pv_ref(id)`,
    )
    await admin.query(`ALTER TABLE \`${DB}\`.pv DROP FOREIGN KEY fk1`).catch(() => undefined)
    await grants('SELECT, ALTER, REFERENCES')
    seen['alter add FK with ALTER+REFERENCES'] = await errnoOf(
      `ALTER TABLE \`${DB}\`.pv ADD CONSTRAINT fk1 FOREIGN KEY (a) REFERENCES \`${DB}\`.pv_ref(id)`,
    )
    await grants('SELECT, DROP')
    seen['truncate with DROP'] = await errnoOf(`TRUNCATE TABLE \`${DB}\`.pv`)
    await admin.query(`DROP TABLE IF EXISTS \`${DB}\`.pv, \`${DB}\`.pv_ref`)
    console.log(`OBSERVED privileges on ${product}: ${JSON.stringify(seen)}`)
    // 1142 table-level, 1044 db-level denial; the exact numbers differ between products.
    expect(Object.keys(seen)).toHaveLength(7)
  })

  test('capability probes: which syntax each product accepts (recorded, see OBSERVATIONS)', async () => {
    await admin.query(
      `CREATE TABLE \`${DB}\`.cap (id INT PRIMARY KEY, price INT, v INT, KEY ix (v), CONSTRAINT chk_p CHECK (price >= 0))`,
    )
    const t = `\`${DB}\`.cap`
    const tryIt = async (sql: string): Promise<string> => {
      try {
        await admin.query(sql)
        return 'ok'
      } catch (error) {
        return `err ${(error as { errno: number }).errno}`
      }
    }
    const seen: Record<string, string> = {}
    const violation = await admin
      .query(`INSERT INTO ${t} (id, price) VALUES (1, -1)`)
      .catch((e: { errno: number }) => e.errno)
    seen['CHECK violation errno'] = String(violation)
    seen['RENAME COLUMN'] = await tryIt(`ALTER TABLE ${t} RENAME COLUMN v TO v2`)
    seen['DROP CONSTRAINT (check)'] = await tryIt(`ALTER TABLE ${t} DROP CONSTRAINT chk_p`)
    await tryIt(`ALTER TABLE ${t} ADD CONSTRAINT chk_p CHECK (price >= 0)`)
    seen['DROP CHECK'] = await tryIt(`ALTER TABLE ${t} DROP CHECK chk_p`)
    await tryIt(`ALTER TABLE ${t} ADD CONSTRAINT chk_p CHECK (price >= 0)`)
    seen['ALTER CHECK NOT ENFORCED'] = await tryIt(
      `ALTER TABLE ${t} ALTER CHECK chk_p NOT ENFORCED`,
    )
    seen['ALTER INDEX INVISIBLE'] = await tryIt(`ALTER TABLE ${t} ALTER INDEX ix INVISIBLE`)
    seen['ALTER INDEX IGNORED'] = await tryIt(`ALTER TABLE ${t} ALTER INDEX ix IGNORED`)
    seen['generated VIRTUAL'] = await tryIt(
      `ALTER TABLE ${t} ADD COLUMN g1 INT GENERATED ALWAYS AS (price + 1) VIRTUAL`,
    )
    seen['generated STORED'] = await tryIt(
      `ALTER TABLE ${t} ADD COLUMN g2 INT GENERATED ALWAYS AS (price + 1) STORED`,
    )
    seen['generated PERSISTENT'] = await tryIt(
      `ALTER TABLE ${t} ADD COLUMN g3 INT GENERATED ALWAYS AS (price + 1) PERSISTENT`,
    )
    seen['type UUID'] = await tryIt(`ALTER TABLE ${t} ADD COLUMN u UUID NULL`)
    seen['type INET6'] = await tryIt(`ALTER TABLE ${t} ADD COLUMN i6 INET6 NULL`)
    seen['type JSON'] = await tryIt(`ALTER TABLE ${t} ADD COLUMN j JSON NULL`)
    seen['INVISIBLE column'] = await tryIt(`ALTER TABLE ${t} ADD COLUMN hid INT NULL INVISIBLE`)
    console.log(`OBSERVED capabilities on ${product}: ${JSON.stringify(seen)}`)
    expect(seen['CHECK violation errno']).toBe(product === 'mysql' ? '3819' : '4025')
    expect(seen['DROP CONSTRAINT (check)']).toBe('ok')
    await admin.query(`DROP TABLE ${t}`)
  })

  test('drop database through the flow (typed name is the UI side; token is the server side)', async () => {
    const p = await previewImpl(env(), { action: 'dropDatabase', name: DB })
    expect(p.confirmName).toBe(DB)
    expect(p.confirmRequired).toBe(true)
    await expect(executeImpl(env(), { planId: p.planId })).rejects.toThrow(/^token-missing/)
    expect((await executeImpl(env(), { planId: p.planId, confirmToken: p.confirmToken })).ok).toBe(
      true,
    )
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [DB],
    )
    expect(rows).toHaveLength(0)
  })
})

describe('plan store', () => {
  test('plans expire after 10 minutes, are session-bound and single use', () => {
    let now = 1_000
    const store = new PlanStore(() => now)
    const base = { statements: [], warnings: [], statementsHash: 'h' }
    const plan = store.create('s1', base)
    expect(plan.planId.length).toBeGreaterThanOrEqual(22)
    expect(store.get('s2', plan.planId)).toBeUndefined()
    expect(store.get('s1', plan.planId)).toBeDefined()
    now += 10 * 60_000 - 1
    expect(store.get('s1', plan.planId)).toBeDefined()
    now += 1
    expect(store.get('s1', plan.planId)).toBeUndefined()
    const other = store.create('s1', base)
    store.consume(other.planId)
    expect(store.get('s1', other.planId)).toBeUndefined()
    store.create('s1', base)
    store.create('s2', base)
    store.dropSession('s1')
    expect(store.size).toBe(1)
  })
})

/*
 * OBSERVATIONS (2026-10-23, MySQL 8.4 and MariaDB 10.11 test servers):
 * Privileges (limited user, grants on the scratch db only)
 *   RENAME TABLE in same db: needs ALTER+DROP+CREATE+INSERT on both; ALTER+DROP alone gives 1142 on both.
 *   ALTER ADD COLUMN: ALTER only suffices on both. ADD INDEX: ALTER only suffices on both.
 *   ADD FOREIGN KEY: MySQL needs REFERENCES (ALTER alone -> 1142); MariaDB accepts ALTER alone.
 *   TRUNCATE: DROP alone suffices on both (on a table that no FK references; a referenced one gives 1701).
 *   Create with only SELECT: 1142; DROP DATABASE without DROP: 1044 (both).
 * Capabilities
 *   RENAME COLUMN: ok on both.  DROP CONSTRAINT <check>: ok on both.  DROP CHECK: MySQL ok, MariaDB 1064.
 *   ALTER CHECK ... NOT ENFORCED: MySQL ok, MariaDB 1064.  CHECK violation: MySQL 3819, MariaDB 4025.
 *   ALTER INDEX ... INVISIBLE: MySQL ok, MariaDB 1064.  ALTER INDEX ... IGNORED: MariaDB ok, MySQL 1064.
 *   Generated VIRTUAL/STORED: ok on both; PERSISTENT: MariaDB only.
 *   UUID and INET6 types: MariaDB only.  JSON: both.  INVISIBLE column: ok on both.
 *   FK rule left unspecified is reported as NO ACTION by MySQL and RESTRICT by MariaDB.
 */
