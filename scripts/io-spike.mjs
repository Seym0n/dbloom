// Spike for module io (SPEC/25 task 0, 12). Usage: node scripts/io-spike.mjs [zip|db|priv|zip64|all]
// Prints observed facts for the *verify* cells; changes nothing outside scratch databases it creates and drops.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Zip, ZipDeflate, unzipSync } from 'fflate'
import mysql from 'mysql2/promise'

const part = process.argv[2] ?? 'all'
const out = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)

async function zipSpike() {
  // 1. streaming entry of unknown size, in chunks, data descriptor
  const chunks = []
  const z = new Zip((err, data) => {
    if (err) throw err
    chunks.push(Buffer.from(data))
  })
  const e = new ZipDeflate('a.sql', { level: 6 })
  z.add(e)
  for (let i = 0; i < 100; i++) e.push(Buffer.from('INSERT INTO t VALUES (' + i + ');\n'), false)
  e.push(new Uint8Array(0), true)
  z.end()
  const zip = Buffer.concat(chunks)
  const flags = zip.readUInt16LE(6)
  out('fflate.streamUnknownSize', { bytes: zip.length, dataDescriptorFlag: (flags & 8) !== 0 })
  const files = unzipSync(new Uint8Array(zip))
  out('fflate.roundTripBytes', Buffer.from(files['a.sql']).length)
  // 2. ZIP64 support present in the installed build?
  const req = createRequire(import.meta.url)
  const src = readFileSync(req.resolve('fflate'), 'utf8')
  out('fflate.zip64InSource', /zip64|Zip64|ZIP64/.test(src))
  // 3. UTF-8 name flag
  const z2 = []
  const zz = new Zip((err, data) => z2.push(Buffer.from(data)))
  const e2 = new ZipDeflate('Kunden_Übersicht_客户.csv')
  zz.add(e2)
  e2.push(Buffer.from('x'), true)
  zz.end()
  const b2 = Buffer.concat(z2)
  out('fflate.utf8NameFlag', (b2.readUInt16LE(6) & 0x800) !== 0)
}

const targets = [
  ['mysql', 33064],
  ['mariadb', 33061],
]

async function dbSpike() {
  for (const [label, port] of targets) {
    let admin
    try {
      admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
    } catch (e) {
      out(`${label}.connect`, `FAILED ${e.code ?? e.message}`)
      continue
    }
    const db = 'io_spike_' + Math.random().toString(16).slice(2, 8)
    const r = {}
    try {
      const [[v]] = await admin.query('SELECT VERSION() v')
      r.version = v.v
      await admin.query(`CREATE DATABASE \`${db}\``)
      await admin.query(`USE \`${db}\``)

      // Geometry: read internal value as hex, write it back as hex literal
      await admin.query('CREATE TABLE g (id INT PRIMARY KEY, p POINT, ls LINESTRING)')
      await admin.query("INSERT INTO g VALUES (1, ST_GeomFromText('POINT(1 2)'), ST_GeomFromText('LINESTRING(0 0,1 1)'))")
      const [[g]] = await admin.query('SELECT HEX(p) h, HEX(ls) hl FROM g WHERE id=1')
      await admin.query(`INSERT INTO g VALUES (2, 0x${g.h}, 0x${g.hl})`)
      const [[g2]] = await admin.query('SELECT ST_AsText(p) t FROM g WHERE id=2')
      r.geometryHexRoundTrip = { hex: g.h, text: g2.t }

      // Decimal rounding under strict mode
      await admin.query('CREATE TABLE d (x DECIMAL(5,2))')
      await admin.query("SET SESSION sql_mode='STRICT_ALL_TABLES'")
      try {
        await admin.query("INSERT INTO d VALUES ('1.239')")
        const [[d]] = await admin.query('SELECT x FROM d')
        const [w] = await admin.query('SHOW WARNINGS')
        r.decimalStrict = { stored: d.x, warnings: w.map((x) => `${x.Level} ${x.Code}`) }
      } catch (e) {
        r.decimalStrict = { error: e.errno + ' ' + e.sqlMessage }
      }
      await admin.query("SET SESSION sql_mode=DEFAULT")

      // NO_BACKSLASH_ESCAPES literal
      await admin.query("SET SESSION sql_mode=CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")
      await admin.query('CREATE TABLE s (v VARCHAR(20))')
      await admin.query("INSERT INTO s VALUES ('a\\b''c')")
      const [[s]] = await admin.query('SELECT v FROM s')
      r.noBackslashEscapes = s.v
      await admin.query('SET SESSION sql_mode=DEFAULT')

      // View dependency source
      await admin.query('CREATE TABLE t1 (a INT)')
      await admin.query('CREATE VIEW v1 AS SELECT a FROM t1')
      await admin.query('CREATE VIEW v2 AS SELECT a FROM v1')
      try {
        const [rows] = await admin.query(
          'SELECT VIEW_NAME, TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA = ?',
          [db],
        )
        r.viewTableUsage = rows.map((x) => `${x.VIEW_NAME}->${x.TABLE_NAME}`)
      } catch (e) {
        r.viewTableUsage = `unavailable: ${e.errno} ${e.sqlMessage}`
      }
      try {
        await admin.query(`CREATE VIEW v3 AS SELECT a FROM \`nonexistent\``)
        r.viewOnMissing = 'allowed'
      } catch (e) {
        r.viewOnMissing = `refused ${e.errno}`
      }

      // SHOW CREATE texts (definer, one-line) for view, routine, trigger, event
      await admin.query('CREATE TRIGGER trg BEFORE INSERT ON t1 FOR EACH ROW SET NEW.a = NEW.a + 1')
      await admin.query('CREATE FUNCTION f1() RETURNS INT DETERMINISTIC RETURN 1')
      const [[tc]] = await admin.query('SHOW CREATE TABLE g')
      r.showCreateTableKeys = Object.keys(tc)
      const [[vc]] = await admin.query('SHOW CREATE VIEW v1')
      r.showCreateViewKeys = Object.keys(vc)
      const [[fc]] = await admin.query('SHOW CREATE FUNCTION f1')
      r.showCreateFunctionKeys = Object.keys(fc)

      // Limited user: which privileges allow SHOW CREATE VIEW / routines
      const u = 'io_u_' + Math.random().toString(16).slice(2, 6)
      await admin.query(`CREATE USER '${u}'@'%' IDENTIFIED BY 'x'`)
      await admin.query(`GRANT SELECT, SHOW VIEW ON \`${db}\`.* TO '${u}'@'%'`)
      const lim = await mysql.createConnection({ host: '127.0.0.1', port, user: u, password: 'x', database: db })
      const tryQ = async (sql) => {
        try {
          await lim.query(sql)
          return 'ok'
        } catch (e) {
          return `error ${e.errno}`
        }
      }
      r.limitedUser = {
        showCreateView: await tryQ('SHOW CREATE VIEW v1'),
        showCreateFunction: await tryQ('SHOW CREATE FUNCTION f1'),
        showCreateTrigger: await tryQ('SHOW CREATE TRIGGER trg'),
        lockTables: await tryQ('LOCK TABLES t1 READ'),
      }
      await lim.query('UNLOCK TABLES').catch(() => {})
      await lim.end()
      await admin.query(`DROP USER '${u}'@'%'`)

      // Consistent snapshot statement accepted?
      try {
        await admin.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
        await admin.query('ROLLBACK')
        r.consistentSnapshot = 'ok'
      } catch (e) {
        r.consistentSnapshot = `error ${e.errno}`
      }

      // Server-side prepared multi-row insert accepted (batch path)
      await admin.query('CREATE TABLE b (a INT, c VARCHAR(5))')
      await admin.execute('INSERT INTO b (a, c) VALUES (?, ?), (?, ?)', [1, 'x', 2, 'y'])
      r.preparedMultiRow = 'ok'
    } catch (e) {
      r.error = `${e.errno ?? ''} ${e.sqlMessage ?? e.message}`
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {})
      await admin.end()
    }
    out(label, r)
  }
}

/** Task 12: which privilege makes SHOW CREATE FUNCTION/PROCEDURE and the ROUTINES catalog readable for a user without ownership. */
async function privSpike() {
  for (const [label, port] of targets) {
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
    const db = 'io_priv_' + Math.random().toString(16).slice(2, 8)
    const r = {}
    const users = []
    try {
      const [[v]] = await admin.query('SELECT VERSION() v')
      r.version = v.v
      await admin.query(`CREATE DATABASE \`${db}\``)
      await admin.query(`CREATE FUNCTION \`${db}\`.f1() RETURNS INT DETERMINISTIC RETURN 1`)
      await admin.query(`CREATE PROCEDURE \`${db}\`.p1() SELECT 1`)
      const grants = {
        none: 'SELECT',
        execute: 'SELECT, EXECUTE',
        alterRoutine: 'SELECT, ALTER ROUTINE',
        createRoutine: 'SELECT, CREATE ROUTINE',
        showRoutine: 'SELECT, SHOW_ROUTINE',
        mysqlProcSelect: 'SELECT, SELECT ON mysql.proc',
      }
      for (const [k, g] of Object.entries(grants)) {
        const u = 'io_p_' + Math.random().toString(16).slice(2, 7)
        let granted = 'ok'
        try {
          await admin.query(`CREATE USER '${u}'@'%' IDENTIFIED BY 'x'`)
          users.push(u)
          const target = g.includes('SHOW_ROUTINE') ? '*.*' : `\`${db}\`.*`
          // SHOW_ROUTINE is a global privilege on MySQL; split the SELECT part so the grant text stays valid
          await admin.query(`GRANT SELECT ON \`${db}\`.* TO '${u}'@'%'`)
          if (target === '*.*') await admin.query(`GRANT ${g.replace('SELECT, ', '')} ON *.* TO '${u}'@'%'`)
          else if (g.includes('mysql.proc')) await admin.query(`GRANT SELECT ON mysql.proc TO '${u}'@'%'`)
          else if (g !== 'SELECT') await admin.query(`GRANT ${g.replace('SELECT, ', '')} ON \`${db}\`.* TO '${u}'@'%'`)
        } catch (e) {
          granted = `grant error ${e.errno} ${e.sqlMessage}`
        }
        const row = { grant: granted }
        if (granted === 'ok') {
          const lim = await mysql.createConnection({ host: '127.0.0.1', port, user: u, password: 'x', database: db })
          const t = async (sql) => {
            try {
              const [rows] = await lim.query(sql)
              const col = rows[0] && Object.keys(rows[0]).find((k) => /^Create (Function|Procedure)$/.test(k))
              return Array.isArray(rows) ? `ok (${rows.length} rows${col ? (rows[0][col] ? ', text' : ', text NULL') : ''})` : 'ok'
            } catch (e) {
              return `error ${e.errno}`
            }
          }
          row.showCreateFunction = await t(`SHOW CREATE FUNCTION f1`)
          row.showCreateProcedure = await t(`SHOW CREATE PROCEDURE p1`)
          row.informationSchemaRoutines = await t(`SELECT ROUTINE_NAME, ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '${db}'`)
          await lim.end()
        }
        r[k] = row
      }
    } catch (e) {
      r.error = `${e.errno ?? ''} ${e.sqlMessage ?? e.message}`
    } finally {
      for (const u of users) await admin.query(`DROP USER '${u}'@'%'`).catch(() => {})
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {})
      await admin.end()
    }
    out(`${label}.routinePrivilege`, r)
  }
}

/**
 * ZIP64: writes one entry of 4 GiB + 1 byte (zero bytes, deflate) through the zip writer of the module and reads it back with the
 * system `unzip -t` / `zipinfo`. Takes a few minutes and about 5 MiB of disk (zeros compress to almost nothing).
 */
async function zip64Spike() {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, createWriteStream, statSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'io-zip64-'))
  const file = join(dir, 'big.zip')
  // The module's own writer (TypeScript), loaded through Vite as the benchmark does
  const { createServer } = await import('vite')
  const vite = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', resolve: { tsconfigPaths: true }, optimizeDeps: { noDiscovery: true, include: [] } })
  const { ZipWriter } = await vite.ssrLoadModule('/src/server/io/zip.ts')
  const ws = createWriteStream(file)
  const done = new Promise((res, rej) => ws.on('finish', res).on('error', rej))
  const z = new ZipWriter((data) => ws.write(Buffer.from(data)), 1, Number.POSITIVE_INFINITY) // guard off: shows what fflate writes
  z.begin('big.bin')
  const chunk = new Uint8Array(8 * 1024 * 1024)
  const total = 4 * 1024 * 1024 * 1024 + 1
  const t0 = Date.now()
  let sent = 0
  while (sent < total) {
    const n = Math.min(chunk.length, total - sent)
    sent += n
    z.write(n === chunk.length ? chunk : chunk.subarray(0, n))
    if (ws.writableNeedDrain) await new Promise((r) => ws.once('drain', r))
  }
  z.finish()
  ws.end()
  await done
  await vite.close()
  const info = spawnSync('zipinfo', [file], { encoding: 'utf8' })
  const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
  out('zip64', {
    archiveBytes: statSync(file).size,
    seconds: (Date.now() - t0) / 1000,
    zipinfo: (info.stdout || info.stderr || String(info.error)).split('\n').slice(0, 4).join(' | '),
    unzipT: (test.stdout || test.stderr || String(test.error)).split('\n').slice(-3).join(' | '),
  })
  rmSync(dir, { recursive: true, force: true })
}

if (part === 'zip' || part === 'all') await zipSpike()
if (part === 'db' || part === 'all') await dbSpike()
if (part === 'priv' || part === 'all') await privSpike()
if (part === 'zip64') await zip64Spike()
