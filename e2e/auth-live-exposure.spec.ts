import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { SECRET_KEY, SETUP_TOKEN, h1, runSetupWizard, signInWithRecovery, startServer, storeQuery, type Account, type LiveServer } from './fixtures/auth-live'

/** SPEC/31 on a real server: the page shows what the command shows, acknowledgement is audited and ends with a restart. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let admin: Account
const warnings = (page: Page) => page.getByRole('list', { name: 'Warnings' }).getByRole('listitem')

test.beforeAll(async ({ browser }) => {
  server = await startServer()
  const page = await browser.newPage()
  admin = await runSetupWizard(page, server, { username: 'root1' })
  await page.close()
})
test.afterAll(async () => server?.stop())

async function exposurePage(page: Page) {
  await signInWithRecovery(page, server, admin)
  await page.goto(`${server.baseURL}/admin/exposure`)
  await expect(h1(page)).toHaveText('Exposure and status')
}

/** The report as `dbloom exposure` prints it for the same environment as the live server. */
function cliReport(): [string, string][] {
  const out = execFileSync(process.execPath, [resolve('.output/cli/dbloom.mjs'), 'exposure'], {
    env: {
      ...process.env,
      PORT: String(server.port),
      DBLOOM_DATA_DIR: server.dataDir,
      DBLOOM_LOGIN_MODE: 'account',
      DBLOOM_PUBLIC_ORIGIN: server.baseURL,
      DBLOOM_SECRET_KEY: SECRET_KEY,
      DBLOOM_ALLOW_LOOPBACK: 'true',
      DBLOOM_TARGET_TLS: 'off',
    },
    encoding: 'utf8',
  })
  const lines: [string, string][] = []
  for (const line of out.split('\n')) {
    if (line === '') break // the report ends at the first blank line; warnings follow
    const m = /^(.+?) {2,}(.*)$/.exec(line)
    if (m) lines.push([m[1]!, m[2]!])
  }
  return lines
}

test('the page shows the status, the runtime warnings and the same report lines as the command, and no secret', async ({ page }) => {
  await exposurePage(page)
  await expect(warnings(page).filter({ hasText: 'No second factor is enforced for sign-in' })).toHaveCount(1)
  await expect(warnings(page).filter({ hasText: 'Administration pages are reachable from any address' })).toHaveCount(1)
  await expect(page.getByRole('definition').filter({ hasText: /^yes$/ })).toBeVisible()
  await expect(page.getByRole('definition').filter({ hasText: /^working$/ })).toBeVisible()
  await expect(page.getByRole('definition').filter({ hasText: /^stdout, ok$/ })).toBeVisible()
  const schema = storeQuery<{ user_version: number }>(server, 'PRAGMA user_version')?.[0]?.user_version
  expect(schema).toBeGreaterThanOrEqual(7)

  const lines = cliReport()
  expect(lines.length).toBeGreaterThan(8)
  for (const [label, value] of lines) {
    await expect(page.getByRole('term').getByText(label, { exact: true }), label).toBeVisible()
    await expect(page.getByRole('definition').filter({ hasText: value }).first(), `${label}: ${value}`).toBeVisible()
  }

  const body = await page.locator('body').innerText()
  expect(body).not.toContain(SECRET_KEY)
  expect(body).not.toContain(SETUP_TOKEN)
  expect(body).not.toMatch(/dbloom-session/)
})

test('acknowledging writes the audit row and shows who did it', async ({ page }) => {
  await exposurePage(page)
  await page.getByRole('button', { name: /^Acknowledge: No second factor/ }).click()
  await expect(warnings(page).filter({ hasText: 'No second factor' })).toContainText(/Acknowledged by root1 at /)
  const rows = storeQuery<{ actor_name: string | null; subject: string | null; outcome: string | null }>(server, "SELECT actor_name, subject, outcome FROM audit_log WHERE event = 'exposure.ack'")!
  expect(rows).toEqual([{ actor_name: 'root1', subject: 'no-mfa', outcome: 'ok' }])
  // A second click is not possible, and the audit viewer lists the event for the administrator.
  await expect(page.getByRole('button', { name: /^Acknowledge: No second factor/ })).toHaveCount(0)
  await page.goto(`${server.baseURL}/admin/audit`)
  await page.getByLabel('Event').selectOption('exposure.ack')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByRole('list', { name: 'Audit entries' }).getByRole('listitem')).toHaveCount(1)
})

test('the readiness detail answers an administrator session', async ({ page }) => {
  await signInWithRecovery(page, server, admin)
  const cookies = await page.context().cookies()
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const res = await fetch(`${server.baseURL}/api/ready`, { headers: { cookie: header } })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ready: true, mode: 'account', store: 'ok' })
})

test('a restart shows the acknowledged warning again; the audit row stays', async ({ page }) => {
  await server.restart()
  await exposurePage(page)
  await expect(warnings(page).filter({ hasText: 'No second factor' })).not.toContainText('Acknowledged')
  await expect(page.getByRole('button', { name: /^Acknowledge: No second factor/ })).toHaveCount(1)
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'exposure.ack'")![0]!.n).toBe(1)
})
