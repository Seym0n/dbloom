import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { analyseImportImpl, type ImportEnv } from '~/server/io/analyse'
import { runExport, type ExportOutcome } from '~/server/io/export'
import { startImportImpl } from '~/server/io/import-service'
import { JobRegistry } from '~/server/io/jobs'
import { resolveIoLimits } from '~/server/io/limits'
import { TempStore } from '~/server/io/temp'
import { exportRequest, MiB, type IoJob } from '~/server/io/types'
import { initParser } from '~/server/sql/parser'
import { createFixture } from './io-export-fixture'
import { PRODUCTS, clientDump, compareDatabases, containerOf, runDump } from './io-roundtrip-helpers'

// FR-IO-027, SCN-063: DBLoom export -> DBLoom import, DBLoom export -> real client import, client dump -> DBLoom import,
// per product, plus DBLoom export -> DBLoom import across products for the common subset.

const owner = { sessionId: 'sess-io-rt', user: 'root' }
const TERMINAL = ['paused', 'done', 'done_with_skips', 'done_with_rejects', 'failed', 'cancelled']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const q = (n: string) => '`' + n + '`'
const nameOf = (product: string, tag: string) => `io_rt_${tag}_${product}_${process.pid}`

function openPool(port: number, limit = 8): Pool {
  return createPool({
    host: '127.0.0.1',
    port,
    user: 'root',
    password: 'root',
    connectionLimit: limit,
    multipleStatements: false,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    jsonStrings: true,
  })
}

/** Everything of FR-IO-027 beyond the shared fixture: partitions, stored columns, checks, CJK in several charsets, big rows. */
async function extendFixture(pool: Pool, db: string): Promise<void> {
  const c = await pool.getConnection()
  try {
    await c.query(`USE ${q(db)}`)
    await c.query(`CREATE TABLE part_t (
      id INT NOT NULL, grp INT NOT NULL, label VARCHAR(30), dbl INT GENERATED ALWAYS AS (grp * 2) STORED,
      PRIMARY KEY (id, grp), CONSTRAINT chk_grp CHECK (grp >= 0)
    ) ENGINE=InnoDB PARTITION BY RANGE (grp) (PARTITION p0 VALUES LESS THAN (10), PARTITION p1 VALUES LESS THAN (100), PARTITION pmax VALUES LESS THAN MAXVALUE)`)
    await c.query("INSERT INTO part_t (id, grp, label) VALUES (1, 1, 'low'), (2, 50, 'mid'), (3, 5000, 'high'), (4, 9, NULL)")
    await c.query(`CREATE TABLE cjk_t (
      id INT PRIMARY KEY, zh VARCHAR(80), emoji VARCHAR(40), latin CHAR(10) CHARACTER SET latin1, ascii_c VARCHAR(10) CHARACTER SET ascii,
      kw VARCHAR(40) COLLATE utf8mb4_bin, FULLTEXT KEY ft (zh)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await c.query(
      "INSERT INTO cjk_t VALUES (1, '你好，世界 こんにちは 안녕하세요', '😀👨‍👩‍👧‍👦🇩🇪', 'é ü ß', 'plain', 'CaSe'), (2, '𠀀𠀁 rare plane-2 chars', '🏳️‍🌈', NULL, '', ''), (3, '', '', '', 'a''b', 'x\\\\y')",
    )
    await c.query('CREATE TABLE big_row (id INT PRIMARY KEY, b LONGBLOB, t LONGTEXT CHARACTER SET utf8mb4, j TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')
    // 3 MiB blob (all byte values) and 2 MiB of CJK and emoji text in single rows
    await c.query("INSERT INTO big_row VALUES (1, REPEAT(UNHEX('00FF0A0D5C2700'), 450000), REPEAT('日本語😀', 150000), NULL)")
    await c.query("INSERT INTO big_row VALUES (2, UNHEX(''), '', 'x')")
    await c.query('CREATE TABLE def_t (id INT AUTO_INCREMENT PRIMARY KEY, created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, flag TINYINT(1) NOT NULL DEFAULT 1, s VARCHAR(10) NOT NULL DEFAULT \'a;b\') ENGINE=InnoDB')
    await c.query("INSERT INTO def_t (created) VALUES ('2026-10-27 10:00:00'), ('2000-01-01 00:00:00')")
    await c.query('CREATE VIEW v_part AS SELECT id, grp, dbl FROM part_t WHERE grp < 100')
    await c.query('CREATE VIEW v_over_views AS SELECT p.id, c.zh FROM v_part p JOIN cjk_t c ON c.id = p.id')
  } finally {
    c.release()
  }
}

describe.each(PRODUCTS)('round trip on $name', ({ port, product, client }) => {
  const SRC = nameOf(product, 'src')
  const DST = nameOf(product, 'dst')
  const container = containerOf(port)
  let pool: Pool
  let root: string
  let temp: TempStore
  let jobs: JobRegistry
  let env: ImportEnv

  const mkEnv = (): ImportEnv => ({
    session: { idHash: owner.sessionId, target: { host: '127.0.0.1', port, username: 'root' } as never },
    pool,
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens: createTokenIssuer(),
    temp,
    jobs,
    owner,
    limits: resolveIoLimits(),
    targetLabel: `127.0.0.1:${port}`,
    statementTimeoutMs: 120_000,
  })

  async function exportDb(format: 'sql' | 'csv' | 'json', options: Record<string, unknown>, scope: Record<string, unknown> = { kind: 'database', db: SRC }, compression = 'none'): Promise<ExportOutcome> {
    const o = await runExport({
      pool,
      temp,
      owner: { sessionId: 's', user: 'u' },
      request: exportRequest.parse({ scope, format, compression, options }),
      limits: { maxExportBytes: 2048 * MiB, jobMs: 600_000 },
      signal: new AbortController().signal,
      serverLabel: '127.0.0.1',
      neutraliseFormulas: true,
    })
    expect(o.state, JSON.stringify(o.result)).toBe('done')
    return o
  }

  async function stage(data: Buffer, name: string): Promise<string> {
    const w = await temp.begin(owner, 'upload', { name, maxBytes: 1 << 30 })
    await w.write(data)
    return (await w.commit()).id
  }

  async function waitJob(jobId: string): Promise<IoJob> {
    const t0 = Date.now()
    for (;;) {
      const j = jobs.get(jobId, owner)!
      if (TERMINAL.includes(j.state)) return j
      if (Date.now() - t0 > 240_000) throw new Error(`job ${jobId} still ${j.state}`)
      await sleep(25)
    }
  }

  /** Stage, analyse, confirm (a dump has hard statements) and import into DST; fails the test when the job does not end done. */
  async function dbloomImport(data: Buffer, name: string): Promise<IoJob> {
    const uploadId = await stage(data, name)
    const analysis = await analyseImportImpl(env, { uploadId, format: 'sql' })
    const { jobId } = await startImportImpl(env, {
      uploadId,
      format: 'sql',
      db: DST,
      options: {},
      ...(analysis.confirmToken ? { confirmToken: analysis.confirmToken } : {}),
    })
    const job = await waitJob(jobId)
    expect(job.state, JSON.stringify(job.result)).toBe('done')
    return job
  }

  const freshDst = async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${q(DST)}`)
    await pool.query(`CREATE DATABASE ${q(DST)} DEFAULT CHARACTER SET utf8mb4`)
  }

  beforeAll(async () => {
    await initParser()
    pool = openPool(port, 12)
    root = mkdtempSync(join(tmpdir(), 'io-rt-'))
    temp = new TempStore({ dir: join(root, 'tmp'), quotaBytes: 8 * 1024 * MiB, maxFilesPerOwner: 200 })
    jobs = new JobRegistry()
    env = mkEnv()
    await createFixture(pool, SRC, product)
    await extendFixture(pool, SRC)
  }, 240_000)

  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${q(SRC)}`)
    await pool.query(`DROP DATABASE IF EXISTS ${q(DST)}`)
    await pool.end()
    rmSync(root, { recursive: true, force: true })
  })

  test('fixture covers partitions, stored columns, routines, events and big rows', async () => {
    const [parts] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [SRC, 'part_t'])
    expect(Number(parts[0]!.n)).toBe(3)
    const [big] = await pool.query<RowDataPacket[]>(`SELECT LENGTH(b) AS bl, CHAR_LENGTH(t) AS tl FROM ${q(SRC)}.big_row WHERE id = 1`)
    expect(Number(big[0]!.bl)).toBe(3_150_000)
    expect(Number(big[0]!.tl)).toBe(600_000)
  })

  test('DBLoom export -> DBLoom import, SQL: identical (FR-IO-027)', async () => {
    const o = await exportDb('sql', { routines: true, events: true })
    await freshDst()
    const job = await dbloomImport(readFileSync(o.file!.path), `${SRC}.sql`)
    expect(job.result?.statements?.failed).toBe(0)
    expect(await compareDatabases(pool, SRC, DST)).toEqual([])
    const [r] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${q(DST)}.bulk`)
    expect(Number(r[0]!.n)).toBe(100_000)
    // the trigger of the source does not run during the restore (it is created after the data): rows equal
    const [t] = await pool.query<RowDataPacket[]>(`SELECT v FROM ${q(DST)}.bulk WHERE id = 1`)
    expect(t[0]!.v).toBe('row-1')
  }, 300_000)

  test('DBLoom gzip export -> DBLoom import', async () => {
    const o = await exportDb('sql', { routines: true, events: true }, { kind: 'database', db: SRC }, 'gzip')
    expect(o.fileName).toMatch(/\.sql\.gz$/)
    await freshDst()
    await dbloomImport(readFileSync(o.file!.path), o.fileName!)
    expect(await compareDatabases(pool, SRC, DST)).toEqual([])
  }, 300_000)

  test.skipIf(!container)('DBLoom export -> real client import: identical', async () => {
    const o = await exportDb('sql', { routines: true, events: true })
    await freshDst()
    await runDump(container!, client, DST, readFileSync(o.file!.path, 'utf8'))
    expect(await compareDatabases(pool, SRC, DST)).toEqual([])
  }, 300_000)

  test('client dump with --hex-blob --complete-insert -> DBLoom import: identical rows and objects', async () => {
    if (!container) return
    const dump = await clientDump(container, client, SRC, ['--hex-blob', '--complete-insert'])
    expect(dump.length).toBeGreaterThan(1_000_000)
    await freshDst()
    const job = await dbloomImport(dump, 'client.sql')
    expect(job.result?.statements?.failed).toBe(0)
    // mysqldump writes FLOAT with 6 significant digits (client-side loss, not DBLoom's): compare that table by value
    const diffs = await compareDatabases(pool, SRC, DST)
    expect(diffs.filter((d) => !(d.kind === 'checksum' && d.object === 'types_t'))).toEqual([])
    const read = async (db: string) => {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM ${q(db)}.types_t ORDER BY id`)
      return rows.map(({ t_float, ...rest }) => ({ ...rest, ff: t_float === null ? null : Number(Number(t_float).toPrecision(5)) }))
    }
    expect(await read(DST)).toEqual(await read(SRC))
  }, 300_000)

  test('client dump with raw binary bytes (no --hex-blob) is refused with the byte position, not imported damaged', async () => {
    if (!container) return
    const dump = await clientDump(container, client, SRC)
    await freshDst()
    const uploadId = await stage(dump, 'raw.sql')
    await expect(analyseImportImpl(env, { uploadId, format: 'sql' })).rejects.toMatchObject({ error: { message: expect.stringMatching(/Invalid byte sequence at byte \d+/) } })
  }, 300_000)

  test('structure-only dump restores every object without rows', async () => {
    const s = await exportDb('sql', { routines: true, events: true, content: 'structure' })
    await freshDst()
    await dbloomImport(readFileSync(s.file!.path), 'structure.sql')
    const diffs = await compareDatabases(pool, SRC, DST, { checksums: false })
    expect(diffs.filter((d) => d.kind !== 'count')).toEqual([])
    const [r] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${q(DST)}.bulk`)
    expect(Number(r[0]!.n)).toBe(0)
  }, 300_000)

  test('CSV and JSON round trip the rows of tables (FR-IO-027)', async () => {
    await freshDst()
    const c = await pool.getConnection()
    try {
      await c.query(`USE ${q(DST)}`)
      for (const t of ['cjk_t', 'big_row', 'def_t', 'z_parent']) await c.query(`CREATE TABLE ${q(t)} LIKE ${q(SRC)}.${q(t)}`)
    } finally {
      c.release()
    }
    const sums = async (db: string, t: string) => {
      const [r] = await pool.query<RowDataPacket[]>(`CHECKSUM TABLE ${q(db)}.${q(t)}`)
      return String(r[0]!.Checksum)
    }
    for (const format of ['csv', 'json'] as const) {
      for (const t of ['cjk_t', 'big_row', 'def_t', 'z_parent']) {
        await pool.query(`TRUNCATE ${q(DST)}.${q(t)}`)
        const o = await exportDb(format, {}, { kind: 'table', db: SRC, table: t })
        const uploadId = await stage(readFileSync(o.file!.path), `${t}.${format}`)
        const rowOptions = format === 'csv' ? { header: true } : {}
        await analyseImportImpl(env, { uploadId, format, rowOptions })
        const { jobId } = await startImportImpl(env, { uploadId, format, db: DST, table: t, options: rowOptions })
        const job = await waitJob(jobId)
        expect(job.state, `${format} ${t} ${JSON.stringify(job.result)}`).toBe('done')
        expect(await sums(DST, t), `${format} ${t}`).toBe(await sums(SRC, t))
      }
    }
  }, 300_000)
})

// ---- across products ----------------------------------------------------------------------------------------------

const [mysql, mariadb] = PRODUCTS as [(typeof PRODUCTS)[number], (typeof PRODUCTS)[number]]

describe.skipIf(!containerOf(mysql.port) || !containerOf(mariadb.port))('DBLoom export -> DBLoom import across products (SCN-063)', () => {
  const SRC = `io_rtx_src_${process.pid}`
  const DST = `io_rtx_dst_${process.pid}`
  let pools: Record<'mysql' | 'mariadb', Pool>
  let temp: TempStore
  let jobs: JobRegistry
  let root: string

  const COLL = 'utf8mb4_general_ci'
  const SUBSET = [
    `CREATE TABLE parent (id INT PRIMARY KEY, name VARCHAR(60), amount DECIMAL(12,4), at DATETIME(3), raw VARBINARY(40), b BIT(10), note TEXT, doc JSON, e ENUM('a','b'), s SET('x','y'), tiny TINYINT UNSIGNED, big BIGINT UNSIGNED, d DOUBLE, yr YEAR, tm TIME(2),
       g INT GENERATED ALWAYS AS (id * 2) STORED, v INT GENERATED ALWAYS AS (id + 1) VIRTUAL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${COLL}`,
    `CREATE TABLE child (id INT PRIMARY KEY, pid INT NOT NULL, KEY (pid), CONSTRAINT fk_x FOREIGN KEY (pid) REFERENCES parent (id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${COLL}`,
    `CREATE TABLE pt (id INT NOT NULL, grp INT NOT NULL, PRIMARY KEY (id, grp)) ENGINE=InnoDB PARTITION BY RANGE (grp) (PARTITION p0 VALUES LESS THAN (10), PARTITION pmax VALUES LESS THAN MAXVALUE)`,
    `INSERT INTO parent (id, name, amount, at, raw, b, note, doc, e, s, tiny, big, d, yr, tm) VALUES
       (1, 'Ünïcode 日本 😀', 12345.6789, '2026-10-27 01:02:03.456', 0x00ff0a0d5c27, b'1010101010', 'a''b\\\\c\nd; --', '{"k": [1, 2, {"z": null}]}', 'b', 'x,y', 255, 18446744073709551615, 0.30000000000000004, 2024, '-12:34:56.78'),
       (2, NULL, -0.0001, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    'INSERT INTO child VALUES (10, 1), (11, 2)',
    'INSERT INTO pt VALUES (1, 1), (2, 50)',
    'CREATE VIEW v_parent AS SELECT id, name FROM parent',
    'CREATE FUNCTION fn_x(a INT) RETURNS INT DETERMINISTIC RETURN a * 3',
    'CREATE PROCEDURE p_x() SELECT 1',
    'CREATE TRIGGER trg_x BEFORE INSERT ON child FOR EACH ROW SET NEW.pid = NEW.pid',
    'CREATE EVENT ev_x ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1',
  ]
  const SELECTS = [
    'SELECT id, name, amount, at, HEX(raw) AS raw, HEX(b) AS b, note, doc, e, s, tiny, big, d, yr, tm, g, v FROM parent ORDER BY id',
    'SELECT * FROM child ORDER BY id',
    'SELECT * FROM pt ORDER BY id',
    'SELECT * FROM v_parent ORDER BY id',
    'SELECT fn_x(7) AS r',
  ]

  const open = (port: number) => openPool(port, 6)
  const env = (pool: Pool, port: number): ImportEnv => ({
    session: { idHash: owner.sessionId, target: { host: '127.0.0.1', port, username: 'root' } as never },
    pool,
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens: createTokenIssuer(),
    temp,
    jobs,
    owner,
    limits: resolveIoLimits(),
    targetLabel: `127.0.0.1:${port}`,
    statementTimeoutMs: 60_000,
  })

  beforeAll(async () => {
    await initParser()
    pools = { mysql: open(mysql.port), mariadb: open(mariadb.port) }
    root = mkdtempSync(join(tmpdir(), 'io-rtx-'))
    temp = new TempStore({ dir: join(root, 'tmp'), quotaBytes: 1024 * MiB })
    jobs = new JobRegistry()
    for (const p of Object.values(pools)) {
      await p.query(`DROP DATABASE IF EXISTS ${SRC}`)
      await p.query(`DROP DATABASE IF EXISTS ${DST}`)
      await p.query(`CREATE DATABASE ${SRC} DEFAULT CHARACTER SET utf8mb4 COLLATE ${COLL}`)
      const c = await p.getConnection()
      await c.query(`USE ${SRC}`)
      for (const s of SUBSET) await c.query(s)
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
    { from: 'mysql' as const, to: 'mariadb' as const, compress: false },
    { from: 'mariadb' as const, to: 'mysql' as const, compress: false },
    { from: 'mysql' as const, to: 'mariadb' as const, compress: true },
    { from: 'mariadb' as const, to: 'mysql' as const, compress: true },
  ]
  test.each(cases)('$from -> $to (gzip $compress): rows, views, routines, events agree', async ({ from, to, compress }) => {
    const o = await runExport({
      pool: pools[from],
      temp,
      owner: { sessionId: 's', user: 'u' },
      request: exportRequest.parse({ scope: { kind: 'database', db: SRC }, format: 'sql', compression: compress ? 'gzip' : 'none', options: { routines: true, events: true } }),
      limits: { maxExportBytes: 100 * MiB, jobMs: 60_000 },
      signal: new AbortController().signal,
      serverLabel: 'x',
      neutraliseFormulas: true,
    })
    expect(o.state, JSON.stringify(o.result)).toBe('done')
    const pool = pools[to]
    await pool.query(`DROP DATABASE IF EXISTS ${DST}`)
    await pool.query(`CREATE DATABASE ${DST} DEFAULT CHARACTER SET utf8mb4 COLLATE ${COLL}`)
    const e = env(pool, PRODUCTS.find((p) => p.product === to)!.port)
    const data = readFileSync(o.file!.path)
    const w = await temp.begin(owner, 'upload', { name: o.fileName ?? 'x.sql', maxBytes: 1 << 30 })
    await w.write(data)
    const uploadId = (await w.commit()).id
    const analysis = await analyseImportImpl(e, { uploadId, format: 'sql' })
    const { jobId } = await startImportImpl(e, { uploadId, format: 'sql', db: DST, options: {}, ...(analysis.confirmToken ? { confirmToken: analysis.confirmToken } : {}) })
    let job: IoJob
    for (;;) {
      job = jobs.get(jobId, owner)!
      if (TERMINAL.includes(job.state)) break
      await sleep(25)
    }
    expect(job.state, JSON.stringify(job.result)).toBe('done')
    const c = await pool.getConnection()
    try {
      for (const s of SELECTS) {
        await c.query(`USE ${DST}`)
        const [got] = await c.query(s)
        await c.query(`USE ${SRC}`)
        const [want] = await pools[from].query(s.replace(/\b(FROM|JOIN) (\w+)/g, `$1 ${SRC}.$2`).replace('fn_x(7)', `${SRC}.fn_x(7)`))
        // the source rows come from the other product; compare after the same normalisation of JSON and dates
        expect(norm(got), s).toEqual(norm(want))
      }
    } finally {
      c.release()
    }
    const names = async (p: Pool, db: string) => {
      const [rows] = await p.query<RowDataPacket[]>(
        `SELECT CONCAT(ROUTINE_TYPE, ' ', ROUTINE_NAME) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? UNION ALL SELECT CONCAT('EVENT ', EVENT_NAME) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? UNION ALL SELECT CONCAT('TRIGGER ', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
        [db, db, db],
      )
      return rows.map((r) => String(r.n)).sort()
    }
    expect(await names(pool, DST)).toEqual(['EVENT ev_x', 'FUNCTION fn_x', 'PROCEDURE p_x', 'TRIGGER trg_x'])
    expect(await names(pool, DST)).toEqual(await names(pools[from], SRC))
  }, 60_000)
})

/** JSON text differs in white space between products; compare parsed. */
function norm(rows: unknown): unknown {
  return JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'string' && /^[[{]/.test(v) ? safeParse(v) : v)))
}
function safeParse(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}
