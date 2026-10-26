import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConnection, type Connection } from 'mysql2/promise'
import type { Config } from '~/server/config'
import { openTargetPool, type TargetPool } from '~/server/db/target-pool'
import { defaultPorts } from '~/server/rows/default-ports'
import { boundsFromEnv } from '~/server/rows/limits'
import { MemoryPrefs } from '~/server/rows/prefs'
import { CellHandleStore, UploadStore } from '~/server/rows/blob'
import { lookupImpl, referencingRowsImpl, type RowsEnv } from '~/server/rows/service'
import { createTokenIssuer } from '~/server/structure/deps'
import { PlanStore } from '~/server/structure/plans'
import { RunRegistry } from '~/server/sql/registry'

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
] as const
const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const DB = 'rows_lookup_scratch'

const v = (s: string) => ({ t: 'v' as const, v: s })

describe.each(servers)('lookupRows and referencingRows on $name', ({ port }) => {
  let admin: Connection
  let pool: TargetPool
  const target = { host: '127.0.0.1', port, username: 'root' }
  const tokens = createTokenIssuer()

  const env = (): RowsEnv => ({
    session: { idHash: 'sess-lookup', target, pool },
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens,
    statementTimeoutMs: 20_000,
    ports: defaultPorts,
    prefs: new MemoryPrefs(),
    ownerKey: 'owner',
    targetKey: 'target',
    stateless: true,
    bounds: boundsFromEnv({}),
    plans: new PlanStore(),
    handles: new CellHandleStore(),
    uploads: new UploadStore(),
    counts: new RunRegistry(),
  })
  const t = (name: string) => `\`${DB}\`.\`${name}\``

  beforeAll(async () => {
    admin = await createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      multipleStatements: true,
    })
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`)
    await admin.query(`
      CREATE TABLE ${t('customer')} (id INT PRIMARY KEY, name VARCHAR(60) NOT NULL) ENGINE=InnoDB;
      CREATE TABLE ${t('orders')} (id INT PRIMARY KEY, customer_id INT NOT NULL,
        CONSTRAINT fk_o_c FOREIGN KEY (customer_id) REFERENCES ${t('customer')}(id)) ENGINE=InnoDB;
      CREATE TABLE ${t('notes')} (id INT PRIMARY KEY, customer_id INT NULL,
        CONSTRAINT fk_n_c FOREIGN KEY (customer_id) REFERENCES ${t('customer')}(id)) ENGINE=InnoDB;
      CREATE TABLE ${t('region')} (country CHAR(2) NOT NULL, code CHAR(3) NOT NULL, label VARCHAR(40) NOT NULL,
        PRIMARY KEY (country, code)) ENGINE=InnoDB;
      CREATE TABLE ${t('site')} (id INT PRIMARY KEY, country CHAR(2) NOT NULL, code CHAR(3) NOT NULL,
        CONSTRAINT fk_s_r FOREIGN KEY (country, code) REFERENCES ${t('region')}(country, code)) ENGINE=InnoDB;
    `)
    const customers = Array.from({ length: 60 }, (_, i) => [
      i + 1,
      i === 1 ? '100% Bob' : i === 2 ? '100x Cy' : `Cust ${String(i + 1).padStart(2, '0')}`,
    ])
    await admin.query(`INSERT INTO ${t('customer')} VALUES ?`, [customers])
    await admin.query(`INSERT INTO ${t('orders')} VALUES (1, 2), (2, 2), (3, 5)`)
    await admin.query(`INSERT INTO ${t('notes')} VALUES (1, 2)`)
    await admin.query(
      `INSERT INTO ${t('region')} VALUES ('DE','BAY','Bavaria'), ('DE','BER','Berlin'), ('FR','IDF','Ile-de-France')`,
    )
    await admin.query(
      `INSERT INTO ${t('site')} VALUES (1,'DE','BAY'), (2,'DE','BAY'), (3,'FR','IDF')`,
    )
    pool = await openTargetPool(target, '127.0.0.1', 'root', config)
  })

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => undefined)
    await admin?.end().catch(() => undefined)
  })

  describe('lookupRows', () => {
    test('pages of 50 with a next flag, display value from the first character column', async () => {
      const first = await lookupImpl(env(), { db: DB, table: 'orders', fk: 'fk_o_c', page: 0 })
      expect(first.options).toHaveLength(50)
      expect(first.hasNext).toBe(true)
      expect(first.options[0]?.key).toEqual({ id: '1' })
      expect(first.options[0]?.display).toContain('Cust 01')
      const second = await lookupImpl(env(), { db: DB, table: 'orders', fk: 'fk_o_c', page: 1 })
      expect(second.options).toHaveLength(10)
      expect(second.hasNext).toBe(false)
    })

    test('searches the display value and the key, server side', async () => {
      const byName = await lookupImpl(env(), {
        db: DB,
        table: 'orders',
        fk: 'fk_o_c',
        page: 0,
        query: 'Cust 59',
      })
      expect(byName.options.map((o) => o.key.id)).toEqual(['59'])
      const byKey = await lookupImpl(env(), {
        db: DB,
        table: 'orders',
        fk: 'fk_o_c',
        page: 0,
        query: '42',
      })
      expect(byKey.options.map((o) => o.key.id)).toContain('42')
    })

    test('LIKE wildcards typed by the user match literally', async () => {
      const percent = await lookupImpl(env(), {
        db: DB,
        table: 'orders',
        fk: 'fk_o_c',
        page: 0,
        query: '100%',
      })
      expect(percent.options.map((o) => o.key.id)).toEqual(['2'])
      const underscore = await lookupImpl(env(), {
        db: DB,
        table: 'orders',
        fk: 'fk_o_c',
        page: 0,
        query: '100_',
      })
      expect(underscore.options).toEqual([])
    })

    test('display values for given keys, one request', async () => {
      const r = await lookupImpl(env(), {
        db: DB,
        table: 'orders',
        fk: 'fk_o_c',
        page: 0,
        keys: [{ id: v('2') }, { id: v('5') }, { id: v('9999') }],
      })
      expect(r.options.map((o) => o.key.id).sort()).toEqual(['2', '5'])
    })

    test('a composite key returns every key column', async () => {
      const r = await lookupImpl(env(), {
        db: DB,
        table: 'site',
        fk: 'fk_s_r',
        page: 0,
        query: 'Bavaria',
      })
      expect(r.options).toHaveLength(1)
      expect(r.options[0]?.key).toEqual({ country: 'DE', code: 'BAY' })
      expect(r.options[0]?.display).toContain('Bavaria')
    })

    test('an unknown foreign key or table is refused', async () => {
      await expect(
        lookupImpl(env(), { db: DB, table: 'orders', fk: 'nope', page: 0 }),
      ).rejects.toThrow(/unknown-column/)
      await expect(
        lookupImpl(env(), { db: DB, table: 'missing', fk: 'x', page: 0 }),
      ).rejects.toThrow(/unknown-table/)
    })
  })

  describe('referencingRows', () => {
    test('one group per referencing table and foreign key, with counts', async () => {
      const r = await referencingRowsImpl(env(), { db: DB, table: 'customer', key: { id: v('2') } })
      const byTable = Object.fromEntries(r.groups.map((g) => [g.table, g]))
      expect(Object.keys(byTable).sort()).toEqual(['notes', 'orders'])
      expect(byTable.orders).toMatchObject({
        db: DB,
        fk: 'fk_o_c',
        columns: ['customer_id'],
        count: 2,
        atLeast: false,
      })
      expect(byTable.notes).toMatchObject({ count: 1 })
    })

    test('a row nobody refers to, and a row that does not exist, have no groups', async () => {
      const none = await referencingRowsImpl(env(), {
        db: DB,
        table: 'customer',
        key: { id: v('7') },
      })
      expect(none.groups).toEqual([])
      const gone = await referencingRowsImpl(env(), {
        db: DB,
        table: 'customer',
        key: { id: v('9999') },
      })
      expect(gone.groups).toEqual([])
    })

    test('a composite key counts only rows that match every key column', async () => {
      const bay = await referencingRowsImpl(env(), {
        db: DB,
        table: 'region',
        key: { country: v('DE'), code: v('BAY') },
      })
      expect(bay.groups).toHaveLength(1)
      expect(bay.groups[0]).toMatchObject({ table: 'site', columns: ['country', 'code'], count: 2 })
      const ber = await referencingRowsImpl(env(), {
        db: DB,
        table: 'region',
        key: { country: v('DE'), code: v('BER') },
      })
      expect(ber.groups).toEqual([])
    })

    test('a key that is not the identity of the table is refused', async () => {
      await expect(
        referencingRowsImpl(env(), { db: DB, table: 'customer', key: { name: v('x') } }),
      ).rejects.toThrow()
    })
  })
})
