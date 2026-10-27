// Spike for module auth-account (SPEC/26 task 0). Usage: node scripts/auth-spike.mjs [argon2|sqlite|webauthn|db|all]
// Prints observed facts for the *verify* cells; changes nothing outside the scratch files, users, roles and
// databases it creates and removes. `webauthn` starts Chromium (Playwright) once; `db` needs compose.test.yaml up.
// The CLI build check is `node scripts/auth-spike.mjs cli` (builds into a temporary directory, then removes it).
import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const part = process.argv[2] ?? 'all'
const out = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)

// ---- Argon2id: time and peak RSS per parameter set, one child process each ---------------------------------

const ARGON_CHILD = `
const { argon2, argon2Sync, randomBytes } = require('node:crypto')
const [memMiB, passes, par, runs, concurrent] = process.argv.slice(1).map(Number)
const warnings = []
process.on('warning', (w) => warnings.push(w.name + ': ' + w.message))
const base = process.memoryUsage().rss
const params = () => ({ message: 'correct horse battery staple', nonce: randomBytes(16), parallelism: par, tagLength: 32, memory: memMiB * 1024, passes })
const one = () => new Promise((res, rej) => { const t = performance.now(); argon2('argon2id', params(), (e, k) => e ? rej(e) : res([performance.now() - t, k.length])) })
;(async () => {
  argon2Sync('argon2id', { ...params(), memory: 8 * 1024, passes: 1 }) // warm-up
  const times = []
  for (let i = 0; i < runs; i++) {
    const batch = await Promise.all(Array.from({ length: concurrent }, one))
    for (const [ms] of batch) times.push(ms)
  }
  times.sort((a, b) => a - b)
  const ru = process.resourceUsage()
  console.log(JSON.stringify({ medianMs: Math.round(times[Math.floor(times.length / 2)]), minMs: Math.round(times[0]), maxMs: Math.round(times[times.length - 1]), baseRssMiB: Math.round(base / 1048576), peakRssMiB: Math.round(ru.maxRSS / 1024), threadpool: process.env.UV_THREADPOOL_SIZE ?? 4, warnings }))
})().catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(1) })
`

function argon2Spike() {
  const crypto = createRequire(import.meta.url)('node:crypto')
  out('node', { version: process.version, argon2: typeof crypto.argon2, argon2Sync: typeof crypto.argon2Sync })
  const sets = [
    ['login min m19 t2 p1', 19, 2, 1, 5, 1],
    ['login default m64 t3 p1', 64, 3, 1, 5, 1],
    ['login default x2 concurrent', 64, 3, 1, 3, 2],
    ['login default x8 concurrent (no semaphore)', 64, 3, 1, 1, 8],
    ['vault min m64 t3 p1', 64, 3, 1, 3, 1],
    ['vault default m128 t3 p1', 128, 3, 1, 3, 1],
  ]
  for (const [label, ...args] of sets) {
    const r = spawnSync(process.execPath, ['-e', ARGON_CHILD, ...args.map(String)], { encoding: 'utf8' })
    out(`argon2id ${label}`, (r.stdout || r.stderr).trim())
  }
}

// ---- SQLite: ALTER TABLE ADD COLUMN on a STRICT table (node:sqlite as the store) ----------------------------

async function sqliteSpike() {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 'auth-spike-sqlite-'))
  const r = {}
  try {
    const db = new DatabaseSync(join(dir, 's.db'))
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    db.exec(`CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, target_key TEXT NOT NULL, user_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT`)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('h1', 'db:3306', 'u', 1, 1, 2)
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT')
    db.exec('BEGIN IMMEDIATE')
    const adds = [
      "ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct','account'))",
      'ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE',
      "ADD COLUMN state TEXT NOT NULL DEFAULT 'full' CHECK (state IN ('pending_mfa','enrol_only','must_change','full'))",
      'ADD COLUMN mfa_at INTEGER',
      'ADD COLUMN stepup_at INTEGER',
      'ADD COLUMN security_version INTEGER NOT NULL DEFAULT 0',
      "ADD COLUMN client_hint TEXT NOT NULL DEFAULT ''",
      "ADD COLUMN address TEXT NOT NULL DEFAULT ''",
    ]
    for (const a of adds) db.exec(`ALTER TABLE sessions ${a}`)
    db.exec('COMMIT')
    r.alterInTransaction = 'ok (8 columns, with CHECK, DEFAULT and REFERENCES ... ON DELETE CASCADE)'
    r.existingRow = db.prepare('SELECT kind, state, security_version, user_id FROM sessions').get()
    r.strictStillEnforced = (() => {
      try {
        db.prepare('UPDATE sessions SET security_version = ? WHERE id_hash = ?').run('abc', 'h1')
        return 'NO: text stored in INTEGER'
      } catch (e) {
        return `yes (${e.message})`
      }
    })()
    r.checkEnforced = (() => {
      try {
        db.exec("UPDATE sessions SET state = 'bogus'")
        return 'NO'
      } catch (e) {
        return `yes (${e.message})`
      }
    })()
    // A NOT NULL column without default is refused by SQLite for ADD COLUMN; show the message for the record.
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN x TEXT NOT NULL')
      r.notNullWithoutDefault = 'accepted'
    } catch (e) {
      r.notNullWithoutDefault = `refused (${e.message})`
    }
    // A REFERENCES column with a non-NULL default is refused when foreign keys are on.
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN y TEXT REFERENCES users(id) DEFAULT 'x'")
      r.fkWithDefault = 'accepted'
    } catch (e) {
      r.fkWithDefault = `refused (${e.message})`
    }
    r.strictFlag = db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'sessions'").get()
    r.sqliteVersion = db.prepare('SELECT sqlite_version() v').get().v
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  out('sqlite', r)
}

// ---- WebAuthn: @simplewebauthn/server against a Chromium virtual authenticator ------------------------------

async function webauthnSpike() {
  const swa = await import('@simplewebauthn/server')
  const { chromium } = await import('@playwright/test')
  const req = createRequire(import.meta.url)
  const bundle = readFileSync(join(req.resolve('@simplewebauthn/browser').replace(/[\\/](esm|script)[\\/].*$/, ''), 'dist/bundle/index.umd.min.js'), 'utf8')
  const server = createServer((rq, rs) => {
    if (rq.url === '/swa.js') {
      rs.writeHead(200, { 'content-type': 'text/javascript' })
      return rs.end(bundle)
    }
    rs.writeHead(200, { 'content-type': 'text/html' })
    rs.end('<!doctype html><title>spike</title><script src="/swa.js"></script>')
  })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const origin = `http://localhost:${server.address().port}`
  const rpID = 'localhost'
  const browser = await chromium.launch()
  const r = {}
  try {
    const page = await browser.newPage()
    await page.goto(origin)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    r.conditionalMediation = await page.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable?.() ?? 'absent')

    const ceremony = async (label, uv, supportedAlgorithmIDs) => {
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: uv, isUserVerified: uv, automaticPresenceSimulation: true },
      })
      const res = {}
      const regOpts = await swa.generateRegistrationOptions({
        rpName: 'DBLoom spike',
        rpID,
        userName: 'ana',
        userID: randomBytes(32),
        attestationType: 'none',
        ...(supportedAlgorithmIDs ? { supportedAlgorithmIDs } : {}),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      })
      const reg = await page.evaluate((o) => SimpleWebAuthnBrowser.startRegistration({ optionsJSON: o }), regOpts)
      const verifyReg = (requireUserVerification) =>
        swa.verifyRegistrationResponse({ response: reg, expectedChallenge: regOpts.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification })
          .then((v) => ({ verified: v.verified, uv: v.registrationInfo?.userVerified, counter: v.registrationInfo?.credential.counter, fmt: v.registrationInfo?.fmt, backedUp: v.registrationInfo?.credentialBackedUp }))
          .catch((e) => `rejected: ${e.message}`)
      res.registerRequireUv = await verifyReg(true)
      res.registerNoUvRequired = await verifyReg(false)
      const regInfo = (await swa.verifyRegistrationResponse({ response: reg, expectedChallenge: regOpts.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false })).registrationInfo
      const cred = { id: regInfo.credential.id, publicKey: regInfo.credential.publicKey, counter: regInfo.credential.counter, transports: reg.response.transports }

      // UV on: usernameless (empty allow list); UV off: second-factor style with the credential listed
      const authOpts = await swa.generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: uv ? [] : [{ id: cred.id, transports: cred.transports }] })
      const asn = await page.evaluate((o) => SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o }), authOpts)
      const verifyAuth = (opts) =>
        swa.verifyAuthenticationResponse({ response: asn, expectedChallenge: authOpts.challenge, expectedOrigin: origin, expectedRPID: rpID, credential: cred, ...opts })
          .then((v) => ({ verified: v.verified, uv: v.authenticationInfo.userVerified, newCounter: v.authenticationInfo.newCounter }))
          .catch((e) => `rejected: ${e.message}`)
      res.usernamelessUserHandle = asn.response.userHandle ? 'present' : 'absent'
      res.assertRequireUv = await verifyAuth({ requireUserVerification: true })
      res.assertNoUv = await verifyAuth({ requireUserVerification: false })
      res.assertDefaultOpts = await verifyAuth({})
      res.wrongOrigin = await verifyAuth({ requireUserVerification: false, expectedOrigin: 'https://evil.example' })
      res.wrongChallenge = await swa
        .verifyAuthenticationResponse({ response: asn, expectedChallenge: 'AAAA', expectedOrigin: origin, expectedRPID: rpID, credential: cred, requireUserVerification: false })
        .then((v) => (v.verified ? 'accepted' : 'verified: false'))
        .catch((e) => `rejected: ${e.message}`)

      // Counter rule: re-sign the assertion with the authenticator's private key and a chosen counter.
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
      res.chromiumSignCountAfterOneAssertion = credentials[0]?.signCount
      res.keyType = createPrivateKey({ key: Buffer.from(credentials[0].privateKey, 'base64'), format: 'der', type: 'pkcs8' }).asymmetricKeyType
      const key = createPrivateKey({ key: Buffer.from(credentials[0].privateKey, 'base64'), format: 'der', type: 'pkcs8' })
      const withCounter = (n) => {
        const ad = Buffer.from(asn.response.authenticatorData, 'base64url')
        ad.writeUInt32BE(n, 33)
        const cd = Buffer.from(asn.response.clientDataJSON, 'base64url')
        const sig = sign(['ed25519', 'ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'].includes(key.asymmetricKeyType) ? null : 'sha256', Buffer.concat([ad, createHash('sha256').update(cd).digest()]), key)
        return { ...asn, response: { ...asn.response, authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') } }
      }
      const tryCounter = (resp, stored) =>
        swa
          .verifyAuthenticationResponse({ response: resp, expectedChallenge: authOpts.challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { ...cred, counter: stored }, requireUserVerification: false })
          .then((v) => (v.verified ? `accepted (newCounter ${v.authenticationInfo.newCounter})` : 'verified: false'))
          .catch((e) => `rejected: ${e.message}`)
      res.counter_0_stored_0 = await tryCounter(withCounter(0), 0)
      res.counter_0_stored_5 = await tryCounter(withCounter(0), 5)
      res.counter_3_stored_5 = await tryCounter(withCounter(3), 5)
      res.counter_5_stored_5 = await tryCounter(withCounter(5), 5)
      res.counter_6_stored_5 = await tryCounter(withCounter(6), 5)
      res.tamperedNoResign = await swa
        .verifyAuthenticationResponse({
          response: (() => {
            const ad = Buffer.from(asn.response.authenticatorData, 'base64url')
            ad.writeUInt32BE(99, 33)
            return { ...asn, response: { ...asn.response, authenticatorData: ad.toString('base64url') } }
          })(),
          expectedChallenge: authOpts.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: cred,
          requireUserVerification: false,
        })
        .then((v) => (v.verified ? 'accepted' : 'verified: false'))
        .catch((e) => `rejected: ${e.message}`)
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
      out(`webauthn ${label}`, res)
    }
    await ceremony('UV on', true)
    await ceremony('UV off', false)
    // Explicit list without the experimental ML-DSA-44 that the library adds when the runtime supports it
    await ceremony('UV on, algorithms EdDSA ES256 RS256', true, [-8, -7, -257])
    await ceremony('UV on, algorithm ES256 only', true, [-7])
  } finally {
    await browser.close()
    server.close()
  }
  out('webauthn', r)
}

// ---- mysql2 compress and role activation on both products -------------------------------------------------------

const targets = [
  ['mysql', 33064],
  ['mariadb', 33061],
]

async function dbSpike() {
  const mysql = (await import('mysql2/promise')).default
  for (const [label, port] of targets) {
    let admin
    try {
      admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
    } catch (e) {
      out(`${label}.connect`, `FAILED ${e.code ?? e.message}`)
      continue
    }
    const tag = Math.random().toString(16).slice(2, 8)
    const db = `auth_spike_${tag}`
    const users = []
    const roles = []
    const r = {}
    try {
      const [[v]] = await admin.query('SELECT VERSION() v')
      r.version = v.v

      // compress
      const c = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root', compress: true })
      const [[st]] = await c.query("SHOW SESSION STATUS LIKE 'Compression'")
      const [[big]] = await c.query("SELECT LENGTH(REPEAT('abc', 300000)) n, REPEAT('abc', 300000) s")
      r.compress = { status: st.Value, bigRowOk: big.s.length === big.n }
      await c.end()
      const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: 'root', compress: true, connectionLimit: 2 })
      const [[pst]] = await pool.query("SHOW SESSION STATUS LIKE 'Compression'")
      r.compressPool = pst.Value
      await pool.end()

      // roles
      await admin.query(`CREATE DATABASE \`${db}\``)
      await admin.query(`CREATE TABLE \`${db}\`.t (a INT)`)
      const r1 = `r1_${tag}`
      const r2 = `r2_${tag}`
      const u = `u_${tag}`
      await admin.query(`CREATE ROLE ${r1}`)
      roles.push(r1)
      await admin.query(`CREATE ROLE ${r2}`)
      roles.push(r2)
      await admin.query(`GRANT SELECT ON \`${db}\`.* TO ${r1}`)
      await admin.query(`GRANT INSERT ON \`${db}\`.* TO ${r2}`)
      await admin.query(`CREATE USER '${u}'@'%' IDENTIFIED BY 'x'`)
      users.push(u)
      // MariaDB grants one role per statement (`GRANT r1, r2 TO u` is error 1064 there).
      await admin.query(`GRANT ${r1} TO '${u}'@'%'`)
      await admin.query(`GRANT ${r2} TO '${u}'@'%'`)
      const [[aar]] = await admin.query("SHOW GLOBAL VARIABLES LIKE 'activate_all_roles_on_login'").then(([rows]) => [rows.length ? rows : [{ Value: 'absent' }]])
      r.activateAllRolesOnLogin = aar.Value
      const probe = async (conn) => {
        const q = async (sql) => {
          try {
            const [rows] = await conn.query(sql)
            return Array.isArray(rows) && rows[0] ? Object.values(rows[0])[0] ?? 'NULL' : 'ok'
          } catch (e) {
            return `error ${e.errno}`
          }
        }
        return {
          currentRole: await q('SELECT CURRENT_ROLE()'),
          select: await q(`SELECT COUNT(*) FROM \`${db}\`.t`),
          insert: await q(`INSERT INTO \`${db}\`.t VALUES (1)`),
        }
      }
      const login = () => mysql.createConnection({ host: '127.0.0.1', port, user: u, password: 'x' })
      let uc = await login()
      r.noDefaultRole_atLogin = await probe(uc)
      const tryStmt = async (sql) => {
        try {
          await uc.query(sql)
          return { result: 'ok', after: await probe(uc) }
        } catch (e) {
          return { result: `error ${e.errno} ${e.sqlMessage}` }
        }
      }
      r.setRoleAll = await tryStmt('SET ROLE ALL')
      await uc.end()
      uc = await login()
      r.setRoleR1 = await tryStmt(`SET ROLE ${r1}`)
      r.setRoleDefault = await tryStmt('SET ROLE DEFAULT')
      await uc.end()
      // default role(s)
      if (label === 'mysql') {
        await admin.query(`SET DEFAULT ROLE ${r1} TO '${u}'@'%'`)
      } else {
        await admin.query(`SET DEFAULT ROLE ${r1} FOR '${u}'@'%'`)
      }
      uc = await login()
      r.defaultRoleR1_atLogin = await probe(uc)
      r.defaultRoleR1_thenSetRoleAll = await tryStmt('SET ROLE ALL')
      await uc.end()
    } catch (e) {
      r.error = `${e.errno ?? ''} ${e.sqlMessage ?? e.message}`
    } finally {
      for (const u of users) await admin.query(`DROP USER '${u}'@'%'`).catch(() => {})
      for (const ro of roles) await admin.query(`DROP ROLE ${ro}`).catch(() => {})
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {})
      await admin.end()
    }
    out(label, r)
  }
}

// ---- CLI build entry: a second Vite build into a temporary .output-like directory ------------------------------

async function cliSpike() {
  const root = process.cwd()
  const dir = mkdtempSync(join(root, '.auth-spike-cli-'))
  try {
    const entry = join(dir, 'cli.ts')
    writeFileSync(
      entry,
      `import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '~/server/store/sqlite-store'
import { AUTH_ERROR_CODES, usernameInput } from '~/server/auth/types'
const d = mkdtempSync(join(tmpdir(), 'auth-spike-cli-store-'))
const store = openSqliteStore(join(d, 'dbloom.db'))
store.createSession({ idHash: 'x', targetKey: 'k', userName: 'u', createdAt: 1, lastSeenAt: 1, expiresAt: Date.now() + 1000 })
console.log(JSON.stringify({ argv: process.argv.slice(2), session: !!store.getSession('x'), codes: AUTH_ERROR_CODES.length, name: usernameInput.parse('ana') }))
store.close()
rmSync(d, { recursive: true, force: true })
`,
    )
    const config = join(dir, 'vite.cli.config.ts')
    // What works (section 15): an explicit `~` alias (tsconfig paths apply only to files tsconfig includes) and
    // `ssr.noExternal: true`, so the file runs without node_modules (the Docker image copies only `.output`).
    writeFileSync(
      config,
      `import { defineConfig } from 'vite'
export default defineConfig({
  resolve: { alias: { '~': ${JSON.stringify(join(root, 'src').replaceAll('\\', '/'))} } },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: ${JSON.stringify(entry.replaceAll('\\', '/'))},
    outDir: ${JSON.stringify(join(dir, 'out').replaceAll('\\', '/'))},
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { entryFileNames: 'dbloom.mjs', format: 'es' } },
  },
})
`,
    )
    const t0 = Date.now()
    const b = spawnSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', config, '--logLevel', 'warn'], { cwd: root, encoding: 'utf8' })
    const built = join(dir, 'out', 'dbloom.mjs')
    const res = { buildExit: b.status, buildSeconds: (Date.now() - t0) / 1000, built: existsSync(built), buildLog: (b.stderr || '').trim().split('\n').slice(0, 4).join(' | ') }
    if (b.status === 0 && existsSync(built)) {
      // Run from a directory without node_modules, as in the container.
      const away = mkdtempSync(join(tmpdir(), 'auth-spike-cli-run-'))
      try {
        const copy = join(away, 'dbloom.mjs')
        writeFileSync(copy, readFileSync(built))
        const run = spawnSync(process.execPath, [copy, 'setup-token'], { cwd: away, encoding: 'utf8' })
        res.runExit = run.status
        res.runOut = (run.stdout || run.stderr).trim().split('\n').slice(-2).join(' | ')
      } finally {
        rmSync(away, { recursive: true, force: true })
      }
      res.bytes = readFileSync(built).length
      res.externalImports = [...readFileSync(built, 'utf8').matchAll(/^import .* from ["']([^"']+)["']/gm)].map((m) => m[1])
    }
    out('cli', res)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (part === 'argon2' || part === 'all') argon2Spike()
if (part === 'sqlite' || part === 'all') await sqliteSpike()
if (part === 'db' || part === 'all') await dbSpike()
if (part === 'webauthn' || part === 'all') await webauthnSpike()
if (part === 'cli') await cliSpike()
