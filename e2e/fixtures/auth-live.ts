/**
 * Fixtures for the account-mode specs (`e2e/auth-live-*.spec.ts`, SPEC/26 task 12): a REAL server in account mode on
 * a fresh SQLite store per call, the first-run wizard driven through the browser, a Chromium virtual authenticator, TOTP
 * codes computed from the secret the page shows. Nothing here imports app code.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection } from 'mysql2/promise'
import { expect, type CDPSession, type Page } from '@playwright/test'

export const PASSWORD = 'correct horse battery staple'
export const NEW_PASSWORD = 'another long secret phrase'
export const SETUP_TOKEN = 'e2e-setup-token-0123456789abcdef'
export const SECRET_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
export const BREACHED_PASSWORD = 'password12345678'
/** MySQL 8.4 and MariaDB 10.11 of compose.test.yaml. */
export const MYSQL = { host: '127.0.0.1', port: 33064, user: 'root', password: 'root' }
export const MARIADB = { host: '127.0.0.1', port: 33061, user: 'root', password: 'root' }

export type LiveServer = {
  baseURL: string
  port: number
  dataDir: string
  /** Console output of the server so far. */
  log: () => string
  stop: () => Promise<void>
  /** Stops and starts again on the same store and port; `env` overrides the previous extras. */
  restart: (env?: Record<string, string>) => Promise<void>
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

/** Operator breached list (sorted SHA-1 hex, one per line) with the passwords the specs expect to be refused. */
export function breachedListFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbloom-breached-'))
  const path = join(dir, 'list.txt')
  const lines = [BREACHED_PASSWORD, 'qwertyuiop123456', 'letmein-letmein-1']
    .map((p) => createHash('sha1').update(p).digest('hex'))
    .sort()
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

export async function startServer(
  extra: Record<string, string> = {},
  options: { dataDir?: string; port?: number } = {},
): Promise<LiveServer> {
  const port = options.port ?? (await freePort())
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'dbloom-live-'))
  mkdirSync(dataDir, { recursive: true })
  const entry = resolve('.output/server/index.mjs')
  if (!existsSync(entry)) throw new Error('Build first: npm run build')
  let extras = extra
  let child: ChildProcess | undefined
  let output = ''
  const baseURL = `http://localhost:${port}`

  const launch = async () => {
    output = ''
    child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        PORT: String(port),
        NITRO_PORT: String(port),
        DBLOOM_DATA_DIR: dataDir,
        DBLOOM_LOGIN_MODE: 'account',
        DBLOOM_PUBLIC_ORIGIN: baseURL,
        DBLOOM_SECRET_KEY: SECRET_KEY,
        DBLOOM_SETUP_TOKEN: SETUP_TOKEN,
        DBLOOM_ALLOW_LOOPBACK: 'true',
        DBLOOM_TARGET_TLS: 'off',
        DBLOOM_BREACHED_CHECK: 'true',
        DBLOOM_BREACHED_LIST: breachedListFile(),
        // Faster hashing; still above the documented floors.
        DBLOOM_ARGON2_MEMORY_MIB: '19',
        DBLOOM_ARGON2_PASSES: '2',
        DBLOOM_VAULT_ARGON2_MEMORY_MIB: '64',
        DBLOOM_VAULT_ARGON2_PASSES: '3',
        ...extras,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
    const started = Date.now()
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`server exited early (${child.exitCode}):\n${output}`)
      try {
        const res = await fetch(`${baseURL}/api/health`)
        if (res.ok) return
      } catch {
        // not yet
      }
      if (Date.now() - started > 60_000) throw new Error(`server did not start:\n${output}`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  const halt = async () => {
    const c = child
    if (!c || c.exitCode !== null || c.signalCode !== null) return
    await new Promise<void>((done) => {
      c.once('exit', () => done())
      c.kill()
      setTimeout(() => {
        if (c.exitCode === null) c.kill('SIGKILL')
      }, 5000).unref()
    })
  }
  await launch()
  return {
    baseURL,
    port,
    dataDir,
    log: () => output,
    stop: halt,
    restart: async (env) => {
      await halt()
      if (env) extras = env
      await launch()
    },
  }
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------------------------------------------------------------------

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.replace(/[\s=-]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1]! & 15
  const n =
    ((mac[offset]! & 127) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  return String(n % 1_000_000).padStart(6, '0')
}

/** A code for the step after the current one, so that it differs from a code just used (inside the +-1 window). */
export const nextTotp = (secret: string) => totpCode(secret, Date.now() + 30_000)

// ---- virtual authenticator -----------------------------------------------------------------------------------

export async function addAuthenticator(
  page: Page,
  options: { uv: boolean },
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: options.uv,
      isUserVerified: options.uv,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

// ---- page helpers ------------------------------------------------------------------------------------------

export const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
export const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })

export type Account = {
  username: string
  password: string
  totpSecret?: string
  recoveryCodes?: string[]
  lastStep?: number
}

export async function readRecoveryCodes(
  scope: Page | ReturnType<Page['locator']>,
): Promise<string[]> {
  const items = scope.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')
  await expect(items).toHaveCount(10)
  return (await items.allInnerTexts()).map((t) => t.trim())
}

export async function readTotpSecret(scope: Page | ReturnType<Page['locator']>): Promise<string> {
  const el = scope.getByTestId('totp-secret')
  await expect(el).toBeVisible()
  return (await el.innerText()).replace(/\s+/g, '')
}

/** Token, mode (preselected), site step, administrator with TOTP, recovery codes, finish. Returns the account. */
export async function runSetupWizard(
  page: Page,
  server: LiveServer,
  options: {
    username?: string
    factor?: 'totp' | 'passkey'
    password?: string
    autofocus?: boolean
  } = {},
): Promise<Account> {
  const username = options.username ?? 'admin'
  const password = options.password ?? PASSWORD
  await page.goto(server.baseURL + '/setup')
  await page.getByLabel('Setup token').fill(SETUP_TOKEN)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Login mode')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(h1(page)).toHaveText('Site settings')
  if (options.autofocus)
    await page.getByLabel('Focus the user name field on the sign-in page').check()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(h1(page)).toHaveText('First administrator')
  await page.getByLabel('User name').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('New password again').fill(password)
  await page.getByRole('button', { name: 'Save and add a second factor' }).click()
  const account: Account = { username, password }
  if ((options.factor ?? 'totp') === 'totp') {
    await page.getByRole('button', { name: 'Add an authenticator app' }).click()
    account.totpSecret = await readTotpSecret(page)
    account.lastStep = Math.floor(Date.now() / 30_000)
    await page.getByLabel('Code from the app').fill(totpCode(account.totpSecret))
    await page.getByRole('button', { name: 'Verify and add' }).click()
  } else {
    await page.getByRole('button', { name: 'Add a passkey' }).click()
    await page.getByRole('button', { name: 'Add passkey' }).click()
    await expect(page.getByText('Passkey added')).toBeVisible()
  }
  // A passkey-only administrator gets no recovery codes in the wizard (SPEC/26 15.6).
  if (account.totpSecret) {
    account.recoveryCodes = await readRecoveryCodes(page)
    await page.getByLabel('I saved them').check()
    await page.getByRole('button', { name: 'Continue' }).click()
  }
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await expect(h1(page)).toHaveText('Setup complete')
  return account
}

export async function fillSignIn(page: Page, username: string, password: string) {
  await page.getByLabel('User name').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/**
 * A TOTP code the server will accept: a step above the last one used (replay block, SEC-TGT-012) and within +-1 of now.
 * Waits for the next 30 s step when the current window is used up; records the step on the account.
 */
export async function takeTotp(account: Account): Promise<string> {
  const used = account.lastStep ?? 0
  let step = Math.floor(Date.now() / 30_000) + 1
  if (step <= used) {
    await new Promise((r) => setTimeout(r, used * 30_000 - Date.now() + 700))
    step = Math.floor(Date.now() / 30_000) + 1
  }
  account.lastStep = step
  return totpCode(account.totpSecret!, step * 30_000)
}

export async function openSignIn(page: Page, server: LiveServer) {
  await page.goto(server.baseURL + '/')
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
}

export async function signInWithTotp(page: Page, server: LiveServer, account: Account) {
  await openSignIn(page, server)
  await fillSignIn(page, account.username, account.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  await page.getByLabel('Code from your authenticator app').fill(await takeTotp(account))
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
}

/** Password, then the next unused recovery code of the account (consumed). */
export async function signInWithRecovery(page: Page, server: LiveServer, account: Account) {
  await openSignIn(page, server)
  await fillSignIn(page, account.username, account.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  await page.getByRole('tab', { name: 'Recovery code' }).click()
  const code = account.recoveryCodes!.shift()!
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
}

export async function signOutAtPicker(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
}

/** Calls an auth server function the way the browser does is not possible here; cookies are read instead. */
export async function sessionCookie(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies()
  return cookies.find((c) => /dbloom-session/.test(c.name))?.value
}

/** Path of the server's SQLite store, once it exists. */
export function storePath(server: LiveServer): string | undefined {
  const names = readdirSync(server.dataDir).filter((n) => /\.(db|sqlite|sqlite3)$/.test(n))
  return names[0] ? join(server.dataDir, names[0]) : undefined
}

/** Runs one read-only query on the store; `undefined` when there is no store file or table yet. */
export function storeQuery<T = Record<string, unknown>>(
  server: LiveServer,
  sql: string,
  ...params: (string | number)[]
): T[] | undefined {
  const path = storePath(server)
  if (!path) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(sql).all(...params) as T[]
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export function setupTokenFile(server: LiveServer): string | undefined {
  try {
    return readFileSync(join(server.dataDir, 'setup-token'), 'utf8')
  } catch {
    return undefined
  }
}

// ---- target databases ----------------------------------------------------------------------------------------------

export type DbUser = {
  host: string
  port: number
  user: string
  password: string
  database: string
  drop: () => Promise<void>
}

/** A non-root user with its own database on one of the Docker test servers; dropped by `drop`. */
export async function createDbUser(server: typeof MYSQL): Promise<DbUser> {
  const id = randomBytes(4).toString('hex')
  const user = `e2e_acct_${id}`
  const database = `e2e_acct_${id}`
  const password = `Pw-${randomBytes(9).toString('base64url')}`
  const root = await createConnection({
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
  })
  try {
    await root.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`)
    await root.query(`CREATE TABLE \`${database}\`.items (id INT PRIMARY KEY, label VARCHAR(40))`)
    await root.query(`INSERT INTO \`${database}\`.items VALUES (1, 'one'), (2, 'two')`)
    await root.query('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password])
    await root.query(`GRANT ALL ON \`${database}\`.* TO ?@?`, [user, '%'])
  } finally {
    await root.end()
  }
  return {
    host: server.host,
    port: server.port,
    user,
    password,
    database,
    drop: async () => {
      const c = await createConnection({
        host: server.host,
        port: server.port,
        user: server.user,
        password: server.password,
      })
      try {
        await c.query(`DROP DATABASE IF EXISTS \`${database}\``)
        await c.query('DROP USER IF EXISTS ?@?', [user, '%'])
      } finally {
        await c.end()
      }
    },
  }
}
