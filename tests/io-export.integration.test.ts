import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { runExport, type ExportDeps, type ExportOutcome } from '~/server/io/export'
import { readCsvRows } from '~/server/io/csv'
import { TempStore } from '~/server/io/temp'
import { exportRequest, MiB } from '~/server/io/types'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { openResultStream } from '~/server/sql/export-source'
import { RunRegistry } from '~/server/sql/registry'
import type { SqlRunEnv } from '~/server/sql/run'
import { DEFAULT_SQL_LIMITS } from '~/server/sql/types'
import { PlanStore } from '~/server/structure/plans'
import { createFixture } from './io-export-fixture'
import { PRODUCTS, compareDatabases, containerOf, runDump } from './io-roundtrip-helpers'

// FR-IO-002/003/004/005/006/007/008/010/027 and SCN-052..055, 063 against real servers.

describe.each(PRODUCTS)('export engine on $name', ({ port, product, client }) => {
  const DB = `io_exp_${product}`
  const RESTORE = `io_exp_restore_${product}`
  const container = containerOf(port)
  let pool: Pool
  let temp: TempStore
  let root: string
  const owner = { sessionId: 's', user: 'u' }

  const run = (req: unknown, over: Partial<ExportDeps> = {}): Promise<ExportOutcome> =>
    runExport({
      pool,
      temp,
      owner,
      request: exportRequest.parse(req),
      limits: { maxExportBytes: 1024 * MiB, jobMs: 300_000 },
      signal: new AbortController().signal,
      serverLabel: '127.0.0.1',
      neutraliseFormulas: true,
      ...over,
    })
  const bytesOf = (o: ExportOutcome): Buffer => {
    expect(o.file, JSON.stringify(o.result)).toBeDefined()
    return readFileSync(o.file!.path)
  }
  const textOf = (o: ExportOutcome) => bytesOf(o).toString('utf8')
  const spoolFiles = () => readdirSync(root).filter((f) => /^[0-9a-f]{32}$/.test(f))
  const base = (db = DB) => ({ kind: 'database' as const, db })

  beforeAll(async () => {
    pool = createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      connectionLimit: 12,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      jsonStrings: true,
    })
    root = mkdtempSync(join(tmpdir(), 'io-exp-'))
    temp = new TempStore({ dir: root, quotaBytes: 4 * 1024 * MiB, maxFilesPerOwner: 200 })
    await createFixture(pool, DB, product)
  }, 180_000)

  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await pool.query(`DROP DATABASE IF EXISTS ${RESTORE}`)
    await pool.end()
    rmSync(root, { recursive: true, force: true })
  })

  test('SQL dump of a database: header, order, cycle, views, programs (FR-IO-004, 005)', async () => {
    const o = await run({
      scope: base(),
      format: 'sql',
      compression: 'none',
      options: { routines: true, events: true, createDatabase: true, dropObjects: true },
    })
    expect(o.state).toBe('done')
    expect(o.result.error).toBeUndefined()
    const sql = textOf(o)
    expect(sql).toContain('-- DBLoom SQL dump')
    expect(sql).toContain('SET NAMES utf8mb4;')
    expect(sql).toContain(`CREATE DATABASE`)
    expect(sql).toContain(`USE \`${DB}\`;`)
    // referenced table first, ties by name
    expect(sql.indexOf('CREATE TABLE `z_parent`')).toBeLessThan(sql.indexOf('CREATE TABLE `a_child`'))
    // cycle: keys of the early member come after all data
    expect(o.result.notes.join(' ')).toContain('cycle')
    expect(sql).toMatch(/ALTER TABLE `cyc_a`\s+ADD CONSTRAINT `fk_a_b`/)
    // view order by dependency, not by name
    expect(sql.indexOf('VIEW `b_view_base`')).toBeLessThan(sql.indexOf('VIEW `a_view_top`'))
    // programs wrapped for the splitter, triggers after data
    expect(sql).toContain('DELIMITER $$')
    expect(sql.indexOf("INSERT INTO `bulk`")).toBeLessThan(sql.search(/TRIGGER `?trg_bulk_ins/))
    expect(sql).toContain('FUNCTION `fn_add`')
    expect(sql).toContain('PROCEDURE `p_hello`')
    expect(sql).toContain('EVENT `ev_x`')
    // generated columns are not written
    const insert = /INSERT INTO `types_t` \(([^)]*)\)/.exec(sql)?.[1] ?? ''
    expect(insert).not.toContain('g_val')
    // hostile text stays one literal
    expect(sql).toContain('Zeile1\nZeile2; DROP TABLE x; --')
    expect(o.file!.bytes).toBeGreaterThan(1000)
    expect(o.contentType).toBe('application/sql')
    expect(o.fileName).toBe(`${DB}.sql`)
  }, 120_000)

  test.skipIf(!container)('round trip: dump imports unchanged (FR-IO-027, SCN-063)', async () => {
    const o = await run({ scope: base(), format: 'sql', compression: 'none', options: { routines: true, events: true } })
    expect(o.state).toBe('done')
    await pool.query(`DROP DATABASE IF EXISTS ${RESTORE}`)
    await pool.query(`CREATE DATABASE ${RESTORE} DEFAULT CHARACTER SET utf8mb4`)
    await runDump(container!, client, RESTORE, textOf(o))
    const diffs = await compareDatabases(pool, DB, RESTORE)
    expect(diffs).toEqual([])
    const [r] = await pool.query(`SELECT COUNT(*) AS n FROM ${RESTORE}.bulk`)
    expect(Number((r as { n: unknown }[])[0]!.n)).toBe(100_000)
    // an IF NOT EXISTS dump imports twice without error (DATA-ISS-106)
    const again = await run({ scope: base(), format: 'sql', compression: 'none', options: { ifNotExists: true, statement: 'insertIgnore' } })
    await runDump(container!, client, RESTORE, textOf(again))
  }, 240_000)

  test('data only, structure only, REPLACE and no extended inserts', async () => {
    const data = textOf(await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'sql', compression: 'none', options: { content: 'data', statement: 'replace', extendedInserts: false, createDatabase: true } }))
    expect(data).not.toContain('CREATE')
    expect(data).toContain("REPLACE INTO `z_parent` (`id`,`name`) VALUES (1,'one');")
    expect(data).toContain("REPLACE INTO `z_parent` (`id`,`name`) VALUES (2,'zwei');")
    const structure = textOf(await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'sql', compression: 'none', options: { content: 'structure' } }))
    expect(structure).toContain('CREATE TABLE `z_parent`')
    expect(structure).not.toContain('INSERT')
  })

  test('snapshot: rows added during the export do not appear (FR-IO-003)', async () => {
    const SNAP = `${DB}_snap`
    await pool.query(`DROP DATABASE IF EXISTS ${SNAP}`)
    await pool.query(`CREATE DATABASE ${SNAP}`)
    await pool.query(`CREATE TABLE ${SNAP}.a_big (id INT PRIMARY KEY, pad VARCHAR(100)) ENGINE=InnoDB`)
    await pool.query(`CREATE TABLE ${SNAP}.b_late (id INT PRIMARY KEY) ENGINE=InnoDB`)
    await pool.query(`CREATE TABLE ${SNAP}.d (i INT)`)
    await pool.query(`INSERT INTO ${SNAP}.d VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)`)
    await pool.query(
      `INSERT INTO ${SNAP}.a_big SELECT a.i + b.i*10 + c.i*100 + e.i*1000 + f.i*10000 + 1, REPEAT('x', 90) FROM ${SNAP}.d a, ${SNAP}.d b, ${SNAP}.d c, ${SNAP}.d e, ${SNAP}.d f`,
    )
    await pool.query(`DROP TABLE ${SNAP}.d`)
    await pool.query(`INSERT INTO ${SNAP}.b_late VALUES (1), (2)`)
    let fired = false
    try {
      const o = await run(
        { scope: base(SNAP), format: 'csv', compression: 'zip' },
        {
          onProgress: (p) => {
            if (!fired && (p.rows ?? 0) > 0) {
              fired = true
              void pool.query(`INSERT INTO ${SNAP}.b_late VALUES (3), (4), (5)`)
            }
          },
        },
      )
      expect(o.state).toBe('done')
      expect(fired).toBe(true)
      await new Promise((r) => setTimeout(r, 200))
      const [r] = await pool.query(`SELECT COUNT(*) AS n FROM ${SNAP}.b_late`)
      expect(Number((r as { n: unknown }[])[0]!.n)).toBe(5)
      const files = unzipSync(new Uint8Array(bytesOf(o)))
      const late = Buffer.from(files[`${SNAP}_b_late.csv`] ?? files[Object.keys(files).find((f) => f.includes('b_late')) ?? ''] ?? new Uint8Array()).toString()
      expect(late.trim().split('\n')).toEqual(['id', '1', '2'])
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS ${SNAP}`)
    }
  }, 120_000)

  test('lock tables: export completes and the locks are gone (FR-IOX-017)', async () => {
    const o = await run({ scope: base(), format: 'sql', compression: 'none', lock: true, options: { content: 'data' } })
    expect(o.state).toBe('done')
    // a write goes through at once
    await pool.query(`INSERT INTO ${DB}.z_parent VALUES (99, 'late')`)
    await pool.query(`DELETE FROM ${DB}.z_parent WHERE id = 99`)
  }, 120_000)

  test('CSV: default, header, NULL, binary, BOM, Excel preset, formulas (FR-IO-006, 023)', async () => {
    const o = await run({ scope: { kind: 'table', db: DB, table: 'types_t' }, format: 'csv', compression: 'none', options: { bom: true } })
    expect(o.state).toBe('done')
    expect(o.contentType).toBe('text/csv; charset=utf-8')
    const buf = bytesOf(o)
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    const text = buf.toString('utf8').slice(1)
    expect(text.split('\n')[0]).toBe('id,t_tiny,t_big,t_bigu,t_dec,t_float,t_double,t_bit,t_year,t_date,t_time,t_dt,t_ts,t_char,t_vc,t_text,t_enum,t_set,t_bin,t_vbin,t_blob,t_json,t_geo,g_val')
    const rows: (string | null)[][] = []
    for await (const r of readCsvRows((async function* () { yield text })(), { separator: ',', enclosure: '"', escape: '"', lineEnding: 'auto', nullText: '', header: true, skipRows: 0 })) if (!r.isHeader) rows.push(r.fields)
    expect(rows).toHaveLength(3)
    expect(rows[0]![2]).toBe('9007199254740993')
    expect(rows[0]![3]).toBe('18446744073709551615')
    expect(rows[0]![4]).toBe('12345678901234.123456')
    expect(rows[0]![14]).toContain('日本語 😀')
    expect(rows[0]![18]).toBe('0x00ff10aa')
    expect(rows[1]!.slice(1).every((v) => v === null)).toBe(true) // NULL row: empty unquoted fields
    // preset
    const x = textOf(await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'csv', compression: 'none', options: { preset: 'excel' } }))
    expect(x).toBe('id;name\r\n1;one\r\n2;zwei\r\n')
    // formula neutralisation, on by default and off by the permitted opt-out
    await pool.query(`INSERT INTO ${DB}.z_parent VALUES (50, '=cmd|'' /C calc''!A1'), (51, '-5 apples')`)
    try {
      const on = textOf(await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'csv', compression: 'none' }))
      expect(on).toContain("50,'=cmd|' /C calc'!A1")
      expect(on).toContain("51,'-5 apples")
      const off = textOf(await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'csv', compression: 'none' }, { neutraliseFormulas: false }))
      expect(off).toContain('50,=cmd|')
      // a negative number in a numeric column is data, not a formula
      await pool.query(`INSERT INTO ${DB}.a_child VALUES (-3, 1)`)
      const num = textOf(await run({ scope: { kind: 'table', db: DB, table: 'a_child' }, format: 'csv', compression: 'none' }))
      expect(num).toContain('-3,1')
      await pool.query(`DELETE FROM ${DB}.a_child WHERE id = -3`)
    } finally {
      await pool.query(`DELETE FROM ${DB}.z_parent WHERE id IN (50, 51)`)
    }
  })

  test('JSON: shape, exact numbers, hex binary, pretty and compact (FR-IO-007)', async () => {
    const o = await run({ scope: { kind: 'table', db: DB, table: 'types_t' }, format: 'json', compression: 'none', options: { pretty: false } })
    expect(o.contentType).toBe('application/json')
    const doc = JSON.parse(textOf(o)) as { type: string; name?: string; data?: Record<string, unknown>[]; columns?: { name: string; type: string }[] }[]
    expect(doc[0]).toMatchObject({ type: 'header', generator: 'DBLoom' })
    expect(doc[1]).toEqual({ type: 'database', name: DB })
    const table = doc[2]!
    expect(table.type).toBe('table')
    expect(table.columns![0]).toMatchObject({ name: 'id' })
    expect(table.columns![0]!.type).toMatch(/^int/)
    const first = table.data![0]!
    expect(first.t_big).toBe('9007199254740993') // beyond IEEE double: string
    expect(first.t_tiny).toBe(7)
    expect(first.t_blob).toBe('0xdeadbeef')
    expect(first.t_bin).toBe('0x00ff10aa')
    expect(first.t_vbin).toBe('0x00')
    expect(first.t_dec).toBe('12345678901234.123456')
    expect(first.t_vc).toContain('😀')
    expect(table.data![1]!.t_big).toBeNull()
    const pretty = textOf(await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'json', compression: 'none', options: { unicode: false } }))
    expect(pretty).toContain('\n  {')
    expect(JSON.parse(pretty)).toHaveLength(3)
  })

  test('gzip and zip, separate files, template per object, size skip (FR-IO-008, SCN-053)', async () => {
    const gz = await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'csv', compression: 'gzip' })
    expect(gz.fileName).toBe('z_parent_' + DB + '.csv.gz')
    expect(gz.contentType).toBe('application/gzip')
    expect(gunzipSync(bytesOf(gz)).toString()).toBe('id,name\n1,one\n2,zwei\n')

    // CSV of a database is a zip with one entry per table and view; the size filter lists what it left out
    const z = await run({
      scope: { kind: 'database', db: DB, maxTableMiB: 1 },
      format: 'csv',
      compression: 'none',
      fileNameTemplate: '@DATABASE@_@TABLE@',
    })
    expect(z.state).toBe('done_with_skips')
    expect(z.fileName).toBe(`${DB}.csv.zip`)
    expect(z.result.notes.join(' ')).toContain('zip')
    const entries = unzipSync(new Uint8Array(bytesOf(z)))
    expect(Object.keys(entries).sort()).toEqual(
      ['a_child', 'a_view_top', 'b_view_base', 'cyc_a', 'cyc_b', 'types_t', 'z_parent'].map((t) => `${DB}_${t}.csv`).sort(),
    )
    expect(z.result.skipped.map((s) => s.object)).toEqual([`${DB}.bulk`])
    expect(Buffer.from(entries[`${DB}_z_parent.csv`]!).toString()).toBe('id,name\n1,one\n2,zwei\n')

    // SQL, separate files in a zip: each file is self-contained
    const s = await run({ scope: { kind: 'database', db: DB, tables: ['z_parent', 'a_child'] }, format: 'sql', compression: 'zip', separateFiles: true })
    const sfiles = unzipSync(new Uint8Array(bytesOf(s)))
    expect(Object.keys(sfiles).sort()).toEqual([`${DB}_a_child.sql`, `${DB}_z_parent.sql`])
    expect(Buffer.from(sfiles[`${DB}_z_parent.sql`]!).toString()).toContain('CREATE TABLE `z_parent`')

    // JSON of several tables is one document; separate files make one document per table
    const j = await run({ scope: { kind: 'database', db: DB, tables: ['z_parent', 'a_child'] }, format: 'json', compression: 'none' })
    const jd = JSON.parse(textOf(j)) as { type: string; name?: string }[]
    expect(jd.filter((e) => e.type === 'table').map((e) => e.name)).toEqual(['a_child', 'z_parent'])
    const jz = await run({ scope: { kind: 'database', db: DB, tables: ['z_parent', 'a_child'] }, format: 'json', compression: 'zip', separateFiles: true })
    expect(Object.keys(unzipSync(new Uint8Array(bytesOf(jz)))).sort()).toEqual([`${DB}_a_child.json`, `${DB}_z_parent.json`])
  }, 120_000)

  test('server scope writes CREATE DATABASE and USE for each database', async () => {
    const o = await run({ scope: { kind: 'server', databases: [DB] }, format: 'sql', compression: 'none', options: { content: 'structure' } })
    expect(o.state).toBe('done')
    expect(textOf(o)).toContain(`USE \`${DB}\`;`)
    expect(o.fileName).toMatch(/^127\.0\.0\.1\.sql$/)
  })

  test('row range of one table, ordered by the key (UI-IOX-020)', async () => {
    const o = await run({ scope: { kind: 'table', db: DB, table: 'bulk', range: { offset: 10, count: 3 } }, format: 'csv', compression: 'none' })
    expect(textOf(o)).toBe('id,v,n\n11,row-11,1.57\n12,row-12,1.71\n13,row-13,1.86\n')
  })

  test('unknown names are refused against the catalog (SEC-TGT-116)', async () => {
    const a = await run({ scope: { kind: 'table', db: DB, table: 'nope' }, format: 'sql', compression: 'none' })
    expect(a.state).toBe('failed')
    expect(a.result.error?.code).toBe('invalid_request')
    const b = await run({ scope: { kind: 'database', db: DB, tables: ['z_parent', "x'; DROP TABLE y; --"] }, format: 'sql', compression: 'none' })
    expect(b.result.error?.code).toBe('invalid_request')
    expect(spoolFiles()).toHaveLength(spoolFiles().length) // nothing committed for failures (checked in the next test)
  })

  test('failures never leave an output; unreadable objects fail or are skipped (FR-IO-010, SCN-055)', async () => {
    const user = `io_lim_${product}`
    await pool.query(`DROP USER IF EXISTS '${user}'@'%'`)
    await pool.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'pw'`)
    await pool.query(`GRANT SELECT ON ${DB}.z_parent TO '${user}'@'%'`)
    await pool.query(`GRANT INSERT ON ${DB}.a_child TO '${user}'@'%'`)
    const limited = createPool({ host: '127.0.0.1', port, user, password: 'pw', connectionLimit: 3, charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
    try {
      const before = spoolFiles().length
      const failed = await run({ scope: { kind: 'database', db: DB, tables: ['a_child', 'z_parent'] }, format: 'sql', compression: 'none', options: { content: 'data' } }, { pool: limited as never })
      expect(failed.state).toBe('failed')
      expect(failed.file).toBeUndefined()
      expect(failed.result.error?.errno).toBe(1142)
      expect(failed.result.error?.message).toContain('a_child')
      expect(spoolFiles()).toHaveLength(before)

      const skipped = await run({ scope: { kind: 'database', db: DB, tables: ['a_child', 'z_parent'] }, format: 'sql', compression: 'none', skipUnreadable: true, options: { content: 'data' } }, { pool: limited as never })
      expect(skipped.state).toBe('done_with_skips')
      expect(skipped.result.skipped).toHaveLength(1)
      expect(skipped.result.skipped[0]!.object).toBe(`${DB}.a_child`)
      const sql = textOf(skipped)
      expect(sql).toContain(`-- skipped: ${DB}.a_child`)
      expect(sql).toContain("INSERT INTO `z_parent`")

      // JSON gets a skipped element
      const json = await run({ scope: { kind: 'database', db: DB, tables: ['a_child', 'z_parent'] }, format: 'json', compression: 'none', skipUnreadable: true }, { pool: limited as never })
      const doc = JSON.parse(textOf(json)) as { type: string }[]
      expect(doc.filter((e) => e.type === 'skipped')).toHaveLength(1)

      // a single table that cannot be read fails even with the skip option (nothing to deliver)
      const single = await run({ scope: { kind: 'table', db: DB, table: 'a_child' }, format: 'csv', compression: 'none', skipUnreadable: true }, { pool: limited as never })
      expect(single.state).toBe('failed')
    } finally {
      await limited.end()
      await pool.query(`DROP USER IF EXISTS '${user}'@'%'`)
    }
  }, 120_000)

  test('size cap and time limit fail the export without a file (ST-158, ST-111)', async () => {
    const before = spoolFiles().length
    const big = await run({ scope: { kind: 'table', db: DB, table: 'bulk' }, format: 'sql', compression: 'none' }, { limits: { maxExportBytes: 64 * 1024, jobMs: 300_000 } })
    expect(big.state).toBe('failed')
    expect(big.result.error?.code).toBe('export_too_large')
    const slow = await run({ scope: { kind: 'table', db: DB, table: 'bulk' }, format: 'sql', compression: 'none' }, { limits: { maxExportBytes: 1024 * MiB, jobMs: 1 } })
    expect(slow.state).toBe('failed')
    expect(slow.result.error?.code).toBe('time_limit')
    expect(spoolFiles()).toHaveLength(before)
  })

  test('cancel stops the query, destroys the connection and removes the spool (SCN-055, G4)', async () => {
    const processes = async () => {
      const [r] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT %bulk%' AND INFO NOT LIKE '%PROCESSLIST%'")
      return Number((r as { n: unknown }[])[0]!.n)
    }
    const before = spoolFiles().length
    const ac = new AbortController()
    let hook: (() => void | Promise<void>) | undefined
    let rowsSeen = 0
    const pending = run(
      { scope: { kind: 'table', db: DB, table: 'bulk' }, format: 'sql', compression: 'gzip' },
      {
        signal: ac.signal,
        onCancel: (h) => (hook = h),
        onProgress: (p) => {
          rowsSeen = p.rows ?? rowsSeen
          if (rowsSeen >= 500 && hook && !ac.signal.aborted) {
            ac.abort()
            void hook()
          }
        },
      },
    )
    const o = await pending
    expect(o.state).toBe('cancelled')
    expect(o.file).toBeUndefined()
    expect(o.result.error?.code).toBe('cancelled')
    expect(spoolFiles()).toHaveLength(before)
    for (let i = 0; i < 25 && (await processes()) > 0; i++) await new Promise((r) => setTimeout(r, 200))
    expect(await processes()).toBe(0)
  }, 60_000)

  test('text view stops at 2 MiB on a character boundary (FR-IO-009)', async () => {
    await pool.query(`CREATE TABLE ${DB}.wide (id INT PRIMARY KEY, s VARCHAR(200)) ENGINE=InnoDB`)
    await pool.query(`INSERT INTO ${DB}.wide SELECT id, REPEAT('日本語', 60) FROM ${DB}.bulk WHERE id <= 6000`)
    try {
      const o = await run({ scope: { kind: 'table', db: DB, table: 'wide' }, format: 'csv', compression: 'none', view: 'text' })
      expect(o.state).toBe('done')
      expect(o.textView).toBe(true)
      expect(o.contentType).toBe('text/plain; charset=utf-8')
      const buf = bytesOf(o)
      expect(buf.length).toBeLessThanOrEqual(2 * MiB)
      expect(buf.length).toBeGreaterThan(2 * MiB - 8)
      const text = buf.toString('utf8')
      expect(text).not.toContain('�')
      expect(o.result.notes.join(' ')).toContain('2 MiB')
      // a small export is whole and not marked
      const small = await run({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'sql', compression: 'none', view: 'text' })
      expect(small.result.notes).toEqual([])
    } finally {
      await pool.query(`DROP TABLE ${DB}.wide`)
    }
  }, 120_000)

  describe('result scope (FR-IO-003, DATA-ISS-105)', () => {
    const env = (): SqlRunEnv => ({
      session: { idHash: 'exp-result', target: { host: '127.0.0.1', port, username: 'root' }, pool },
      guard: { forcedReadOnly: false, sessionReadOnly: false },
      tokens: createTokenIssuer(),
      limits: { ...DEFAULT_SQL_LIMITS, timeoutMs: 60_000 },
      plans: new PlanStore(),
      registry: new RunRegistry(),
    })
    const openResult: ExportDeps['openResult'] = (r) => openResultStream(env(), { ...r, raw: true })

    test('DISTINCT, alias and computed columns are typed by the result; the file imports again', async () => {
      const o = await run(
        { scope: { kind: 'result', db: DB, text: 'SELECT DISTINCT t_vc AS txt, t_big + 1 AS next_big, t_bin AS b FROM types_t WHERE t_vc IS NOT NULL', statementIndex: 0 }, format: 'sql', compression: 'none' },
        { openResult },
      )
      expect(o.state, JSON.stringify(o.result)).toBe('done')
      const sql = textOf(o)
      expect(sql).toMatch(/INSERT INTO `types_t` \(`txt`,`next_big`,`b`\) VALUES/)
      expect(sql).toContain('9007199254740994') // number literal, not a quoted string
      expect(sql).toContain('0x00ff10aa')
      expect(sql).not.toContain('CREATE TABLE')
    })

    test('CSV of a result keeps binary as hex, exact decimals and the header', async () => {
      const o = await run(
        { scope: { kind: 'result', db: DB, text: 'SELECT id, t_dec, t_blob FROM types_t ORDER BY id', statementIndex: 0 }, format: 'csv', compression: 'none' },
        { openResult },
      )
      expect(o.state).toBe('done')
      const lines = textOf(o).split('\n')
      expect(lines[0]).toBe('id,t_dec,t_blob')
      expect(lines[1]).toBe('1,12345678901234.123456,0xdeadbeef')
      expect(o.fileName).toBe('export.csv')
    })

    test('a statement that is not a plain read is refused', async () => {
      const o = await run(
        { scope: { kind: 'result', db: DB, text: 'DELETE FROM z_parent', statementIndex: 0 }, format: 'sql', compression: 'none' },
        { openResult },
      )
      expect(o.state).toBe('failed')
      expect(existsSync(o.file?.path ?? '/nope')).toBe(false)
    })
  })

  test('streams a large table with flat memory (FR-IO-003)', async () => {
    const before = process.memoryUsage().heapUsed
    let peak = 0
    const o = await run(
      { scope: { kind: 'table', db: DB, table: 'bulk' }, format: 'csv', compression: 'gzip' },
      { onProgress: () => (peak = Math.max(peak, process.memoryUsage().heapUsed)) },
    )
    expect(o.state).toBe('done')
    expect(o.result.rows).toBe(100_000)
    expect(peak - before).toBeLessThan(120 * MiB)
  }, 120_000)
})
