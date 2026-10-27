// Benchmark of module io (SPEC/25 task 11, section 5.12). Not a test.
// Usage: node --expose-gc scripts/io-bench.mjs [--size-mb 200] [--product mysql|mariadb|both] [--result-rows 200000] [--keep]
// Needs the test containers (docker compose -f compose.test.yaml up -d). Creates two scratch databases per product and drops them.
// DBLoom runs in this process (server code loaded through Vite, as the unit tests do); the clients run inside the containers on
// files in the container's /tmp, so the numbers include DBLoom's TCP hop through the docker port and exclude docker pipe overhead.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import mysql from 'mysql2/promise'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i < 0 ? d : process.argv[i + 1]
}
const SIZE_MB = Number(arg('size-mb', '200'))
const RESULT_ROWS = Number(arg('result-rows', '200000'))
const WHICH = arg('product', 'both')
const PRODUCTS = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql', dump: 'mysqldump', client: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb', dump: 'mariadb-dump', client: 'mariadb' },
].filter((p) => WHICH === 'both' || p.product === WHICH)
const MiB = 1024 * 1024
const ROWS = Math.ceil((SIZE_MB * 1e6) / 255)
const q = (n) => '`' + n + '`'
const fmt = (n, d = 1) => n.toFixed(d)
const gc = () => globalThis.gc?.()
const rss = () => process.memoryUsage().rss

function containerOf(port) {
  const r = spawnSync('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
  return r.stdout.split(/\r?\n/)[0].trim() || null
}
/** docker exec with sh -c; resolves { ms, stdout }. */
function dexec(container, cmd) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const p = spawn('docker', ['exec', container, 'sh', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? resolve({ ms: performance.now() - t0, stdout: out.trim() }) : reject(new Error(`exit ${code}: ${err.slice(0, 500)}`))))
  })
}
/** Samples RSS every 50 ms while fn runs; returns { value, baseline, peak, series } (growth = peak - baseline). */
async function withRss(fn) {
  gc()
  const baseline = rss()
  let peak = baseline
  const series = []
  const t0 = performance.now()
  const timer = setInterval(() => {
    const r = rss()
    peak = Math.max(peak, r)
    series.push([performance.now() - t0, r])
  }, 50)
  try {
    const heap0 = process.memoryUsage().heapUsed
    const value = await fn((r) => (peak = Math.max(peak, r)))
    const ms = performance.now() - t0
    gc()
    const retainedMiB = (process.memoryUsage().heapUsed - heap0) / MiB
    return { value, baseline, peak, growthMiB: (peak - baseline) / MiB, retainedMiB, series, ms }
  } finally {
    clearInterval(timer)
  }
}

const vite = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', resolve: { tsconfigPaths: true }, optimizeDeps: { noDiscovery: true, include: [] } })
const load = (p) => vite.ssrLoadModule(p)
const { runExport } = await load('/src/server/io/export.ts')
const { TempStore } = await load('/src/server/io/temp.ts')
const { exportRequest } = await load('/src/server/io/types.ts')
const { analyseImportImpl } = await load('/src/server/io/analyse.ts')
const { startImportImpl } = await load('/src/server/io/import-service.ts')
const { JobRegistry } = await load('/src/server/io/jobs.ts')
const { resolveIoLimits } = await load('/src/server/io/limits.ts')
const { createTokenIssuer } = await load('/src/server/guard/confirm-token.ts')
const { openResultStream } = await load('/src/server/sql/export-source.ts')
const { RunRegistry } = await load('/src/server/sql/registry.ts')
const { DEFAULT_SQL_LIMITS } = await load('/src/server/sql/types.ts')
const { PlanStore } = await load('/src/server/structure/plans.ts')
const { initParser } = await load('/src/server/sql/parser.ts')
await initParser()

const root = mkdtempSync(join(tmpdir(), 'io-bench-'))
const results = []

async function generate(pool, db) {
  await pool.query(`DROP DATABASE IF EXISTS ${q(db)}`)
  await pool.query(`CREATE DATABASE ${q(db)} DEFAULT CHARACTER SET utf8mb4`)
  const c = await pool.getConnection()
  await c.query(`USE ${q(db)}`)
  await c.query(`CREATE TABLE bench (
    id BIGINT NOT NULL PRIMARY KEY, name VARCHAR(40), email VARCHAR(80), payload VARCHAR(255), amount DECIMAL(12,2), created DATETIME,
    note TEXT, raw VARBINARY(32), KEY k_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await c.query('CREATE TABLE digits (i INT)')
  await c.query('INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)')
  const CHUNK = 100_000
  for (let off = 0; off < ROWS; off += CHUNK) {
    const n = Math.min(CHUNK, ROWS - off)
    await c.query(
      `INSERT INTO bench SELECT id, CONCAT('user-', id), CONCAT(MD5(id), '@example.org'), CONCAT(MD5(id), MD5(id + 1), MD5(id + 2)),
         ROUND(id / 7, 2), TIMESTAMP('2020-01-01') + INTERVAL id MINUTE, IF(id % 10 = 0, CONCAT('日本語 😀 ', id, ' it''s; "quoted"\\n'), NULL), UNHEX(MD5(id))
       FROM (SELECT ${off} + a.i + b.i * 10 + c.i * 100 + d.i * 1000 + e.i * 10000 + f.i * 100000 + 1 AS id
             FROM digits a, digits b, digits c, digits d, digits e, digits f) x WHERE id <= ${off + n} AND id > ${off}`,
    )
  }
  await c.query('DROP TABLE digits')
  c.release()
}

for (const P of PRODUCTS) {
  const container = containerOf(P.port)
  if (!container) {
    console.log(`${P.name}: container not running, skipped`)
    continue
  }
  const SRC = `io_bench_src_${P.product}_${process.pid}`
  const DST = `io_bench_dst_${P.product}_${process.pid}`
  const pool = mysql.createPool({
    host: '127.0.0.1', port: P.port, user: 'root', password: 'root', connectionLimit: 8, multipleStatements: false,
    charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true,
  })
  const temp = new TempStore({ dir: join(root, P.product), quotaBytes: 16 * 1024 * MiB, maxFilesPerOwner: 50 })
  const jobs = new JobRegistry()
  const owner = { sessionId: 'bench', user: 'root' }
  const R = { product: P.name, rows: ROWS }
  console.log(`\n== ${P.name}: generating ${ROWS} rows`)
  try {
    const tg = performance.now()
    await generate(pool, SRC)
    console.log(`generated in ${fmt((performance.now() - tg) / 1000)} s`)

    // -- export: client dump (file inside the container) --------------------------------------------------------------
    const cd = await dexec(container, `${P.dump} -uroot -proot --single-transaction --hex-blob --routines --events --triggers ${SRC} > /tmp/b_${process.pid}.sql && stat -c %s /tmp/b_${process.pid}.sql`)
    R.clientDumpMs = cd.ms
    R.clientDumpBytes = Number(cd.stdout.split('\n').pop())

    // -- export: DBLoom --------------------------------------------------------------------------------------------------
    const ex = await withRss(() =>
      runExport({
        pool, temp, owner,
        request: exportRequest.parse({ scope: { kind: 'database', db: SRC }, format: 'sql', compression: 'none', options: { routines: true, events: true } }),
        limits: { maxExportBytes: 64 * 1024 * MiB, jobMs: 7_200_000 },
        signal: new AbortController().signal,
        serverLabel: '127.0.0.1', neutraliseFormulas: true,
        onProgress: () => undefined,
      }),
    )
    if (ex.value.state !== 'done') throw new Error('export failed ' + JSON.stringify(ex.value.result))
    R.dbloomExportMs = ex.ms
    R.dbloomExportBytes = ex.value.file.bytes
    R.dbloomExportRssGrowthMiB = ex.growthMiB
    R.dbloomExportRetainedMiB = ex.retainedMiB

    // -- import: client (the client's own dump, so both read the same bytes) ------------------------------------------------
    await pool.query(`CREATE DATABASE ${q(DST)} DEFAULT CHARACTER SET utf8mb4`)
    const ci = await dexec(container, `${P.client} -uroot -proot --default-character-set=utf8mb4 ${DST} < /tmp/b_${process.pid}.sql`)
    R.clientImportMs = ci.ms
    await dexec(container, `rm -f /tmp/b_${process.pid}.sql`)
    await pool.query(`DROP DATABASE ${q(DST)}`)

    // -- import: DBLoom of the same file ----------------------------------------------------------------------------------
    // The client dump is read back from the container so DBLoom imports byte-identical input.
    const clientFile = join(root, `client_${P.product}.sql`)
    await dexec(container, `${P.dump} -uroot -proot --single-transaction --hex-blob --routines --events --triggers ${SRC} > /tmp/c_${process.pid}.sql`)
    spawnSync('docker', ['cp', `${container}:/tmp/c_${process.pid}.sql`, clientFile])
    await dexec(container, `rm -f /tmp/c_${process.pid}.sql`)
    await pool.query(`CREATE DATABASE ${q(DST)} DEFAULT CHARACTER SET utf8mb4`)
    const env = {
      session: { idHash: owner.sessionId, target: { host: '127.0.0.1', port: P.port, username: 'root' } },
      pool, guard: { forcedReadOnly: false, sessionReadOnly: false }, tokens: createTokenIssuer(), temp, jobs, owner,
      limits: resolveIoLimits(), targetLabel: `127.0.0.1:${P.port}`, statementTimeoutMs: 600_000,
    }
    const w = await temp.begin(owner, 'upload', { name: 'bench.sql', maxBytes: 64 * 1024 * MiB })
    for (const part of splitFile(clientFile)) await w.write(part)
    const uploadId = (await w.commit()).id
    let maxJobBytes = 0
    const imp = await withRss(async (bump) => {
      const ta = performance.now()
      const analysis = await analyseImportImpl(env, { uploadId, format: 'sql' })
      const analyseMs = performance.now() - ta
      const { jobId } = await startImportImpl(env, { uploadId, format: 'sql', db: DST, options: {}, ...(analysis.confirmToken ? { confirmToken: analysis.confirmToken } : {}) })
      const ti = performance.now()
      for (;;) {
        const j = jobs.get(jobId, owner)
        maxJobBytes = Math.max(maxJobBytes, Buffer.byteLength(JSON.stringify(j)))
        bump(rss())
        if (['paused', 'done', 'done_with_skips', 'done_with_rejects', 'failed', 'cancelled'].includes(j.state)) return { j, analyseMs, runMs: performance.now() - ti }
        await new Promise((r) => setTimeout(r, 100))
      }
    })
    if (imp.value.j.state !== 'done') throw new Error('import ' + imp.value.j.state + JSON.stringify(imp.value.j.result))
    R.dbloomImportAnalyseMs = imp.value.analyseMs
    R.dbloomImportRunMs = imp.value.runMs
    R.dbloomImportRssGrowthMiB = imp.growthMiB
    R.dbloomImportRetainedMiB = imp.retainedMiB
    R.jobRecordMaxBytes = maxJobBytes
    R.clientDumpFileBytes = statSync(clientFile).size
    const [[a]] = await pool.query(`SELECT COUNT(*) AS n FROM ${q(DST)}.bench`)
    R.importedRows = Number(a.n)
    rmSync(clientFile, { force: true })

    // -- flat memory of a result export -----------------------------------------------------------------------------------
    const sqlEnv = () => ({
      session: { idHash: 'bench-result', target: { host: '127.0.0.1', port: P.port, username: 'root' }, pool },
      guard: { forcedReadOnly: false, sessionReadOnly: false }, tokens: createTokenIssuer(),
      limits: { ...DEFAULT_SQL_LIMITS, timeoutMs: 600_000 }, plans: new PlanStore(), registry: new RunRegistry(),
    })
    let n = 0
    const res = await withRss((bump) =>
      runExport({
        pool, temp, owner,
        request: exportRequest.parse({ scope: { kind: 'result', db: SRC, text: `SELECT * FROM bench LIMIT ${RESULT_ROWS}`, statementIndex: 0 }, format: 'csv', compression: 'none' }),
        limits: { maxExportBytes: 64 * 1024 * MiB, jobMs: 7_200_000 },
        signal: new AbortController().signal, serverLabel: '127.0.0.1', neutraliseFormulas: true,
        openResult: (r) => openResultStream(sqlEnv(), { ...r, raw: true }),
        onProgress: () => {
          n++
          bump(rss())
        },
      }),
    )
    if (res.value.state !== 'done') throw new Error('result export ' + JSON.stringify(res.value.result))
    // flatness: peak RSS of the last third of the run against the peak of the first third
    const third = Math.floor(res.series.length / 3)
    const peakOf = (s) => Math.max(...s.map((x) => x[1]), 0)
    const first = peakOf(res.series.slice(0, third))
    const last = peakOf(res.series.slice(-third))
    R.resultExport = { rows: res.value.result.rows, ms: res.ms, bytes: res.value.file.bytes, rssGrowthMiB: res.growthMiB, retainedMiB: res.retainedMiB, lastThirdVsFirstThirdMiB: (last - first) / MiB, samples: res.series.length, progressCalls: n }
  } catch (e) {
    R.error = String(e?.stack ?? e)
  } finally {
    if (!arg('keep', false)) {
      await pool.query(`DROP DATABASE IF EXISTS ${q(SRC)}`).catch(() => undefined)
      await pool.query(`DROP DATABASE IF EXISTS ${q(DST)}`).catch(() => undefined)
    }
    await pool.end()
  }
  results.push(R)
}

function* splitFile(path) {
  const buf = readFileSync(path)
  for (let i = 0; i < buf.length; i += 4 * MiB) yield buf.subarray(i, i + 4 * MiB)
}

console.log('\n==== results ====')
for (const R of results) {
  if (R.error) {
    console.log(`${R.product}: ERROR ${R.error}`)
    continue
  }
  const mbs = (bytes, ms) => fmt(bytes / 1e6 / (ms / 1000))
  console.log(`\n${R.product}  rows=${R.rows}`)
  console.log(`export  client dump : ${fmt(R.clientDumpMs / 1000)} s  ${fmt(R.clientDumpBytes / 1e6)} MB  ${mbs(R.clientDumpBytes, R.clientDumpMs)} MB/s`)
  console.log(`export  DBLoom      : ${fmt(R.dbloomExportMs / 1000)} s  ${fmt(R.dbloomExportBytes / 1e6)} MB  ${mbs(R.dbloomExportBytes, R.dbloomExportMs)} MB/s  ratio ${fmt(R.dbloomExportMs / R.clientDumpMs, 2)}  RSS growth ${fmt(R.dbloomExportRssGrowthMiB)} MiB, heap retained ${fmt(R.dbloomExportRetainedMiB)} MiB`)
  console.log(`import  client      : ${fmt(R.clientImportMs / 1000)} s  ${mbs(R.clientDumpFileBytes, R.clientImportMs)} MB/s`)
  console.log(`import  DBLoom run  : ${fmt(R.dbloomImportRunMs / 1000)} s  ${mbs(R.clientDumpFileBytes, R.dbloomImportRunMs)} MB/s  ratio ${fmt(R.dbloomImportRunMs / R.clientImportMs, 2)}  (+ analysis ${fmt(R.dbloomImportAnalyseMs / 1000)} s, ratio incl. analysis ${fmt((R.dbloomImportRunMs + R.dbloomImportAnalyseMs) / R.clientImportMs, 2)})  RSS growth ${fmt(R.dbloomImportRssGrowthMiB)} MiB, heap retained ${fmt(R.dbloomImportRetainedMiB)} MiB  max job record ${R.jobRecordMaxBytes} B  rows ${R.importedRows}`)
  const r = R.resultExport
  console.log(`result export ${r.rows} rows: ${fmt(r.ms / 1000)} s  ${fmt(r.bytes / 1e6)} MB  RSS growth ${fmt(r.rssGrowthMiB)} MiB, heap retained ${fmt(r.retainedMiB)} MiB  last third vs first third ${fmt(r.lastThirdVsFirstThirdMiB)} MiB`)
}
rmSync(root, { recursive: true, force: true })
await vite.close()
console.log('\nJSON ' + JSON.stringify(results))
