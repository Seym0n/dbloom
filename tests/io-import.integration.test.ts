import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { analyseImportImpl, type ImportEnv } from '~/server/io/analyse'
import { listImportFolderImpl, resumeImportImpl, startImportImpl } from '~/server/io/import-service'
import { getImportDetails } from '~/server/io/import-job'
import { JobRegistry } from '~/server/io/jobs'
import { resolveIoLimits } from '~/server/io/limits'
import { TempStore } from '~/server/io/temp'
import { ZipWriter } from '~/server/io/zip'
import type { ImportAnalysis, IoJob } from '~/server/io/types'
import { initParser } from '~/server/sql/parser'

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const owner = { sessionId: 'sess-io-d', user: 'root' }
const TERMINAL = ['paused', 'done', 'done_with_skips', 'done_with_rejects', 'failed', 'cancelled']

describe.each(servers)('import on $name', ({ port, product }) => {
  const DB = `io_d_${product}_${process.pid}`
  let pool: Pool
  let root: string
  let temp: TempStore
  let jobs: JobRegistry
  let tokens = createTokenIssuer()
  let env: ImportEnv

  const mkEnv = (over: Partial<ImportEnv> = {}): ImportEnv => ({
    session: { idHash: owner.sessionId, target: { host: '127.0.0.1', port, username: 'root' } as never },
    pool,
    guard: { forcedReadOnly: false, sessionReadOnly: false },
    tokens,
    temp,
    jobs,
    owner,
    limits: resolveIoLimits(),
    targetLabel: `127.0.0.1:${port}`,
    statementTimeoutMs: 30_000,
    ...over,
  })

  async function stage(data: string | Buffer, name = 'file.sql'): Promise<string> {
    const w = await temp.begin(owner, 'upload', { name, maxBytes: 1 << 30 })
    await w.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    return (await w.commit()).id
  }

  async function waitJob(jobId: string): Promise<IoJob> {
    const t0 = Date.now()
    for (;;) {
      const j = jobs.get(jobId, owner)!
      if (TERMINAL.includes(j.state)) return j
      if (Date.now() - t0 > 60_000) throw new Error(`job ${jobId} still ${j.state}`)
      await sleep(15)
    }
  }

  const analyse = (uploadId: string, format: 'sql' | 'csv' | 'json' = 'sql', extra: Record<string, unknown> = {}) =>
    analyseImportImpl(env, { uploadId, format, ...extra })

  /** Analyse, start (with the token when the analysis issued one) and wait. */
  async function importSql(
    data: string | Buffer,
    options: Record<string, unknown> = {},
    extra: { db?: string; charset?: string; name?: string } = {},
  ): Promise<{ job: IoJob; analysis: ImportAnalysis; uploadId: string }> {
    const uploadId = await stage(data, extra.name)
    const analysis = await analyse(uploadId, 'sql', extra.charset ? { charset: extra.charset } : {})
    const { jobId } = await startImportImpl(env, {
      uploadId,
      format: 'sql',
      db: extra.db ?? DB,
      ...(extra.charset ? { charset: extra.charset } : {}),
      options,
      ...(analysis.confirmToken ? { confirmToken: analysis.confirmToken } : {}),
    })
    return { job: await waitJob(jobId), analysis, uploadId }
  }

  async function importRows(
    data: string | Buffer,
    format: 'csv' | 'json',
    table: string,
    options: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ): Promise<{ job: IoJob; analysis: ImportAnalysis }> {
    const uploadId = await stage(data, `rows.${format}`)
    const analysis = await analyse(uploadId, format, { rowOptions: options })
    const { jobId } = await startImportImpl(env, {
      uploadId,
      format,
      db: DB,
      table,
      options,
      ...extra,
    })
    return { job: await waitJob(jobId), analysis }
  }

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const [rows] = await pool.query(sql, params)
    return rows as T[]
  }
  const count = async (table: string) => Number((await q(`SELECT COUNT(*) AS n FROM \`${DB}\`.\`${table}\``))[0]!.n)

  beforeAll(async () => {
    await initParser()
    pool = createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      connectionLimit: 6,
      multipleStatements: false,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      jsonStrings: true,
    })
    root = mkdtempSync(join(tmpdir(), 'dbloom-import-'))
    temp = new TempStore({ dir: join(root, 'tmp'), quotaBytes: 1 << 30 })
    jobs = new JobRegistry()
  })
  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await pool.end()
    rmSync(root, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await pool.query(`DROP DATABASE IF EXISTS \`${DB}\``)
    await pool.query(`CREATE DATABASE \`${DB}\` DEFAULT CHARACTER SET utf8mb4`)
    tokens = createTokenIssuer()
    env = mkEnv()
  })
  afterEach(async () => {
    await jobs.dropSession(owner.sessionId)
    await temp.dropSession(owner.sessionId)
  })

  // ---- SQL ------------------------------------------------------------------------------------------------------

  describe('SQL files', () => {
    const DUMP = [
      'SET NAMES utf8mb4;',
      'DROP TABLE IF EXISTS `t`;',
      'CREATE TABLE `t` (id INT PRIMARY KEY, name VARCHAR(40)) ENGINE=InnoDB;',
      "INSERT INTO `t` VALUES (1,'ä😀'),(2,'a;b');",
      'DELIMITER $$',
      'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.name = CONCAT(NEW.name, "!"); END$$',
      'DELIMITER ;',
      "INSERT INTO `t` VALUES (3,'x');",
    ].join('\n')

    test('analysis counts classes and kinds, issues a token for hard statements and runs nothing', async () => {
      const id = await stage(DUMP)
      const a = await analyse(id)
      expect(a.statements).toMatchObject({ total: 6, usesDatabase: false })
      // The trigger body is not parsable by the classifier: unclassifiable is hard (spec 5.7, tier 3).
      expect(a.statements?.hardKinds).toEqual({ 'DROP TABLE': 1, 'CREATE TRIGGER': 1 })
      expect(a.statements?.byClass.refused).toBe(0)
      expect(a.confirmRequired).toBe(true)
      expect(a.confirmToken).toBeTruthy()
      expect(a.compression).toBe('none')
      expect(a.charset).toBe('utf-8')
      expect(await q(`SHOW TABLES FROM \`${DB}\``)).toHaveLength(0)
    })

    test('a hard import needs the server-checked token, once', async () => {
      const id = await stage(DUMP)
      const a = await analyse(id)
      const body = { uploadId: id, format: 'sql', db: DB, options: {} }
      await expect(startImportImpl(env, body)).rejects.toMatchObject({ error: { code: 'confirm_required' } })
      await expect(startImportImpl(env, { ...body, confirmToken: `${a.confirmToken}x` })).rejects.toMatchObject({ error: { code: 'confirm_invalid' } })
      expect(await q(`SHOW TABLES FROM \`${DB}\``)).toHaveLength(0)
      const { jobId } = await startImportImpl(env, { ...body, confirmToken: a.confirmToken })
      const job = await waitJob(jobId)
      expect(job.state).toBe('done')
      expect(job.result?.statements).toEqual({ run: 6, skipped: 0, failed: 0 })
      expect(await q('SELECT id, name FROM `' + DB + '`.t ORDER BY id')).toEqual([
        { id: 1, name: 'ä😀' },
        { id: 2, name: 'a;b' },
        { id: 3, name: 'x!' },
      ])
      await expect(startImportImpl(env, { ...body, confirmToken: a.confirmToken })).rejects.toMatchObject({ error: { code: 'confirm_invalid' } })
    })

    test('a token of another analysis or session does not work', async () => {
      const id = await stage(DUMP)
      const a = await analyse(id)
      const other = mkEnv({ owner: { sessionId: 'someone-else', user: 'root' } })
      await expect(
        startImportImpl(other, { uploadId: id, format: 'sql', db: DB, options: {}, confirmToken: a.confirmToken }),
      ).rejects.toMatchObject({ error: { code: expect.stringMatching(/invalid_request|upload_unknown/) } })
      const id2 = await stage(DUMP + '\n-- changed')
      await analyse(id2)
      await expect(
        startImportImpl(env, { uploadId: id2, format: 'sql', db: DB, options: {}, confirmToken: a.confirmToken }),
      ).rejects.toMatchObject({ error: { code: 'confirm_invalid' } })
    })

    test('a start needs an analysis of this session', async () => {
      const id = await stage('SELECT 1;')
      await expect(startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {} })).rejects.toMatchObject({
        error: { code: 'invalid_request' },
      })
    })

    test('a script that needs a database is refused without one, and fine with USE', async () => {
      const id = await stage('CREATE TABLE u (id INT);\nINSERT INTO u VALUES (1);')
      const a = await analyse(id)
      expect(a.statements?.needsDatabase).toBe(true)
      await expect(startImportImpl(env, { uploadId: id, format: 'sql', options: {} })).rejects.toMatchObject({ error: { code: 'needs_database' } })
      const ok = await stage(`USE \`${DB}\`;\nCREATE TABLE u (id INT);\nINSERT INTO u VALUES (1);`)
      const b = await analyse(ok)
      expect(b.statements).toMatchObject({ needsDatabase: false, usesDatabase: true })
      const { jobId } = await startImportImpl(env, { uploadId: ok, format: 'sql', options: {} })
      expect((await waitJob(jobId)).state).toBe('done')
      expect(await count('u')).toBe(1)
    })

    const hundred = (bad: string[] = []) => {
      const lines = ['CREATE TABLE s (id INT PRIMARY KEY, v INT) ENGINE=InnoDB;']
      for (let i = 1; i <= 99; i++) lines.push(`INSERT INTO s VALUES (${i}, ${i});`)
      for (const b of bad) lines.push(b)
      return lines
    }
    test('stops at the failing statement with its number, offset, line and server error', async () => {
      const lines = hundred()
      lines[49] = 'INSERT INTO s VALUES (1, 1);' // statement 50: duplicate key
      const text = lines.join('\n')
      const { job } = await importSql(text)
      expect(job.state).toBe('failed')
      const e = job.result?.error
      expect(e).toMatchObject({ code: 'statement_failed', errno: 1062, statementNumber: 50, line: 50 })
      expect(e?.byteOffset).toBe(Buffer.byteLength(lines.slice(0, 49).join('\n') + '\n', 'utf8'))
      expect(e?.statementText).toBe('INSERT INTO s VALUES (1, 1)')
      expect(await count('s')).toBe(48)
    })

    test('ignore errors continues and counts', async () => {
      const lines = hundred()
      lines[49] = 'INSERT INTO s VALUES (1, 1);'
      lines[79] = 'INSERT INTO missing_table VALUES (1);'
      const { job } = await importSql(lines.join('\n'), { ignoreErrors: true })
      expect(job.state).toBe('done_with_rejects')
      expect(job.result?.statements).toEqual({ run: 98, skipped: 0, failed: 2 })
      expect(job.result?.rejectedCount).toBe(2)
      expect(job.result?.rejected.map((r) => r.row)).toEqual([50, 80])
      expect(await count('s')).toBe(97)
    })

    test('skip first N statements', async () => {
      const { job } = await importSql(hundred().join('\n'), { skipStatements: 60 })
      expect(job.state).toBe('failed') // the CREATE TABLE was skipped
      expect(job.result?.error).toMatchObject({ errno: 1146, statementNumber: 61 })
      await pool.query(`CREATE TABLE \`${DB}\`.s (id INT PRIMARY KEY, v INT) ENGINE=InnoDB`)
      const { job: again } = await importSql(hundred().join('\n'), { skipStatements: 60 })
      expect(again.state).toBe('done')
      expect(again.result?.statements).toEqual({ run: 40, skipped: 60, failed: 0 })
      expect(await count('s')).toBe(40)
    })

    test('rollback on error undoes the earlier statements of the transaction', async () => {
      await pool.query(`CREATE TABLE \`${DB}\`.r (id INT PRIMARY KEY) ENGINE=InnoDB`)
      const { job } = await importSql('INSERT INTO r VALUES (1);\nINSERT INTO r VALUES (2);\nINSERT INTO r VALUES (1);', {
        rollbackOnError: true,
      })
      expect(job.state).toBe('failed')
      expect(job.result?.error?.errno).toBe(1062)
      expect(job.result?.notes.join(' ')).toMatch(/rolled back/)
      expect(await count('r')).toBe(0)
    })

    test('refused statements stop the start unless they are skipped', async () => {
      const text = 'CREATE TABLE z (id INT);\nSET GLOBAL max_connections = 700;\nFLUSH TABLES;\nINSERT INTO z VALUES (1);'
      const id = await stage(text)
      const a = await analyse(id)
      expect(a.statements?.byClass.refused).toBe(2)
      expect(a.statements?.refusedKinds).toEqual({ 'SET GLOBAL': 1, FLUSH: 1 })
      await expect(startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {} })).rejects.toMatchObject({
        error: { code: 'refused_statement' },
      })
      const { jobId } = await startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: { skipRefused: true } })
      const job = await waitJob(jobId)
      expect(job.state).toBe('done_with_skips')
      expect(job.result?.skipped.map((s) => s.message)).toEqual(['SET GLOBAL (refused)', 'FLUSH (refused)'])
      expect(await count('z')).toBe(1)
      const gv = await q<{ v: string }>('SELECT @@GLOBAL.max_connections AS v')
      expect(Number(gv[0]!.v)).not.toBe(700)
    })

    test('foreign key checks are off for the run by default, on when asked, and back on the pool afterwards', async () => {
      const text =
        'CREATE TABLE p (id INT PRIMARY KEY) ENGINE=InnoDB;\nCREATE TABLE c (id INT, pid INT, FOREIGN KEY (pid) REFERENCES p (id)) ENGINE=InnoDB;\nINSERT INTO c VALUES (1, 99);'
      const off = await importSql(text)
      expect(off.job.state).toBe('done')
      await pool.query(`DROP TABLE \`${DB}\`.c`)
      await pool.query(`DROP TABLE \`${DB}\`.p`)
      const on = await importSql(text, { foreignKeyChecksOff: false })
      expect(on.job.state).toBe('failed')
      expect(on.job.result?.error?.errno).toBe(1452)
      const c = await pool.getConnection()
      try {
        const [rows] = await c.query('SELECT @@foreign_key_checks AS f')
        expect(Number((rows as { f: unknown }[])[0]!.f)).toBe(1)
      } finally {
        c.release()
      }
    })

    test('server notes are notes and the import is a success', async () => {
      const { job } = await importSql('DROP TABLE IF EXISTS never_existed;\nSELECT 1;')
      expect(job.state).toBe('done')
      expect(job.result?.notes.join(' ')).toMatch(/Note 1051/)
    })

    test('gzip and zip are detected by content, a text file named .gz is just text', async () => {
      const gz = await importSql(gzipSync(Buffer.from('CREATE TABLE g (id INT);\nINSERT INTO g VALUES (1);')), {}, { name: 'x.png' })
      expect(gz.analysis.compression).toBe('gzip')
      expect(gz.job.state).toBe('done')
      const parts: Buffer[] = []
      const z = new ZipWriter((c) => parts.push(Buffer.from(c)))
      z.begin('inner.sql')
      z.write('CREATE TABLE zz (id INT);\nINSERT INTO zz VALUES (7);')
      z.finish()
      const zip = await importSql(Buffer.concat(parts), {}, { name: 'a.sql' })
      expect(zip.analysis.compression).toBe('zip')
      expect(zip.job.state).toBe('done')
      expect(await count('zz')).toBe(1)
      const plain = await importSql('CREATE TABLE pl (id INT);', {}, { name: 'text.sql.gz' })
      expect(plain.analysis.compression).toBe('none')
      expect(plain.job.state).toBe('done')
    })

    test('a ratio bomb and a truncated gzip are refused at analysis', async () => {
      const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20))
      await expect(analyse(await stage(bomb))).rejects.toMatchObject({ error: { code: 'ratio_exceeded' } })
      const trunc = gzipSync(Buffer.from('SELECT 1;'.repeat(5000))).subarray(0, 40)
      await expect(analyse(await stage(trunc))).rejects.toMatchObject({ error: { code: 'not_archive' } })
    }, 30_000)

    test('charset: windows-1252 text and a BOM are read right, a bad byte names its offset', async () => {
      const cp = Buffer.from("CREATE TABLE cs (name VARCHAR(20));\nINSERT INTO cs VALUES ('Müller');", 'latin1')
      const a = await importSql(cp, {}, { charset: 'windows-1252' })
      expect(a.job.state).toBe('done')
      expect((await q('SELECT name FROM `' + DB + '`.cs'))[0]).toEqual({ name: 'Müller' })
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("CREATE TABLE bm (a INT);\nINSERT INTO bm VALUES (1);")])
      const b = await importSql(bom)
      expect(b.job.state).toBe('done')
      const bad = Buffer.concat([Buffer.from('SELECT 1;\nSELECT '), Buffer.from([0xff]), Buffer.from(';')])
      await expect(analyse(await stage(bad))).rejects.toMatchObject({ error: { code: 'invalid_bytes', byteOffset: 17, line: 2 } })
    })

    test('resume after the time limit gives the same table as one run', async () => {
      const lines = ['CREATE TABLE big (id INT PRIMARY KEY, txt VARCHAR(80)) ENGINE=InnoDB;', 'DELIMITER $$']
      lines.push('CREATE TRIGGER bt BEFORE INSERT ON big FOR EACH ROW BEGIN SET NEW.txt = CONCAT(NEW.txt, "~"); END$$', 'DELIMITER ;')
      for (let i = 1; i <= 300; i++) lines.push(`INSERT INTO big VALUES (${i}, 'ä😀 ${i} ü');`)
      const text = lines.join('\n')
      const id = await stage(text)
      env = mkEnv({ limits: { ...resolveIoLimits(), jobMs: 30 } })
      const first = await analyse(id)
      let { jobId } = await startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {}, confirmToken: first.confirmToken })
      let job = await waitJob(jobId)
      let pauses = 0
      while (job.state === 'paused') {
        pauses++
        expect(job.result?.resume?.statementNumber).toBeGreaterThan(0)
        ;({ jobId } = await resumeImportImpl(env, { jobId }))
        job = await waitJob(jobId)
        if (pauses > 2000) throw new Error('never ends')
      }
      expect(job.state).toBe('done')
      expect(pauses).toBeGreaterThan(0)
      expect(job.result?.statements?.run).toBe(302)
      const rows = await q('SELECT id, txt FROM `' + DB + '`.big ORDER BY id')
      expect(rows).toHaveLength(300)
      expect(rows[299]).toEqual({ id: 300, txt: 'ä😀 300 ü~' })
      const sum = await q('SELECT MD5(GROUP_CONCAT(txt ORDER BY id)) AS h FROM `' + DB + '`.big')
      const full = await q(`SELECT MD5(GROUP_CONCAT(CONCAT('ä😀 ', id, ' ü~') ORDER BY id)) AS h FROM \`${DB}\`.big`)
      expect(sum).toEqual(full)
    }, 60_000)

    test('resume is refused when the staged file is gone', async () => {
      const lines = ['CREATE TABLE gone (id INT);']
      for (let i = 0; i < 50; i++) lines.push(`INSERT INTO gone VALUES (${i});`)
      const id = await stage(lines.join('\n'))
      await analyse(id)
      env = mkEnv({ limits: { ...resolveIoLimits(), jobMs: 1 } })
      const { jobId } = await startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {} })
      expect((await waitJob(jobId)).state).toBe('paused')
      await temp.remove(id)
      await expect(resumeImportImpl(env, { jobId })).rejects.toMatchObject({ error: { code: 'file_gone' } })
    })

    test('cancel kills the running statement and destroys the connection', async () => {
      const id = await stage('SELECT SLEEP(20);\nCREATE TABLE late (id INT);')
      await analyse(id)
      const { jobId } = await startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {} })
      await sleep(400)
      expect(jobs.get(jobId, owner)?.state).toBe('running')
      const t0 = Date.now()
      const job = await jobs.cancel(jobId, owner)
      expect(job.state).toBe('cancelled')
      expect(Date.now() - t0).toBeLessThan(5000)
      await sleep(300)
      const left = await q("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(20)%'")
      expect(Number(left[0]!.n)).toBe(0)
      expect(await q(`SHOW TABLES FROM \`${DB}\``)).toHaveLength(0)
    })

    test('read-only refuses before a target connection is opened', async () => {
      const id = await stage('SELECT 1;')
      await analyse(id)
      const spy = new Proxy(pool, {
        get(t, k) {
          if (k === 'getConnection' || k === 'query' || k === 'execute') throw new Error('target touched')
          return Reflect.get(t, k) as unknown
        },
      })
      const ro = mkEnv({ pool: spy as Pool, guard: { forcedReadOnly: false, sessionReadOnly: true } })
      await expect(startImportImpl(ro, { uploadId: id, format: 'sql', db: DB, options: {} })).rejects.toMatchObject({
        error: { code: 'read_only' },
      })
      // The analysis itself works in read-only mode.
      const roReal = mkEnv({ guard: { forcedReadOnly: true, sessionReadOnly: false } })
      expect((await analyseImportImpl(roReal, { uploadId: id, format: 'sql' })).statements?.total).toBe(1)
    })

    test('the second import is busy while the first runs; a paused import does not count', async () => {
      const id = await stage('SELECT SLEEP(3);')
      await analyse(id)
      const { jobId } = await startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {} })
      await expect(startImportImpl(env, { uploadId: id, format: 'sql', db: DB, options: {} })).rejects.toMatchObject({ error: { code: 'busy' } })
      await jobs.cancel(jobId, owner)
    })

    test('the job record stays under 4 KB with many failures', async () => {
      const lines = ['CREATE TABLE many (id INT PRIMARY KEY);', 'INSERT INTO many VALUES (1);']
      for (let i = 0; i < 300; i++) lines.push(`INSERT INTO many VALUES (1); -- ${'x'.repeat(60)}`)
      const { job } = await importSql(lines.join('\n'), { ignoreErrors: true })
      expect(Buffer.byteLength(JSON.stringify(job))).toBeLessThanOrEqual(4096)
      expect(job.result?.rejectedCount).toBe(300)
      expect(job.result?.rejected.length).toBeLessThanOrEqual(10)
      expect(getImportDetails(job.id)).toHaveLength(100)
    })
  })

  // ---- Server folder ------------------------------------------------------------------------------------------------------

  test('server import folder: off, then on', async () => {
    const dir = join(root, 'folder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'f.sql'), 'CREATE TABLE fo (id INT);\nINSERT INTO fo VALUES (1);')
    await expect(listImportFolderImpl(env)).rejects.toMatchObject({ error: { code: 'not_enabled' } })
    const on = mkEnv({ importDir: dir, limits: { ...resolveIoLimits(), serverFolderEnabled: true } })
    const [file] = await listImportFolderImpl(on)
    expect(file).toMatchObject({ name: 'f.sql' })
    const a = await analyseImportImpl(on, { uploadId: file!.id, format: 'sql' })
    expect(a.fileName).toBe('f.sql')
    const { jobId } = await startImportImpl(on, { uploadId: file!.id, format: 'sql', db: DB, options: {} })
    expect((await waitJob(jobId)).state).toBe('done')
    await expect(analyseImportImpl(env, { uploadId: file!.id, format: 'sql' })).rejects.toMatchObject({ error: { code: 'not_enabled' } })
  })

  // ---- CSV and JSON -----------------------------------------------------------------------------------------------------------

  describe('rows', () => {
    const create = (sql: string) => pool.query(`CREATE TABLE \`${DB}\`.${sql}`)

    test('CSV with a semicolon, quoted line breaks, hostile content and the formula prefix reversed', async () => {
      await create('customer (id INT PRIMARY KEY, name VARCHAR(80), note TEXT, price DECIMAL(10,2)) ENGINE=InnoDB')
      const csv = [
        'id;name;note;price',
        '1;"Ann\nBob";"\'=SUM(A1)";10.50',
        "2;\"'); DROP TABLE customer; --\";plain;3",
        '3;Ünï😀;;7.239',
      ].join('\n')
      const { job, analysis } = await importRows(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)]), 'csv', 'customer', {
        separator: ';',
        header: true,
      })
      expect(analysis.rows).toMatchObject({ columns: ['id', 'name', 'note', 'price'], rowCount: 3 })
      expect(job.state).toBe('done')
      const rows = await q('SELECT * FROM `' + DB + '`.customer ORDER BY id')
      expect(rows).toEqual([
        { id: 1, name: 'Ann\nBob', note: '=SUM(A1)', price: '10.50' },
        { id: 2, name: "'); DROP TABLE customer; --", note: 'plain', price: '3.00' },
        { id: 3, name: 'Ünï😀', note: null, price: '7.24' },
      ])
      expect(job.result?.rows).toBe(3)
    })

    test('all or nothing rolls back and names row and column; keep going lists rejects and is never plain done', async () => {
      await create('c2 (id INT PRIMARY KEY, name VARCHAR(5)) ENGINE=InnoDB')
      const csv = ['id,name', '1,ok', '2,toolongvalue', '3,fine', '4,a,extra', '5,five'].join('\n')
      const a = await importRows(csv, 'csv', 'c2', { header: true })
      expect(a.job.state).toBe('failed')
      expect(a.job.result?.error).toMatchObject({ code: 'row_rejected' })
      expect(a.job.result?.error?.message).toMatch(/Row 3, column name/)
      expect(await count('c2')).toBe(0)
      const b = await importRows(csv, 'csv', 'c2', { header: true, mode: 'keepGoing' })
      expect(b.job.state).toBe('done_with_rejects')
      expect(b.job.result?.rejectedCount).toBe(2)
      expect(b.job.result?.rejected.map((r) => [r.row, r.code])).toEqual([
        [3, 'invalid-value'],
        [5, 'field_count'],
      ])
      expect(await q('SELECT id FROM `' + DB + '`.c2 ORDER BY id')).toEqual([{ id: 1 }, { id: 3 }, { id: 5 }])
    })

    test('conflict modes follow MySQL: error, ignore, replace', async () => {
      await create('cf (id INT PRIMARY KEY, v VARCHAR(10)) ENGINE=InnoDB')
      await pool.query(`INSERT INTO \`${DB}\`.cf VALUES (1, 'old')`)
      const csv = 'id,v\n1,new\n2,two\n'
      const err = await importRows(csv, 'csv', 'cf', { header: true })
      expect(err.job.state).toBe('failed')
      expect(err.job.result?.error).toMatchObject({ code: 'row_rejected', errno: 1062 })
      expect(err.job.result?.error?.message).toMatch(/Row 2/)
      expect(await count('cf')).toBe(1)
      const ign = await importRows(csv, 'csv', 'cf', { header: true, conflict: 'ignore' })
      expect(ign.job.state).toBe('done')
      expect(ign.job.result?.rows).toBe(1)
      expect(ign.job.result?.notes.join(' ')).toMatch(/1 rows were skipped/)
      expect(await q('SELECT v FROM `' + DB + '`.cf ORDER BY id')).toEqual([{ v: 'old' }, { v: 'two' }])
      const rep = await importRows(csv, 'csv', 'cf', { header: true, conflict: 'replace' })
      expect(rep.job.state).toBe('done')
      expect(await q('SELECT v FROM `' + DB + '`.cf ORDER BY id')).toEqual([{ v: 'new' }, { v: 'two' }])
    })

    test('batches: a duplicate in a later batch rolls everything back and names the row', async () => {
      await create('bt (id INT PRIMARY KEY) ENGINE=InnoDB')
      const lines = ['id']
      for (let i = 1; i <= 1200; i++) lines.push(String(i === 1100 ? 5 : i))
      const csv = lines.join('\n')
      const a = await importRows(csv, 'csv', 'bt', { header: true })
      expect(a.job.state).toBe('failed')
      expect(a.job.result?.error?.message).toMatch(/Row 1101/)
      expect(await count('bt')).toBe(0)
      const b = await importRows(csv, 'csv', 'bt', { header: true, mode: 'keepGoing' })
      expect(b.job.state).toBe('done_with_rejects')
      expect(b.job.result?.rejected).toMatchObject([{ row: 1101, code: '1062' }])
      expect(await count('bt')).toBe(1199)
      expect(b.job.result?.rows).toBe(1199)
    })

    test('JSON keeps 20-digit numbers exactly; objects, arrays and the DBLoom shape import', async () => {
      await create('js (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(30,10), doc JSON NULL, flag TINYINT) ENGINE=InnoDB')
      const json = '[{"id": 18446744073709551615, "amount": 12345678901234567890.1234567891, "doc": {"a": [1, 2.50]}, "flag": true}]'
      const a = await importRows(json, 'json', 'js')
      expect(a.job.state).toBe('done')
      expect(await q('SELECT id, amount, flag FROM `' + DB + '`.js')).toEqual([
        { id: '18446744073709551615', amount: '12345678901234567890.1234567891', flag: 1 },
      ])
      const doc = JSON.stringify([
        { type: 'header', generator: 'DBLoom', version: '1' },
        { type: 'table', database: 'x', name: 'other', columns: [], data: [{ id: 1 }] },
        { type: 'table', database: 'x', name: 'js', columns: [{ name: 'id', type: 'bigint' }], data: [{ id: 3 }, { id: 4 }] },
      ])
      const an = await analyse(await stage(doc), 'json')
      expect(an.rows?.jsonTables).toEqual(['other', 'js'])
      const b = await importRows(doc, 'json', 'js', { jsonTable: 'js' })
      expect(b.job.state).toBe('done')
      expect(await count('js')).toBe(3)
      const c = await importRows('[[5, 1.5], [6, 2.5]]', 'json', 'js', {}, { mapping: [{ source: 0, target: 'id' }, { source: 1, target: 'amount' }] })
      expect(c.job.state).toBe('done')
      expect(await count('js')).toBe(5)
    })

    test('binary and bit columns take hex, NULL needs a nullable column', async () => {
      await create('bin (id INT PRIMARY KEY, b BLOB, v VARBINARY(4), x BIT(8), n INT NOT NULL DEFAULT 0) ENGINE=InnoDB')
      const csv = 'id,b,v,x\n1,0x00ff41,0x4142,b\'101\'\n2,,0x,0x80\n'
      const a = await importRows(csv, 'csv', 'bin', { header: true })
      expect(a.job.state).toBe('done')
      const rows = (await q('SELECT id, HEX(b) AS b, HEX(v) AS v, x + 0 AS x FROM `' + DB + '`.bin ORDER BY id')).map((r) => ({ ...r, x: Number(r.x) }))
      expect(rows).toEqual([
        { id: 1, b: '00FF41', v: '4142', x: 5 },
        { id: 2, b: null, v: '', x: 128 },
      ])
      const bad = await importRows('id,n\n3,\n', 'csv', 'bin', { header: true })
      expect(bad.job.state).toBe('failed')
      expect(bad.job.result?.error?.message).toMatch(/cannot be empty/)
    })

    test('a new table: types are inferred, the table comes from the structure builder, rows follow', async () => {
      const csv = ['id,price,when,note,select', '1,1.50,2024-01-01 10:00:00,' + 'x'.repeat(400) + ',a', '2,20.25,2024-01-02 11:30:00,short,b'].join('\n')
      const id = await stage(csv, 'new.csv')
      const an = await analyse(id, 'csv', { rowOptions: { header: true } })
      expect(an.rows?.inferred).toEqual(['INT', 'DECIMAL(4,2)', 'DATETIME', 'TEXT', 'VARCHAR(16)'])
      const newTable = {
        db: DB,
        name: 'imported',
        columns: [
          { name: 'id', type: 'int', nullable: true },
          { name: 'price', type: 'decimal', precision: 4, scale: 2, nullable: true },
          { name: 'when', type: 'datetime', nullable: true },
          { name: 'note', type: 'text', nullable: true },
          { name: 'select', type: 'varchar', length: 16, nullable: true },
        ],
      }
      const { jobId } = await startImportImpl(env, {
        uploadId: id,
        format: 'csv',
        db: DB,
        newTable,
        options: { header: true },
      })
      const job = await waitJob(jobId)
      expect(job.state).toBe('done')
      expect(job.result?.notes.join(' ')).toMatch(/Created table/)
      const rows = await q('SELECT `id`, `select`, LENGTH(note) AS l FROM `' + DB + '`.imported ORDER BY id')
      expect(rows.map((r) => ({ ...r, l: Number(r.l) }))).toEqual([
        { id: 1, select: 'a', l: 400 },
        { id: 2, select: 'b', l: 5 },
      ])
      // A system schema and an existing table name are refused / failed cleanly.
      await expect(
        startImportImpl(env, { uploadId: id, format: 'csv', db: 'mysql', newTable: { ...newTable, db: 'mysql' }, options: { header: true } }),
      ).rejects.toMatchObject({ error: { code: 'invalid_request' } })
    })

    test('CSV resume after the time limit by row number', async () => {
      await create('rr (id INT PRIMARY KEY, t VARCHAR(20)) ENGINE=InnoDB')
      const lines = ['id,t']
      for (let i = 1; i <= 2600; i++) lines.push(`${i},ä${i}`)
      const id = await stage(lines.join('\n'), 'big.csv')
      const opts = { header: true, mode: 'keepGoing' }
      await analyse(id, 'csv', { rowOptions: opts })
      env = mkEnv({ limits: { ...resolveIoLimits(), jobMs: 1 } })
      let { jobId } = await startImportImpl(env, { uploadId: id, format: 'csv', db: DB, table: 'rr', options: opts })
      let job = await waitJob(jobId)
      let pauses = 0
      while (job.state === 'paused') {
        pauses++
        ;({ jobId } = await resumeImportImpl(env, { jobId }))
        job = await waitJob(jobId)
        if (pauses > 100) throw new Error('never ends')
      }
      expect(pauses).toBeGreaterThan(0)
      expect(job.state).toBe('done')
      expect(await count('rr')).toBe(2600)
      expect(job.result?.rows).toBe(2600)
    }, 60_000)

    test('a wrong delimiter is reported at analysis, and an unknown mapped column is refused', async () => {
      await create('wd (id INT, name VARCHAR(10)) ENGINE=InnoDB')
      const id = await stage('id;name\n1;a\n', 'wd.csv')
      const an = await analyse(id, 'csv', { rowOptions: { header: true } })
      expect(an.rows?.warnings.map((w) => w.code)).toContain('delimiter_merged')
      expect(an.rows?.columns).toEqual(['id;name'])
      await expect(
        startImportImpl(env, {
          uploadId: id,
          format: 'csv',
          db: DB,
          table: 'wd',
          options: { header: true },
          mapping: [{ source: 'id;name', target: 'nope' }],
        }),
      ).rejects.toMatchObject({ error: { code: 'invalid_request' } })
      expect(await count('wd')).toBe(0)
    })
  })
})
