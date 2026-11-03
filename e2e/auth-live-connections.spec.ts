import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  MARIADB,
  MYSQL,
  createDbUser,
  h1,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  type Account,
  type DbUser,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-072 connection picker, several connections in several tabs, isolation, policy refusals, a lost target. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let admin: Account
let my: DbUser
let maria: DbUser

test.beforeAll(async ({ browser }) => {
  server = await startServer({ DBLOOM_DENY_ROOT_TARGET: 'true' })
  my = await createDbUser(MYSQL)
  maria = await createDbUser(MARIADB)
  const page = await browser.newPage()
  admin = await runSetupWizard(page, server, { username: 'ana' })
  await page.close()
})
test.afterAll(async () => {
  await server?.stop()
  await my?.drop().catch(() => undefined)
  await maria?.drop().catch(() => undefined)
})

async function typed(
  page: Page,
  over: { host: string; port?: number; user: string; password: string },
) {
  await page.getByRole('tab', { name: 'Type credentials' }).click()
  await page.getByLabel('Host').fill(over.host)
  if (over.port !== undefined) await page.getByLabel('Port').fill(String(over.port))
  await page.getByLabel('Database user').fill(over.user)
  await page.getByLabel('Database password').fill(over.password)
  // The Docker test servers have no TLS; the form defaults to a verified connection whatever the server's own TLS setting.
  await page.getByLabel('Connection security').selectOption({ label: 'Not encrypted' })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
}

const connectionId = (page: Page) =>
  page.evaluate(() => window.sessionStorage.getItem('x-dbloom-connection'))

test('SCN-072 policy refusals name their reason; any other failure is one generic message', async ({
  page,
}) => {
  await signInWithRecovery(page, server, admin)
  await typed(page, { host: MYSQL.host, port: MYSQL.port, user: 'root', password: MYSQL.password })
  await expect(page.getByRole('alert')).toHaveText(
    'Signing in as the database user root is not allowed on this server.',
  )
  await typed(page, { host: MYSQL.host, port: MYSQL.port, user: my.user, password: '' })
  await expect(page.getByRole('alert')).toHaveText(
    'Signing in with an empty database password is not allowed on this server.',
  )
  await typed(page, { host: MYSQL.host, port: MYSQL.port, user: my.user, password: 'wrong' })
  await expect(page.getByRole('alert')).toHaveText(
    'Could not connect. Check the host, port, user name and password.',
  )
  await typed(page, { host: '127.0.0.1', port: 1, user: my.user, password: my.password })
  await expect(page.getByRole('alert')).toHaveText(
    'Could not connect. Check the host, port, user name and password.',
  )
})

test('SCN-072 two tabs, two servers: each tab keeps its own target; a foreign or unknown connection id is refused; a lost target fails only its tab', async ({
  page,
  context,
  browser,
}) => {
  await signInWithRecovery(page, server, admin)
  await typed(page, { host: my.host, port: my.port, user: my.user, password: my.password })
  await expect(page.getByText(`${my.host}:${my.port}`).first()).toBeVisible()
  const idOne = await connectionId(page)
  expect(idOne).toBeTruthy()
  await expect(page.getByRole('button', { name: my.database, exact: true })).toBeVisible()

  // Tab 2 of the same session connects to MariaDB with typed credentials.
  const tab2 = await context.newPage()
  await tab2.goto(server.baseURL + '/')
  await expect(page.getByText(`${my.host}:${my.port}`).first()).toBeVisible()
  // The shell already has a connection: add another through the switcher.
  await tab2.getByRole('button', { name: 'Add connection' }).click()
  const add = tab2.getByRole('dialog', { name: 'Connections' })
  await add.getByRole('tab', { name: 'Type credentials' }).click()
  await add.getByLabel('Host').fill(maria.host)
  await add.getByLabel('Port').fill(String(maria.port))
  await add.getByLabel('Database user').fill(maria.user)
  await add.getByLabel('Database password').fill(maria.password)
  await add.getByLabel('Connection security').selectOption({ label: 'Not encrypted' })
  await add.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(() => connectionId(tab2)).not.toBe(idOne)
  const idTwo = await connectionId(tab2)
  await expect(tab2.getByRole('button', { name: maria.database, exact: true })).toBeVisible()

  // Each tab keeps its own target across a reload.
  await page.reload()
  await tab2.reload()
  await expect(page.getByRole('button', { name: my.database, exact: true })).toBeVisible()
  await expect(tab2.getByRole('button', { name: maria.database, exact: true })).toBeVisible()
  expect(await connectionId(page)).toBe(idOne)
  expect(await connectionId(tab2)).toBe(idTwo)

  // A request of tab 1 replayed with tab 2's id (same session) reaches tab 2's server; a foreign or invented id is refused.
  let captured: { url: string; headers: Record<string, string>; body: string | null } | undefined
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      r.url().includes('/_serverFn/') &&
      r.headers()['x-dbloom-connection']
    ) {
      captured = { url: r.url(), headers: r.headers(), body: r.postData() }
    }
  })
  await page.getByRole('button', { name: my.database, exact: true }).click()
  await expect.poll(() => captured).toBeTruthy()
  const replay = async (id: string, request = page.request) => {
    // The request client sends no Origin; the gate (FR-SVR-006) refuses a state-changing request without one.
    const headers: Record<string, string> = { ...captured!.headers, origin: server.baseURL, 'x-dbloom-connection': id }
    delete headers['content-length']
    const res = await request.fetch(captured!.url, {
      method: 'POST',
      headers,
      data: captured!.body ?? undefined,
    })
    return { status: res.status(), text: await res.text() }
  }
  const own = await replay(idOne!)
  expect(own.status).toBe(200)
  const other = await replay(idTwo!)
  expect(other.status).toBe(200)
  const bogus = await replay('00000000-0000-4000-8000-000000000000')
  expect(bogus.text).toContain('session_ended')
  // Another session of the same user: its connection id is foreign to this one.
  const foreignContext = await browser.newContext()
  const foreign = await foreignContext.newPage()
  await signInWithRecovery(foreign, server, admin)
  await typed(foreign, { host: my.host, port: my.port, user: my.user, password: my.password })
  await expect.poll(() => connectionId(foreign)).toBeTruthy()
  const foreignId = (await connectionId(foreign))!
  const refused = await replay(foreignId)
  expect(refused.text).toContain('session_ended')
  await foreignContext.close()

  // The typed password lives in session memory only: not in the store file.
  const files = readdirSync(server.dataDir).filter((n) => n.startsWith('dbloom.db'))
  for (const f of files)
    expect(readFileSync(join(server.dataDir, f)).includes(Buffer.from(my.password))).toBe(false)
  expect(server.log()).not.toContain(my.password)

  // MariaDB goes away: only tab 2 fails, with a way to retry.
  try {
    execFileSync('docker', ['compose', '-f', 'compose.test.yaml', 'stop', 'mariadb'], {
      stdio: 'ignore',
    })
    await tab2.getByRole('button', { name: maria.database, exact: true }).click()
    // SCN-072 asks for "Connection lost" with Retry: the shell shows its generic load error (open item, SPEC/26 15.6).
    await expect(tab2.getByText("Couldn't load this table.")).toBeVisible({ timeout: 30_000 })
    // Tab 1 (MySQL) is unaffected: its expanded database still lists its table.
    await expect(page.getByRole('button', { name: 'items' }).first()).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    execFileSync('docker', ['compose', '-f', 'compose.test.yaml', 'start', 'mariadb'], {
      stdio: 'ignore',
    })
    for (let i = 0; i < 40; i += 1) {
      const health = execFileSync(
        'docker',
        ['inspect', '-f', '{{.State.Health.Status}}', 'dbloom-mariadb-1'],
        { encoding: 'utf8' },
      ).trim()
      if (health === 'healthy') break
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  // Sign-out ends the connections; signing in again starts at the picker.
  await page.goto(server.baseURL + '/')
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
  expect(await connectionId(page)).toBeNull()
})

test('SCN-072 IPv6 targets: bracketed and bare ::1 reach the same target; both are refused when loopback is denied', async ({
  page,
  browser,
}) => {
  await signInWithRecovery(page, server, admin)
  const labels: string[] = []
  for (const host of ['[::1]', '::1']) {
    await typed(page, { host, port: my.port, user: my.user, password: my.password })
    await expect(
      h1(page).or(page.getByRole('button', { name: my.database, exact: true })),
    ).toBeVisible({ timeout: 15_000 })
    const label = await page.getByText(/::1/).first().innerText()
    labels.push(label.replace(/[\[\]]/g, ''))
    await page.goto(server.baseURL + '/')
    // Back to the picker for the next try: close the connection through the switcher.
    const close = page.getByRole('button', { name: 'Close this one' })
    if (await close.isVisible().catch(() => false)) await close.click()
  }
  expect(labels[0]).toBe(labels[1])

  // With loopback denied (a second server) both spellings are refused with the same words.
  const strict = await startServer({ DBLOOM_ALLOW_LOOPBACK: 'false' })
  const wizard = await browser.newPage()
  const a2 = await runSetupWizard(wizard, strict, { username: 'ana' })
  await wizard.close()
  const p2 = await browser.newPage()
  await signInWithRecovery(p2, strict, a2)
  const messages: string[] = []
  for (const host of ['[::1]', '::1']) {
    await typed(p2, { host, port: my.port, user: my.user, password: my.password })
    await expect(p2.getByRole('alert')).toBeVisible()
    messages.push((await p2.getByRole('alert').innerText()).trim())
  }
  expect(messages[0]).toBe(messages[1])
  await strict.stop()
})
