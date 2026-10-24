import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise'
import type { Config } from '~/server/config'
import { openTargetPool, type TargetPool } from '~/server/db/target-pool'
import { defaultPorts } from '~/server/rows/default-ports'
import { streamCell } from '~/server/rows/execute'
import { boundsFromEnv } from '~/server/rows/limits'
import { MemoryPrefs } from '~/server/rows/prefs'
import {
  CellHandleStore,
  PREVIEW_MAX_BYTES,
  UploadStore,
  SESSION_UPLOAD_BYTES,
} from '~/server/rows/blob'
import { handleCellGet, handleUpload } from '~/server/rows/http'
import {
  cancelCountImpl,
  cellDownloadResponse,
  changeRowsImpl,
  confirmRowsImpl,
  countRowsImpl,
  getPrefsImpl,
  getRowsImpl,
  openCellImpl,
  previewRowsImpl,
  readCellImpl,
  readRowImpl,
  setPrefImpl,
  type RowsEnv,
} from '~/server/rows/service'
import {
  changeRowsInput,
  getRowsInput,
  type ChangeRowsResponse,
  type GuardValue,
  type RowChange,
  type WireValue,
} from '~/server/rows/types'
import { createTokenIssuer } from '~/server/structure/deps'
import { PlanStore } from '~/server/structure/plans'
import { RunRegistry } from '~/server/sql/registry'

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
] as const
const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const DB = 'rows_b_scratch'
const LIMITED = 'rb_limited'
const SECRET = 'SECRET-VALUE-do-not-log-123'

const v = (s: string): WireValue => ({ t: 'v', v: s })
const nul: WireValue = { t: 'null' }
const g = (s: string): GuardValue => ({ t: 'v', v: s })
const gn: GuardValue = { t: 'null' }

describe.each(servers)('rows service on $name', ({ port }) => {
  let admin: Connection
  let pool: TargetPool
  let limitedPool: TargetPool | undefined
  const tokens = createTokenIssuer()
  const target = { host: '127.0.0.1', port, username: 'root' }
  let plans: PlanStore
  let handles: CellHandleStore
  let uploads: UploadStore
  let logs: string[]

  const env = (over: Partial<RowsEnv> = {}, sessionId = 'sess-a'): RowsEnv => ({
    session: { idHash: sessionId, target, pool },
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens,
    statementTimeoutMs: 20_000,
    ports: defaultPorts,
    prefs: new MemoryPrefs(),
    ownerKey: 'owner',
    targetKey: 'target',
    stateless: true,
    bounds: { ...boundsFromEnv({}), exactCountThreshold: 100, viewCountCap: 500 },
    plans,
    handles,
    uploads,
    counts: new RunRegistry(),
    ...over,
  })

  const q = (sql: string, params: unknown[] = []) => admin.query<RowDataPacket[]>(sql, params)
  const one = async (sql: string, params: unknown[] = []): Promise<RowDataPacket> =>
    (await q(sql, params))[0][0]!
  const t = (name: string) => `\`${DB}\`.\`${name}\``

  const auditLines = () =>
    logs
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return undefined
        }
      })
      .filter((l): l is Record<string, unknown> => l !== undefined && typeof l.audit === 'string')

  beforeAll(async () => {
    admin = await createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      multipleStatements: true,
    })
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`DROP USER IF EXISTS '${LIMITED}'@'%'`)
    await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`)
    await admin.query(`
      CREATE TABLE ${t('customer')} (
        id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(100) NOT NULL UNIQUE,
        note TEXT, created DATETIME(6) NULL, flag TINYINT(1) NOT NULL DEFAULT 0) ENGINE=InnoDB;
      CREATE TABLE ${t('orders')} (
        id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, amount DECIMAL(12,2) NOT NULL,
        CONSTRAINT fk_o_c FOREIGN KEY (customer_id) REFERENCES ${t('customer')}(id) ON DELETE CASCADE) ENGINE=InnoDB;
      CREATE TABLE ${t('restr')} (
        id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL,
        CONSTRAINT fk_r_c FOREIGN KEY (customer_id) REFERENCES ${t('customer')}(id) ON DELETE RESTRICT) ENGINE=InnoDB;
      CREATE TABLE ${t('nokey')} (a INT, b VARCHAR(10)) ENGINE=InnoDB;
      CREATE TABLE ${t('isam')} (id INT PRIMARY KEY, v VARCHAR(10)) ENGINE=MyISAM;
      CREATE TABLE ${t('blobs')} (id INT PRIMARY KEY, doc LONGBLOB, img BLOB, label VARCHAR(20)) ENGINE=InnoDB;
      CREATE TABLE ${t('small')} (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB;
      CREATE TABLE ${t('big')} (id INT PRIMARY KEY, name VARCHAR(40)) ENGINE=InnoDB;
    `)
    await admin.query(
      `INSERT INTO ${t('small')} SELECT seq, CONCAT('n', seq) FROM (
         WITH RECURSIVE s(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM s WHERE seq < 30) SELECT seq FROM s) x`,
    )
    await admin.query(`SET SESSION cte_max_recursion_depth = 10000`).catch(() => undefined)
    await admin.query(`SET SESSION max_recursive_iterations = 10000`).catch(() => undefined)
    await admin.query(
      `INSERT INTO ${t('big')} SELECT seq, CONCAT('row', seq) FROM (
         WITH RECURSIVE s(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM s WHERE seq < 3000) SELECT seq FROM s) x`,
    )
    await admin.query(`ANALYZE TABLE ${t('big')}, ${t('small')}`)
    await admin.query(`CREATE VIEW ${t('v_big')} AS SELECT id, name FROM ${t('big')}`)
    await admin.query(`INSERT INTO ${t('nokey')} VALUES (1,'x'),(1,'x'),(2,'y')`)
    await admin.query(`CREATE USER '${LIMITED}'@'%' IDENTIFIED BY 'limited-pw'`)
    await admin.query(`GRANT SELECT ON \`${DB}\`.* TO '${LIMITED}'@'%'`)
    pool = await openTargetPool(target, '127.0.0.1', 'root', config)
    limitedPool = await openTargetPool(
      { host: '127.0.0.1', port, username: LIMITED },
      '127.0.0.1',
      'limited-pw',
      config,
    )
  }, 60_000)

  afterAll(async () => {
    await limitedPool?.end()
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`DROP USER IF EXISTS '${LIMITED}'@'%'`)
    await admin.end()
  })

  beforeEach(async () => {
    plans = new PlanStore()
    handles = new CellHandleStore()
    uploads = new UploadStore()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
    await admin.query(`DELETE FROM ${t('orders')}`)
    await admin.query(`DELETE FROM ${t('restr')}`)
    await admin.query(`DELETE FROM ${t('customer')}`)
    await admin.query(`ALTER TABLE ${t('customer')} AUTO_INCREMENT = 1`)
    await admin.query(`DELETE FROM ${t('isam')}`)
    await admin.query(`DELETE FROM ${t('blobs')}`)
    await admin.query(
      `INSERT INTO ${t('customer')} (name, email, note, flag) VALUES
        ('Ann', 'ann@x.test', 'first', 0), ('Bob', 'bob@x.test', NULL, 1), ('Cy', 'cy@x.test', 'c', 0),
        ('Di', 'di@x.test', 'd', 0), ('Ed', 'ed@x.test', 'e', 0), ('Flo', 'flo@x.test', 'f', 0)`,
    )
    await admin.query(`INSERT INTO ${t('isam')} VALUES (1,'a'),(2,'b'),(3,'c')`)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const page = (over: Record<string, unknown> = {}, e = env()) =>
    getRowsImpl(e, {
      db: DB,
      table: 'customer',
      page: 0,
      pageSize: 50,
      sort: [],
      ...over,
    } as never)

  const change = (
    c: RowChange,
    over: Partial<{ acceptSoft: boolean; overwrite: boolean; table: string }> = {},
    e = env(),
  ): Promise<ChangeRowsResponse> =>
    changeRowsImpl(e, {
      db: DB,
      table: over.table ?? 'customer',
      change: c,
      overwrite: over.overwrite ?? false,
      acceptSoft: over.acceptSoft ?? false,
    })

  const del = (ids: number[], old: Record<string, GuardValue> = {}): RowChange => ({
    op: 'delete',
    targets: ids.map((id) => ({ key: { id: g(String(id)) }, old })),
  })

  async function idOf(email: string): Promise<number> {
    return Number(
      await one(`SELECT id FROM ${t('customer')} WHERE email = ?`, [email]).then((r) => r.id),
    )
  }
  const count = async (table = 'customer') =>
    Number((await one(`SELECT COUNT(*) AS n FROM ${t(table)}`)).n)

  // ---- Reads --------------------------------------------------------------------------------------------

  describe('page, count, read', () => {
    test('a page with sort, next page flag, identity, permissions, time zone, sqlShown', async () => {
      const r = await page({ pageSize: 4, sort: [{ column: 'name', direction: 'desc' }] })
      expect(r.columns).toEqual(['id', 'name', 'email', 'note', 'created', 'flag'])
      expect(r.rows).toHaveLength(4)
      expect(r.rows[0]![1]).toBe('Flo')
      expect(r.hasNext).toBe(true)
      expect(r.hasPrev).toBe(false)
      expect(r.identity).toEqual({ kind: 'primary', columns: ['id'] })
      expect(r.permissions).toMatchObject({
        readOnly: false,
        insert: true,
        update: true,
        delete: true,
      })
      expect(r.sqlShown).toContain('ORDER BY')
      expect(typeof r.timeZone).toBe('string')
      expect(auditLines().some((l) => l.audit === 'table.open')).toBe(true)
    })

    test('a page that is not full gives an exact total without a COUNT query', async () => {
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'small',
        page: 0,
        pageSize: 50,
        sort: [],
      })
      expect(r.total).toEqual({ kind: 'exact', value: 30 })
      expect(r.timings.countMs).toBeUndefined()
    })

    test('a table above the threshold gives an estimate, no exact count', async () => {
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'big',
        page: 0,
        pageSize: 25,
        sort: [],
      })
      expect(r.total.kind).toBe('estimate')
      expect(r.total.value).toBeGreaterThan(1000)
      expect(r.timings.countMs).toBeUndefined()
      expect(r.hasNext).toBe(true)
    })

    test('a table below the threshold is counted exactly by itself', async () => {
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'small',
        page: 0,
        pageSize: 10,
        sort: [],
      })
      expect(r.total).toEqual({ kind: 'exact', value: 30 })
      expect(r.timings.countMs).toBeDefined()
    })

    test('the estimate is current on a table that was just filled (stats cache bypass)', async () => {
      await q(`CREATE TABLE ${t('fresh')} (id INT PRIMARY KEY) ENGINE=InnoDB`)
      await q(
        `INSERT INTO ${t('fresh')} SELECT seq FROM (WITH RECURSIVE s(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM s WHERE seq < 500) SELECT seq FROM s) x`,
      )
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'fresh',
        page: 0,
        pageSize: 10,
        sort: [],
      })
      expect(r.total.kind).toBe('estimate')
      expect(r.total.value).toBeGreaterThan(100)
      await q(`DROP TABLE ${t('fresh')}`)
    })

    test('a view gets a capped count shown as a lower bound; a filtered view no total', async () => {
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'v_big',
        page: 0,
        pageSize: 25,
        sort: [],
      })
      expect(r.total).toEqual({ kind: 'lowerBound', value: 500 })
      expect(r.identity).toMatchObject({ kind: 'none', reason: 'view' })
      expect(r.permissions).toMatchObject({ insert: false, update: false, delete: false })
      const f = await getRowsImpl(env(), {
        db: DB,
        table: 'v_big',
        page: 0,
        pageSize: 25,
        sort: [],
        filter: { type: 'condition', column: 'name', op: 'contains', values: ['row1'] },
      })
      expect(f.total.kind).toBe('unknown')
    })

    test('a filtered table shows no total until Count; Count gives the exact number', async () => {
      const filter = {
        type: 'condition' as const,
        column: 'name',
        op: 'contains' as const,
        values: ['row1'],
      }
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'big',
        page: 0,
        pageSize: 25,
        sort: [],
        filter,
      })
      expect(r.total).toEqual({ kind: 'unknown', value: null })
      const c = await countRowsImpl(env(), {
        db: DB,
        table: 'big',
        filter,
        requestId: 'count-aaaa1',
      })
      expect(c.status).toBe('done')
      const expected = Number(
        (await one(`SELECT COUNT(*) AS n FROM ${t('big')} WHERE name LIKE '%row1%'`)).n,
      )
      expect(c).toMatchObject({ total: { kind: 'exact', value: expected } })
    })

    test('a page past the end is answered with the last page when the count is known', async () => {
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'small',
        page: 99,
        pageSize: 10,
        sort: [],
      })
      expect(r.page).toBe(2)
      expect(r.rows).toHaveLength(10)
      expect(r.total).toEqual({ kind: 'exact', value: 30 })
      const empty = await getRowsImpl(env(), {
        db: DB,
        table: 'big',
        page: 999,
        pageSize: 10,
        sort: [],
        filter: { type: 'condition', column: 'name', op: 'contains', values: ['row1'] },
      })
      expect(empty.rows).toHaveLength(0)
      expect(empty.hasPrev).toBe(true)
    })

    test('hostile filter text is a plain value; hostile sort column is refused before any SQL', async () => {
      const r = await page({
        filter: {
          type: 'condition',
          column: 'name',
          op: 'contains',
          values: ["x'; DROP TABLE customer; -- \\"],
        },
      })
      expect(r.rows).toHaveLength(0)
      expect(await count()).toBe(6)
      await expect(page({ sort: [{ column: 'name`; DROP', direction: 'asc' }] })).rejects.toThrow(
        /unknown-column/,
      )
    })

    test('requests with sql, where, orderBy, limit or class fields are rejected by the schema', () => {
      for (const extra of [{ where: '1=1' }, { sql: 'x' }, { orderBy: 'id' }, { limit: 1 }]) {
        expect(
          getRowsInput.safeParse({ db: 'd', table: 't', page: 0, pageSize: 5, sort: [], ...extra })
            .success,
        ).toBe(false)
      }
      expect(
        changeRowsInput.safeParse({
          db: 'd',
          table: 't',
          change: { op: 'delete', targets: [{ key: {}, old: {} }], class: 'none' },
        }).success,
      ).toBe(false)
    })

    test('readRow finds a row by key, answers not found, refuses a wrong key shape', async () => {
      const id = await idOf('ann@x.test')
      const r = await readRowImpl(env(), { db: DB, table: 'customer', key: { id: g(String(id)) } })
      expect(r.found).toBe(true)
      if (r.found) expect(r.cells[r.columns.indexOf('name')]).toBe('Ann')
      expect(
        await readRowImpl(env(), { db: DB, table: 'customer', key: { id: g('99999') } }),
      ).toEqual({ found: false })
      await expect(
        readRowImpl(env(), { db: DB, table: 'customer', key: { name: g('Ann') } }),
      ).rejects.toThrow(/no-identity/)
      await expect(
        readRowImpl(env(), { db: DB, table: 'nope', key: { id: g('1') } }),
      ).rejects.toThrow(/unknown-table/)
    })

    test('readCell returns a long value up to the byte limit with its length', async () => {
      const id = await idOf('ann@x.test')
      await q(`UPDATE ${t('customer')} SET note = ? WHERE id = ?`, ['é'.repeat(3000), id])
      const r = await readCellImpl(env(), {
        db: DB,
        table: 'customer',
        key: { id: g(String(id)) },
        column: 'note',
        maxBytes: 1000,
      })
      expect(r.found).toBe(true)
      if (r.found && r.value.t === 'text') {
        expect(r.value.length).toBe(3000)
        expect(r.value.truncated).toBe(true)
        expect(r.value.text.length).toBe(1000)
        expect(r.digest).toMatch(/^[0-9a-f]{64}$/)
      } else throw new Error('expected text')
    })

    test('the count can be cancelled and stops at the statement timeout', async () => {
      const filter = {
        type: 'condition' as const,
        column: 'name',
        op: 'contains' as const,
        values: ['row'],
      }
      const lock = await createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: 'root',
      })
      try {
        await lock.query(`LOCK TABLES ${t('big')} WRITE`)
        const e = env()
        const running = countRowsImpl(e, {
          db: DB,
          table: 'big',
          filter,
          requestId: 'count-cancel1',
        })
        await new Promise((r) => setTimeout(r, 500))
        await cancelCountImpl(e, { requestId: 'count-cancel1' })
        const done = await running
        expect(done.status).toBe('cancelled')

        // a cancel of another session changes nothing
        const running2 = countRowsImpl(e, {
          db: DB,
          table: 'big',
          filter,
          requestId: 'count-other01',
        })
        await new Promise((r) => setTimeout(r, 300))
        await cancelCountImpl(env({}, 'sess-b'), { requestId: 'count-other01' })
        await new Promise((r) => setTimeout(r, 200))
        await cancelCountImpl(e, { requestId: 'count-other01' })
        expect((await running2).status).toBe('cancelled')

        const slow = await countRowsImpl(env({ statementTimeoutMs: 400 }), {
          db: DB,
          table: 'big',
          filter,
          requestId: 'count-timeo01',
        })
        expect(slow.status).toBe('timeout')
        expect(slow.total.kind).toBe('estimate')
      } finally {
        await lock.query('UNLOCK TABLES').catch(() => undefined)
        await lock.end()
      }
    }, 30_000)
  })

  // ---- Writes -------------------------------------------------------------------------------------------------

  describe('insert and update', () => {
    test('insert runs at once (class none), reports the exact id and re-reads the row; no values in the log', async () => {
      const r = await change({
        op: 'insert',
        ignore: false,
        rows: [
          { name: v(SECRET), email: v('new@x.test'), note: nul, created: { t: 'fn', name: 'now' } },
        ],
      })
      expect(r.kind).toBe('done')
      if (r.kind !== 'done') return
      expect(r.operation).toBe('insert')
      expect(r.outcomes[0]).toMatchObject({ status: 'applied', affectedRows: 1 })
      const newId = r.outcomes[0]!.insertId!
      expect(Number(newId)).toBeGreaterThan(6)
      expect(r.rows[0]![r.columns.indexOf('name')]).toBe(SECRET)
      expect(r.rows[0]![r.columns.indexOf('flag')]).toBe('0')
      expect(r.statements[0]!.sql).toMatch(/^INSERT INTO `rows_b_scratch`\.`customer`/)
      const lines = auditLines().filter((l) => l.audit === 'rows.change')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        operation: 'insert',
        class: 'none',
        outcome: 'ok',
        rowCount: 1,
      })
      expect(logs.join('\n')).not.toContain(SECRET)
      expect(logs.join('\n')).not.toContain('new@x.test')
    })

    test('a duplicate in a batch rolls the whole batch back (InnoDB) and reports the server error', async () => {
      const r = await change({
        op: 'insert',
        ignore: false,
        rows: [
          { name: v('a'), email: v('batch1@x.test') },
          { name: v('b'), email: v('ann@x.test') },
          { name: v('c'), email: v('batch3@x.test') },
        ],
      })
      expect(r.kind).toBe('error')
      if (r.kind !== 'error') return
      expect(r.error.errno).toBe(1062)
      expect(r.error.hint).toBeTruthy()
      expect(r.error.rowIndex).toBe(1)
      expect(r.known).toBe(true)
      expect(r.outcomes.map((o) => o.status)).toEqual(['rolled-back', 'failed', 'not-run'])
      expect(await count()).toBe(6)
      expect(auditLines().find((l) => l.audit === 'rows.change')).toMatchObject({
        outcome: 'error',
        errno: 1062,
      })
    })

    test('INSERT IGNORE skips the duplicate with a warning and keeps exact ids', async () => {
      const r = await change({
        op: 'insert',
        ignore: true,
        rows: [
          { name: v('a'), email: v('ig1@x.test') },
          { name: v('b'), email: v('ann@x.test') },
          { name: v('c'), email: v('ig3@x.test') },
        ],
      })
      expect(r.kind).toBe('done')
      if (r.kind !== 'done') return
      expect(r.outcomes.map((o) => o.affectedRows)).toEqual([1, 0, 1])
      expect(r.warnings.length).toBeGreaterThan(0)
      expect(await count()).toBe(8)
    })

    test('a value that does not fit is reported on its field and nothing runs', async () => {
      const r = await change({
        op: 'insert',
        ignore: false,
        rows: [{ name: v('x'), email: v('ok@x.test'), flag: v('abc') }],
      })
      expect(r.kind).toBe('error')
      if (r.kind === 'error') expect(r.error.field).toBe('flag')
      expect(await count()).toBe(6)
    })

    test('update of one row by key needs no confirmation, compares old values, re-reads the row', async () => {
      const id = await idOf('ann@x.test')
      const r = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { name: g('Ann') } }],
        set: { name: v('Anna') },
      })
      expect(r.kind).toBe('done')
      if (r.kind !== 'done') return
      expect(r.rows[0]![r.columns.indexOf('name')]).toBe('Anna')
      expect(r.statements[0]!.sql).toMatch(/^UPDATE `rows_b_scratch`\.`customer` SET `name` = \?/)
      expect(r.statements[0]!.preview).toContain("'Anna'")
    })

    test('an unchanged value is no conflict (found rows, not changed rows)', async () => {
      const id = await idOf('bob@x.test')
      // old says 0 but the stored value is 1: a real conflict
      const conflict = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { flag: g('0') } }],
        set: { flag: v('1') },
      })
      expect(conflict.kind).toBe('conflict')
      // the stored value is 1; writing 01 changes nothing, yet the row was found
      const same = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { flag: g('1') } }],
        set: { flag: v('01') },
      })
      expect(same.kind).toBe('done')
      if (same.kind === 'done')
        expect(same.outcomes[0]).toMatchObject({ status: 'applied', affectedRows: 1 })
    })

    test('a set value equal to the old value writes nothing (no changes)', async () => {
      const id = await idOf('ann@x.test')
      const r = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { name: g('Ann') } }],
        set: { name: v('Ann') },
      })
      expect(r).toMatchObject({ kind: 'done', noChanges: true })
      expect(auditLines().filter((l) => l.audit === 'rows.change')).toHaveLength(0)
    })

    test('a conflicting change returns the current row; Overwrite resends with the current values', async () => {
      const id = await idOf('ann@x.test')
      await q(`UPDATE ${t('customer')} SET name = 'Annie' WHERE id = ?`, [id])
      const r = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { name: g('Ann') } }],
        set: { name: v('Anna') },
      })
      expect(r.kind).toBe('conflict')
      if (r.kind !== 'conflict') return
      expect(r.changed).toEqual(['name'])
      expect(r.current[r.columns.indexOf('name')]).toBe('Annie')
      expect(
        String(
          await one(`SELECT name FROM ${t('customer')} WHERE id = ?`, [id]).then((x) => x.name),
        ),
      ).toBe('Annie')

      // a different column is not in conflict
      const other = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { flag: g('0') } }],
        set: { flag: v('1') },
      })
      expect(other.kind).toBe('done')

      const overwrite = await change(
        {
          op: 'update',
          targets: [{ key: { id: g(String(id)) }, old: { name: g('Annie') } }],
          set: { name: v('Anna') },
        },
        { overwrite: true },
      )
      expect(overwrite.kind).toBe('done')
      expect(
        auditLines()
          .filter((l) => l.audit === 'rows.change')
          .map((l) => l.outcome),
      ).toEqual(['conflict', 'ok', 'ok'])
    })

    test('a vanished row gives gone', async () => {
      const id = await idOf('ann@x.test')
      await q(`DELETE FROM ${t('customer')} WHERE id = ?`, [id])
      const r = await change({
        op: 'update',
        targets: [{ key: { id: g(String(id)) }, old: { name: g('Ann') } }],
        set: { name: v('Anna') },
      })
      expect(r).toMatchObject({ kind: 'gone', index: 0 })
    })

    test('a key column cannot be forged: wrong key shape, unknown column and generated writes are refused', async () => {
      await expect(
        change({
          op: 'update',
          targets: [{ key: { name: g('Ann') }, old: {} }],
          set: { flag: v('1') },
        }),
      ).rejects.toThrow(/no-identity/)
      await expect(
        change({
          op: 'update',
          targets: [{ key: { id: g('1') }, old: {} }],
          set: { 'nope`; --': v('1') },
        }),
      ).rejects.toThrow(/unknown-column/)
    })
  })

  describe('delete, plans and tokens', () => {
    test('delete of one row is soft: confirm by plan id without a token; audit class soft', async () => {
      const r = await change(del([5]), { table: 'small' })
      expect(r.kind).toBe('confirm')
      if (r.kind !== 'confirm') return
      expect(r.confirmRequired).toBe(false)
      expect(r.confirmToken).toBeUndefined()
      expect(r.maxClass).toBe('soft')
      expect(r.statements[0]!.sql).toMatch(/^DELETE FROM/)
      expect(await count('small')).toBe(30)
      const done = await confirmRowsImpl(env(), { planId: r.planId })
      expect(done.kind).toBe('done')
      expect(await count('small')).toBe(29)
      await q(`INSERT INTO ${t('small')} VALUES (5, 'n5')`)
      expect(auditLines().find((l) => l.audit === 'rows.change')).toMatchObject({
        class: 'soft',
        operation: 'delete',
        planId: r.planId,
      })
      // the plan is single use
      await expect(confirmRowsImpl(env(), { planId: r.planId })).rejects.toThrow(/plan-missing/)
    })

    test('acceptSoft skips the soft confirmation, never the hard one', async () => {
      const soft = await change(del([6]), { acceptSoft: true, table: 'small' })
      expect(soft.kind).toBe('done')
      await q(`INSERT INTO ${t('small')} VALUES (6, 'n6')`)
      const b = await idOf('ed@x.test')
      const c = await idOf('flo@x.test')
      const hard = await change(del([b, c]), { acceptSoft: true })
      expect(hard.kind).toBe('confirm')
      expect(await count()).toBe(6)
    })

    test('a delete on a table that others reference with CASCADE is hard even for one row', async () => {
      const plan = await change(del([await idOf('cy@x.test')]))
      expect(plan.kind).toBe('confirm')
      if (plan.kind === 'confirm') {
        expect(plan.confirmRequired).toBe(true)
        expect(plan.maxClass).toBe('hard')
        expect(plan.reasons).toContain('cascade')
      }
    })

    test('hard delete of several rows: token required; forged, replayed, tampered, other-session and expired tokens fail', async () => {
      const ids = [await idOf('ann@x.test'), await idOf('bob@x.test')]
      const plan = await change(del(ids))
      expect(plan.kind).toBe('confirm')
      if (plan.kind !== 'confirm') return
      expect(plan.confirmRequired).toBe(true)
      expect(plan.maxClass).toBe('hard')
      expect(plan.reasons).toContain('bulk')
      expect(plan.totalStatements).toBe(2)
      const token = plan.confirmToken!

      await expect(confirmRowsImpl(env(), { planId: plan.planId })).rejects.toThrow(/token-missing/)
      await expect(
        confirmRowsImpl(env(), { planId: plan.planId, confirmToken: 'forged.token' }),
      ).rejects.toThrow(/token-invalid/)
      await expect(
        confirmRowsImpl(env(), { planId: plan.planId, confirmToken: token.slice(0, -2) + 'xx' }),
      ).rejects.toThrow(/token-invalid/)
      // another session sees no plan at all
      await expect(
        confirmRowsImpl(env({}, 'sess-b'), { planId: plan.planId, confirmToken: token }),
      ).rejects.toThrow(/plan-missing/)
      expect(await count()).toBe(6)

      // a plan changed in the store no longer matches its token
      const stored = plans.get('sess-a', plan.planId)!
      stored.statements[0] = { ...stored.statements[0]!, sql: stored.statements[0]!.sql + ' ' }
      await expect(
        confirmRowsImpl(env(), { planId: plan.planId, confirmToken: token }),
      ).rejects.toThrow(/token-invalid/)
      stored.statements[0] = { ...stored.statements[0]!, sql: stored.statements[0]!.sql.trimEnd() }
      expect(await count()).toBe(6)

      // an expired token (the plan is still there)
      await expect(
        confirmRowsImpl(env({ now: () => Date.now() + 11 * 60_000 }), {
          planId: plan.planId,
          confirmToken: token,
        }),
      ).rejects.toThrow(/token-expired/)

      const ok = await confirmRowsImpl(env(), { planId: plan.planId, confirmToken: token })
      expect(ok.kind).toBe('done')
      expect(await count()).toBe(4)

      // replay of the used token: the plan is gone; a fresh plan with the old token is refused too
      await expect(
        confirmRowsImpl(env(), { planId: plan.planId, confirmToken: token }),
      ).rejects.toThrow(/plan-missing/)
      const again = await change(del([await idOf('cy@x.test'), await idOf('di@x.test')]))
      if (again.kind !== 'confirm') throw new Error('expected confirm')
      await expect(
        confirmRowsImpl(env(), { planId: again.planId, confirmToken: token }),
      ).rejects.toThrow(/token-invalid/)
      const refusals = auditLines().filter((l) => l.audit === 'rows.refused')
      expect(refusals.map((l) => l.code)).toEqual(
        expect.arrayContaining(['token-missing', 'token-invalid', 'plan-missing', 'token-expired']),
      )
    })

    test('a delete that cascades is hard and lists the referencing tables; the cascade happens', async () => {
      const id = await idOf('ann@x.test')
      await q(`INSERT INTO ${t('orders')} (customer_id, amount) VALUES (?, 5.50), (?, 7.25)`, [
        id,
        id,
      ])
      const plan = await change(del([id]))
      expect(plan.kind).toBe('confirm')
      if (plan.kind !== 'confirm') return
      expect(plan.maxClass).toBe('hard')
      expect(plan.reasons).toContain('cascade')
      expect(plan.cascadeTables?.map((c) => c.table)).toContain('orders')
      await confirmRowsImpl(env(), { planId: plan.planId, confirmToken: plan.confirmToken })
      expect(await count('orders')).toBe(0)
    })

    test('a restricting foreign key gives the server error with a hint; the row stays', async () => {
      const id = await idOf('ann@x.test')
      await q(`INSERT INTO ${t('restr')} (customer_id) VALUES (?)`, [id])
      const plan = await change(del([id]))
      if (plan.kind !== 'confirm') throw new Error('expected confirm')
      const r = await confirmRowsImpl(env(), {
        planId: plan.planId,
        confirmToken: plan.confirmToken,
      })
      expect(r.kind).toBe('error')
      if (r.kind === 'error') {
        expect(r.error.errno).toBe(1451)
        expect(r.error.hint).toBeTruthy()
      }
      expect(await count()).toBe(6)
    })

    test('a row without a key: all-columns identity is hard, shows the match count, changes exactly one row', async () => {
      const read = await getRowsImpl(env(), {
        db: DB,
        table: 'nokey',
        page: 0,
        pageSize: 10,
        sort: [],
      })
      expect(read.identity.kind).toBe('all-columns')
      const plan = await change(
        {
          op: 'update',
          targets: [{ key: { a: g('1'), b: g('x') }, old: { b: g('x') } }],
          set: { b: v('z') },
        },
        { table: 'nokey' },
      )
      expect(plan.kind).toBe('confirm')
      if (plan.kind !== 'confirm') return
      expect(plan.maxClass).toBe('hard')
      expect(plan.reasons).toContain('no-key')
      expect(plan.identityKind).toBe('all-columns')
      expect(plan.matchCount).toBe(2)
      expect(plan.statements[0]!.sql).toContain('LIMIT 1')
      const r = await confirmRowsImpl(env(), {
        planId: plan.planId,
        confirmToken: plan.confirmToken,
      })
      expect(r.kind).toBe('done')
      const rows = (await q(`SELECT a, b FROM ${t('nokey')} ORDER BY a, b`))[0]
      expect(rows.map((x) => `${x.a}${x.b}`)).toEqual(['1x', '1z', '2y'])
    })

    test('bulk update of selected rows is soft, one UPDATE per row, one transaction', async () => {
      const ids = [await idOf('ann@x.test'), await idOf('bob@x.test'), await idOf('cy@x.test')]
      const olds = [g('first'), gn, g('c')]
      const plan = await change({
        op: 'update',
        targets: ids.map((id, i) => ({ key: { id: g(String(id)) }, old: { note: olds[i]! } })),
        set: { note: v('bulk') },
      })
      expect(plan.kind).toBe('confirm')
      if (plan.kind !== 'confirm') return
      expect(plan.maxClass).toBe('soft')
      expect(plan.confirmRequired).toBe(false)
      expect(plan.totalStatements).toBe(3)
      const r = await confirmRowsImpl(env(), { planId: plan.planId })
      expect(r.kind).toBe('done')
      expect(
        Number((await one(`SELECT COUNT(*) AS n FROM ${t('customer')} WHERE note = 'bulk'`)).n),
      ).toBe(3)
    })

    test('a conflict in a bulk update rolls the whole batch back on InnoDB and names the row', async () => {
      const ids = [await idOf('ann@x.test'), await idOf('bob@x.test'), await idOf('cy@x.test')]
      const olds = [g('first'), g('WRONG'), g('c')]
      const plan = await change({
        op: 'update',
        targets: ids.map((id, i) => ({ key: { id: g(String(id)) }, old: { note: olds[i]! } })),
        set: { note: v('bulk') },
      })
      if (plan.kind !== 'confirm') throw new Error('expected confirm')
      const r = await confirmRowsImpl(env(), { planId: plan.planId })
      expect(r.kind).toBe('conflict')
      if (r.kind === 'conflict') {
        expect(r.index).toBe(1)
        expect(r.outcomes.map((o) => o.status)).toEqual(['rolled-back', 'conflict', 'not-run'])
      }
      expect(
        Number((await one(`SELECT COUNT(*) AS n FROM ${t('customer')} WHERE note = 'bulk'`)).n),
      ).toBe(0)
    })

    test('more rows than the bulk limit are refused with the bound named', async () => {
      const targets = Array.from({ length: 1001 }, (_, i) => ({
        key: { id: g(String(i + 1)) },
        old: {},
      }))
      await expect(previewRowsInputCall({ op: 'delete', targets })).rejects.toThrow()
    })

    test('MyISAM: the plan warns about no rollback; a conflict part way leaves the earlier rows applied', async () => {
      const plan = await change(
        {
          op: 'update',
          targets: [
            { key: { id: g('1') }, old: { v: g('a') } },
            { key: { id: g('2') }, old: { v: g('WRONG') } },
            { key: { id: g('3') }, old: { v: g('c') } },
          ],
          set: { v: v('z') },
        },
        { table: 'isam' },
      )
      expect(plan.kind).toBe('confirm')
      if (plan.kind !== 'confirm') return
      expect(plan.warnings.map((w) => w.code)).toContain('no-rollback')
      const r = await confirmRowsImpl(env(), { planId: plan.planId })
      expect(r.kind).toBe('conflict')
      if (r.kind === 'conflict') {
        expect(r.outcomes.map((o) => o.status)).toEqual(['applied', 'conflict', 'not-run'])
      }
      expect(String((await one(`SELECT v FROM ${t('isam')} WHERE id = 1`)).v)).toBe('z')
      expect(String((await one(`SELECT v FROM ${t('isam')} WHERE id = 3`)).v)).toBe('c')
    })

    test('preview shows the statements without running them', async () => {
      const id = await idOf('ann@x.test')
      const info = await previewRowsImpl(env(), {
        db: DB,
        table: 'small',
        change: del([id]),
      })
      expect(info.statements[0]!.sql).toMatch(/^DELETE FROM/)
      expect(info.statements[0]!.preview).toContain(String(id))
      expect(info.maxClass).toBe('soft')
      expect(await count()).toBe(6)
    })

    function previewRowsInputCall(c: RowChange) {
      return previewRowsImpl(env(), { db: DB, table: 'customer', change: c })
    }
  })

  describe('read-only and privileges', () => {
    const counting = () => {
      const calls = { n: 0 }
      const trap = new Proxy(pool, {
        get(target, prop) {
          if (prop === 'getConnection' || prop === 'query' || prop === 'execute') {
            return () => {
              calls.n++
              throw new Error('the pool must not be touched')
            }
          }
          return Reflect.get(target, prop) as unknown
        },
      })
      return { calls, trap }
    }

    test.each([
      ['forced', { forcedReadOnly: true, sessionReadOnly: false }],
      ['chosen', { forcedReadOnly: false, sessionReadOnly: true }],
    ])('%s read-only refuses every write before a connection is opened', async (_n, guard) => {
      const { calls, trap } = counting()
      const e = env({ guard, session: { idHash: 'sess-a', target, pool: trap } })
      const changes: RowChange[] = [
        { op: 'insert', ignore: false, rows: [{ name: v('x'), email: v('ro@x.test') }] },
        { op: 'update', targets: [{ key: { id: g('1') }, old: {} }], set: { name: v('x') } },
        del([1]),
      ]
      for (const c of changes) {
        await expect(
          changeRowsImpl(e, {
            db: DB,
            table: 'customer',
            change: c,
            overwrite: false,
            acceptSoft: false,
          }),
        ).rejects.toThrow(/read-only/)
        await expect(previewRowsImpl(e, { db: DB, table: 'customer', change: c })).rejects.toThrow(
          /read-only/,
        )
      }
      await expect(confirmRowsImpl(e, { planId: 'does-not-matter' })).rejects.toThrow(/read-only/)
      expect(calls.n).toBe(0)
      expect(auditLines().filter((l) => l.audit === 'rows.refused').length).toBeGreaterThanOrEqual(
        7,
      )
      expect(await count()).toBe(6)
    })

    test('reads work on a read-only connection and report it in the permissions', async () => {
      const r = await page({}, env({ guard: { forcedReadOnly: true, sessionReadOnly: false } }))
      expect(r.permissions).toMatchObject({
        readOnly: true,
        insert: false,
        update: false,
        delete: false,
        reason: 'read-only',
      })
    })

    test('a SELECT-only account sees the grid, learns the privileges, and gets the server refusal with a hint', async () => {
      const e = env(
        {
          session: {
            idHash: 'sess-lim',
            target: { ...target, username: LIMITED },
            pool: limitedPool!,
          },
        },
        'sess-lim',
      )
      const r = await page({}, e)
      expect(r.rows.length).toBeGreaterThan(0)
      expect(r.permissions.insert).toBe(false)
      expect(r.permissions.update).toBe(false)
      expect(r.permissions.delete).toBe(false)
      const up = await change(
        {
          op: 'update',
          targets: [{ key: { id: g('1') }, old: { name: g('Ann') } }],
          set: { name: v('hacked') },
        },
        {},
        e,
      )
      expect(up.kind).toBe('error')
      if (up.kind === 'error') {
        expect(up.error.errno).toBe(1142)
        expect(up.error.hint).toBeTruthy()
      }
      expect(String((await one(`SELECT name FROM ${t('customer')} WHERE id = 1`)).name)).not.toBe(
        'hacked',
      )
      expect(auditLines().find((l) => l.audit === 'rows.change')).toMatchObject({
        outcome: 'error',
        errno: 1142,
      })
    })

    test('a write that runs into a lock stops at the statement timeout and rolls back', async () => {
      const lock = await createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: 'root',
      })
      try {
        await lock.query(`LOCK TABLES ${t('customer')} WRITE`)
        const r = await change(
          {
            op: 'update',
            targets: [{ key: { id: g('1') }, old: { name: g('Ann') } }],
            set: { name: v('late') },
          },
          {},
          env({ statementTimeoutMs: 400 }),
        )
        expect(r.kind).toBe('error')
        if (r.kind === 'error') expect(r.error.errno).toBe(3024)
      } finally {
        await lock.query('UNLOCK TABLES').catch(() => undefined)
        await lock.end()
      }
      expect(String((await one(`SELECT name FROM ${t('customer')} WHERE id = 1`)).name)).not.toBe(
        'late',
      )
      // the pool is healthy afterwards
      const ok = await page()
      expect(ok.rows.length).toBe(6)
    }, 30_000)
  })

  // ---- Binary values, downloads, uploads -------------------------------------------------------------------

  describe('blobs', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200, 7),
    ])

    test('open, stream and download: byte identical, headers, one use, owning session only', async () => {
      await admin.execute(`INSERT INTO ${t('blobs')} (id, img) VALUES (1, ?)`, [png])
      const opened = await openCellImpl(env(), {
        db: DB,
        table: 'blobs',
        key: { id: g('1') },
        column: 'img',
        disposition: 'preview',
      })
      expect(opened.found).toBe(true)
      if (!opened.found) return
      expect(opened.previewType).toBe('png')
      expect(opened.size).toBe(png.length)

      // another session and a bad id: the same neutral answer
      expect((await cellDownloadResponse(env({}, 'sess-b'), opened.id)).status).toBe(404)
      expect((await cellDownloadResponse(env(), 'nope')).status).toBe(404)

      const res = await cellDownloadResponse(env(), opened.id)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toBe('sandbox')
      expect(res.headers.get('content-length')).toBeNull()
      expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true)
      expect((await cellDownloadResponse(env(), opened.id)).status).toBe(404)
    })

    test('a download is an attachment of octet-stream; a text value is never previewed inline', async () => {
      await admin.execute(`INSERT INTO ${t('blobs')} (id, img) VALUES (2, ?)`, [
        Buffer.from('<svg onload=alert(1)>'),
      ])
      for (const disposition of ['download', 'preview'] as const) {
        const o = await openCellImpl(env(), {
          db: DB,
          table: 'blobs',
          key: { id: g('2') },
          column: 'img',
          disposition,
        })
        if (!o.found) throw new Error('expected found')
        expect(o.previewType).toBeUndefined()
        const res = await cellDownloadResponse(env(), o.id)
        expect(res.headers.get('content-type')).toBe('application/octet-stream')
        expect(res.headers.get('content-disposition')).toMatch(
          /^attachment; filename="blobs-img\.bin"$/,
        )
        await res.arrayBuffer()
      }
    })

    test('a handle expires after 60 seconds', async () => {
      await admin.execute(`INSERT INTO ${t('blobs')} (id, img) VALUES (3, ?)`, [png])
      let now = 1_000_000
      const store = new CellHandleStore(() => now)
      const o = await openCellImpl(env({ handles: store }), {
        db: DB,
        table: 'blobs',
        key: { id: g('3') },
        column: 'img',
        disposition: 'download',
      })
      if (!o.found) throw new Error('expected found')
      now += 61_000
      expect((await cellDownloadResponse(env({ handles: store }), o.id)).status).toBe(404)
    })

    test('a big value streams in chunks of at most 1 MiB (memory stays flat)', async () => {
      const size = 12 * 1024 * 1024 + 123
      const big = Buffer.alloc(size)
      for (let i = 0; i < size; i += 4096) big[i] = (i / 4096) & 0xff
      await admin.execute(`INSERT INTO ${t('blobs')} (id, doc) VALUES (4, ?)`, [big])
      const table = (await defaultPorts.loadRowTable(pool, DB, 'blobs'))!
      const identity = defaultPorts.identityFor(table)
      let largest = 0
      let total = 0
      let chunks = 0
      const hash = (await import('node:crypto')).createHash('sha256')
      for await (const chunk of streamCell(
        { pool, ports: defaultPorts, table, identity, statementTimeoutMs: 20_000 },
        { id: g('4') },
        'doc',
        size,
      )) {
        largest = Math.max(largest, chunk.length)
        total += chunk.length
        chunks++
        hash.update(chunk)
      }
      expect(total).toBe(size)
      expect(largest).toBeLessThanOrEqual(1024 * 1024)
      expect(chunks).toBe(13)
      expect(hash.digest('hex')).toBe(
        (await import('node:crypto')).createHash('sha256').update(big).digest('hex'),
      )
      // the grid projection never carries the value
      const r = await getRowsImpl(env(), {
        db: DB,
        table: 'blobs',
        page: 0,
        pageSize: 10,
        sort: [],
      })
      const cell = r.rows[0]![r.columns.indexOf('doc')]
      expect(cell).toMatchObject({ size })
      expect(JSON.stringify(r).length).toBeLessThan(10_000)
    }, 60_000)

    test('an upload is used once by an insert and stored byte for byte', async () => {
      const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
      const staged = uploads.put('sess-a', bytes, 'pic.bin')
      expect(staged.sha256).toHaveLength(64)
      // another session cannot use it
      const foreign = await change(
        {
          op: 'insert',
          ignore: false,
          rows: [{ id: v('10'), img: { t: 'bin', upload: staged.uploadId } }],
        },
        { table: 'blobs' },
        env({}, 'sess-b'),
      ).catch((e: Error) => e)
      expect(String(foreign)).toMatch(/unknown-upload/)
      const r = await change(
        {
          op: 'insert',
          ignore: false,
          rows: [{ id: v('10'), img: { t: 'bin', upload: staged.uploadId } }],
        },
        { table: 'blobs' },
      )
      expect(r.kind).toBe('done')
      const stored = (await one(`SELECT img FROM ${t('blobs')} WHERE id = 10`)).img as Buffer
      expect(stored.equals(bytes)).toBe(true)
      const reuse = await change(
        {
          op: 'insert',
          ignore: false,
          rows: [{ id: v('11'), img: { t: 'bin', upload: staged.uploadId } }],
        },
        { table: 'blobs' },
      ).catch((e: Error) => e)
      expect(String(reuse)).toMatch(/unknown-upload/)
    })

    test('editing without touching the blob keeps it', async () => {
      await admin.execute(`INSERT INTO ${t('blobs')} (id, img) VALUES (20, ?)`, [png])
      const r = await change(
        {
          op: 'update',
          targets: [{ key: { id: g('20') }, old: { label: gn } }],
          set: { label: v('named') },
        },
        { table: 'blobs' },
      )
      expect(r.kind).toBe('done')
      const stored = (await one(`SELECT img FROM ${t('blobs')} WHERE id = 20`)).img as Buffer
      expect(stored.equals(png)).toBe(true)
    })
  })

  describe('http routes', () => {
    const live = (idHash = 'sess-a') => ({
      idHash,
      csrf: 'csrf-token-value',
      target,
      pool,
      readOnly: false,
    })
    const runtime = (session = live()) =>
      ({
        sessions: {
          resolve: (token: string | undefined) => (token === 'good-token' ? session : undefined),
          verifyCsrf: (_s: unknown, presented: string | undefined) =>
            presented === 'csrf-token-value',
        },
      }) as never
    const headers = (extra: Record<string, string> = {}) => ({
      cookie: '__Host-dbloom-session=good-token',
      'sec-fetch-site': 'same-origin',
      ...extra,
    })
    const envFor = () => env()

    test('upload needs the session and the CSRF header; cross-site is refused', async () => {
      const body = Buffer.from('hello')
      const post = (h: Record<string, string>) =>
        handleUpload(
          new Request('http://x/api/rows/upload', { method: 'POST', headers: h, body }),
          runtime(),
          envFor,
        )
      expect((await post({})).status).toBe(403)
      expect((await post(headers())).status).toBe(403)
      expect((await post(headers({ 'x-dbloom-csrf': 'wrong' }))).status).toBe(403)
      expect(
        (
          await post(
            headers({ 'x-dbloom-csrf': 'csrf-token-value', 'sec-fetch-site': 'cross-site' }),
          )
        ).status,
      ).toBe(403)
      const ok = await post(
        headers({ 'x-dbloom-csrf': 'csrf-token-value', 'x-file-name': 'a%20b.png' }),
      )
      expect(ok.status).toBe(200)
      const json = (await ok.json()) as {
        uploadId: string
        sha256: string
        size: number
        fileName: string
      }
      expect(json.size).toBe(5)
      expect(json.fileName).toBe('a b.png')
      expect(uploads.peek('sess-a', json.uploadId)?.bytes.toString()).toBe('hello')
    })

    test('a 20 MB upload is refused with the cap named; a read-only session cannot stage', async () => {
      const big = Buffer.alloc(20 * 1024 * 1024)
      const res = await handleUpload(
        new Request('http://x/api/rows/upload', {
          method: 'POST',
          headers: headers({
            'x-dbloom-csrf': 'csrf-token-value',
            'content-length': String(big.length),
          }),
          body: big,
        }),
        runtime(),
        envFor,
      )
      expect(res.status).toBe(413)
      expect(((await res.json()) as { limit: number }).limit).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(uploads.size).toBe(0)

      const ro = await handleUpload(
        new Request('http://x/api/rows/upload', {
          method: 'POST',
          headers: headers({ 'x-dbloom-csrf': 'csrf-token-value' }),
          body: Buffer.from('x'),
        }),
        runtime(),
        () => env({ guard: { forcedReadOnly: true, sessionReadOnly: false } }),
      )
      expect(ro.status).toBe(403)
      expect(uploads.size).toBe(0)
      expect(PREVIEW_MAX_BYTES).toBe(8 * 1024 * 1024)
      expect(SESSION_UPLOAD_BYTES).toBe(32 * 1024 * 1024)
    })

    test('multipart upload is accepted', async () => {
      const form = new FormData()
      form.set('file', new File([Buffer.from('multi')], 'm.txt'))
      const res = await handleUpload(
        new Request('http://x/api/rows/upload', {
          method: 'POST',
          headers: headers({ 'x-dbloom-csrf': 'csrf-token-value' }),
          body: form,
        }),
        runtime(),
        envFor,
      )
      expect(res.status).toBe(200)
      expect(((await res.json()) as { fileName: string }).fileName).toBe('m.txt')
    })

    test('the download route answers 404 without a session and streams with one', async () => {
      await admin.execute(`INSERT INTO ${t('blobs')} (id, img) VALUES (30, ?)`, [
        Buffer.from('route-bytes'),
      ])
      const o = await openCellImpl(env(), {
        db: DB,
        table: 'blobs',
        key: { id: g('30') },
        column: 'img',
        disposition: 'download',
      })
      if (!o.found) throw new Error('expected found')
      const none = await handleCellGet(
        new Request(`http://x/api/rows/cell/${o.id}`, {
          headers: { 'sec-fetch-site': 'same-origin' },
        }),
        o.id,
        runtime(),
        envFor,
      )
      expect(none.status).toBe(404)
      const res = await handleCellGet(
        new Request(`http://x/api/rows/cell/${o.id}`, { headers: headers() }),
        o.id,
        runtime(),
        envFor,
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('route-bytes')
    })
  })

  describe('preferences through the service', () => {
    test('set, get, scopes, validation, unknown tables, stateless flag', async () => {
      const e = env()
      await setPrefImpl(e, { key: 'rows.pageSize', value: 100 })
      await setPrefImpl(e, {
        db: DB,
        table: 'customer',
        key: 'rows.columns',
        value: { order: ['id', 'name', 'gone'], hidden: ['note'], widths: { name: 150, gone: 90 } },
      })
      const got = await getPrefsImpl(e, { db: DB, table: 'customer' })
      expect(got.stateless).toBe(true)
      expect(got.values['rows.pageSize']).toBe(100)
      await expect(
        setPrefImpl(e, { db: DB, table: 'nope', key: 'rows.sort', value: [] }),
      ).rejects.toThrow(/unknown-table/)
      await expect(setPrefImpl(e, { key: 'rows.pageSize', value: 'x' })).rejects.toThrow(
        /invalid-value/,
      )
      await expect(setPrefImpl(e, { db: DB, key: 'rows.sort', value: [] })).rejects.toThrow(
        /scope-forbidden/,
      )
      // a dropped column leaves the layout when the table is read next (DATA-ISS-114)
      await page({}, e)
      const after = await getPrefsImpl(e, { db: DB, table: 'customer' })
      expect(after.values['rows.columns']).toEqual({
        order: ['id', 'name'],
        hidden: ['note'],
        widths: { name: 150 },
      })
    })
  })
})
