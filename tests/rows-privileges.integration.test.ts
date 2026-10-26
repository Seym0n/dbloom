import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConnection, type Connection } from 'mysql2/promise'
import type { Config } from '~/server/config'
import { openTargetPool, type TargetPool } from '~/server/db/target-pool'
import { defaultPorts } from '~/server/rows/default-ports'
import { boundsFromEnv } from '~/server/rows/limits'
import { MemoryPrefs } from '~/server/rows/prefs'
import { CellHandleStore, UploadStore } from '~/server/rows/blob'
import { changeRowsImpl, getRowsImpl, type RowsEnv } from '~/server/rows/service'
import { createTokenIssuer } from '~/server/structure/deps'
import { PlanStore } from '~/server/structure/plans'
import { RunRegistry } from '~/server/sql/registry'

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
] as const
const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const DB = 'rows_priv_scratch'
const UPD = 'rows_priv_upd'
const SEL = 'rows_priv_sel'
const PW = 'priv-pw'

const v = (s: string) => ({ t: 'v' as const, v: s })

describe.each(servers)('column-level privileges (SCN-050) on $name', ({ port }) => {
  let admin: Connection
  const pools: TargetPool[] = []
  const tokens = createTokenIssuer()
  const t = `\`${DB}\`.\`person\``

  const env = (username: string, pool: TargetPool): RowsEnv => ({
    session: { idHash: `sess-${username}`, target: { host: '127.0.0.1', port, username }, pool },
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens,
    statementTimeoutMs: 20_000,
    ports: defaultPorts,
    prefs: new MemoryPrefs(),
    ownerKey: 'owner',
    targetKey: `target-${username}`,
    stateless: true,
    bounds: boundsFromEnv({}),
    plans: new PlanStore(),
    handles: new CellHandleStore(),
    uploads: new UploadStore(),
    counts: new RunRegistry(),
  })

  const open = async (username: string) => {
    const pool = await openTargetPool(
      { host: '127.0.0.1', port, username },
      '127.0.0.1',
      PW,
      config,
    )
    pools.push(pool)
    return pool
  }

  const dropUsers = async () => {
    for (const u of [UPD, SEL]) await admin.query(`DROP USER IF EXISTS '${u}'@'%'`)
  }

  beforeAll(async () => {
    admin = await createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      multipleStatements: true,
    })
    await dropUsers()
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`)
    await admin.query(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, email VARCHAR(60) NOT NULL,
        note VARCHAR(60) NULL) ENGINE=InnoDB`,
    )
    await admin.query(
      `INSERT INTO ${t} VALUES (1, 'Ann', 'ann@x.test', 'n1'), (2, 'Bob', 'bob@x.test', 'n2')`,
    )
    await admin.query(`CREATE USER '${UPD}'@'%' IDENTIFIED BY '${PW}'`)
    await admin.query(`GRANT SELECT ON ${t} TO '${UPD}'@'%'`)
    await admin.query(`GRANT UPDATE (name) ON ${t} TO '${UPD}'@'%'`)
    await admin.query(`CREATE USER '${SEL}'@'%' IDENTIFIED BY '${PW}'`)
    await admin.query(`GRANT SELECT (id, name) ON ${t} TO '${SEL}'@'%'`)
  })

  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => undefined)
    await dropUsers().catch(() => undefined)
    await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => undefined)
    await admin?.end().catch(() => undefined)
  })

  const update = (
    e: RowsEnv,
    set: Record<string, ReturnType<typeof v>>,
    old: Record<string, ReturnType<typeof v>>,
  ) =>
    changeRowsImpl(e, {
      db: DB,
      table: 'person',
      change: {
        op: 'update',
        targets: [{ key: { id: v('1') }, old }],
        set,
      },
      overwrite: false,
      acceptSoft: false,
    })

  const rowOne = async () => {
    const [rows] = await admin.query(`SELECT name, email, note FROM ${t} WHERE id = 1`)
    return (rows as Record<string, unknown>[])[0]
  }

  test('UPDATE (name) only: name changes, email is refused with 1143, nothing else changes', async () => {
    const e = env(UPD, await open(UPD))
    const ok = await update(e, { name: v('Anna') }, { name: v('Ann') })
    expect(ok.kind).toBe('done')
    expect(await rowOne()).toMatchObject({ name: 'Anna', email: 'ann@x.test', note: 'n1' })

    const denied = await update(e, { email: v('hacked@x.test') }, { email: v('ann@x.test') })
    expect(denied.kind).toBe('error')
    if (denied.kind === 'error') {
      expect(denied.error.errno).toBe(1143)
      expect(denied.error.hint).toBeTruthy()
    }
    expect(await rowOne()).toMatchObject({ name: 'Anna', email: 'ann@x.test', note: 'n1' })
  })

  test('SELECT (id, name) only: the grid still answers and the hidden column is left out, not guessed', async () => {
    const e = env(SEL, await open(SEL))
    const r = await getRowsImpl(e, {
      db: DB,
      table: 'person',
      page: 0,
      pageSize: 50,
      sort: [],
    } as never)
    expect(r.rows.length).toBe(2)
    // The column without privilege is left out of the answer; nothing is guessed.
    expect(r.columns).toEqual(['id', 'name'])
    expect(r.rows.map((row) => row[0])).toEqual(['1', '2'])
    expect(r.permissions.reason).toBe('privilege')
    expect(r.permissions.update).toBe(false)
    expect(r.permissions.insert).toBe(false)
  })
})
