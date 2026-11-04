import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  dialog,
  h1,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  storeQuery,
  takeTotp,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SPEC/33 on a real server with a one-minute revert: protected settings revert unless confirmed after signing in again. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const EXTRAS = { DBLOOM_AUTOREVERT_MINUTES: '1' }
const NAME = 'Failed sign-ins before a delay'
let server: LiveServer
let admin: Account
let adminPage: Page
let adminContext: BrowserContext

const row = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })
const pendingLine = (page: Page) => row(page, NAME).getByRole('group', { name: 'Change waiting for confirmation' })

type PendingRow = { key: string; revert_to: string | null; new_value: string; deadline_at: number; status: string }
const pendingRows = () => storeQuery<PendingRow>(server, 'SELECT key, revert_to, new_value, deadline_at, status FROM pending_settings ORDER BY key')!
const pendingOf = (key: string) => pendingRows().find((r) => r.key === key)
const stored = (key: string) => storeQuery<{ value: string }>(server, 'SELECT value FROM settings WHERE key = ?', key)?.[0]?.value
const events = () => storeQuery<{ event: string }>(server, "SELECT event FROM audit_log WHERE event LIKE 'settings.%' ORDER BY id")!.map((r) => r.event)

test.beforeAll(async ({ browser }) => {
  server = await startServer(EXTRAS)
  const setup = await browser.newPage()
  admin = await runSetupWizard(setup, server, { username: 'root1' })
  await setup.close()
  await newAdmin(browser)
})
test.afterAll(async () => {
  await adminContext?.close()
  await server?.stop()
})

/** A new browser context signs the administrator in with the next recovery code: its session starts after any earlier change. */
async function newAdmin(browser: Browser) {
  await adminContext?.close()
  adminContext = await browser.newContext()
  adminPage = await adminContext.newPage()
  await signInWithRecovery(adminPage, server, admin)
}

async function stepUpIfAsked(page: Page) {
  const d = dialog(page, 'Confirm it is you')
  if (await d.isVisible({ timeout: 1500 }).catch(() => false)) {
    await d.getByLabel('Code from your authenticator app').fill(await takeTotp(admin))
    await d.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(d).toBeHidden()
  }
}

async function settingsPage() {
  await adminPage.goto(`${server.baseURL}/admin/settings`)
  await expect(h1(adminPage)).toHaveText('Settings')
}

async function change(value: string) {
  await row(adminPage, NAME).getByLabel(NAME, { exact: true }).fill(value)
  await row(adminPage, NAME).getByRole('button', { name: `Save: ${NAME}` }).click()
  await stepUpIfAsked(adminPage)
  await expect(pendingLine(adminPage)).toBeVisible()
}

/** Waits until the server has put the old value back, with nobody looking at a page. */
async function waitForRevert() {
  await expect.poll(() => pendingOf('loginFailures')?.status, { timeout: 120_000, intervals: [2000] }).toBe('reverted')
}

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [resolve('.output/cli/dbloom.mjs'), ...args], {
    env: { ...process.env, DBLOOM_DATA_DIR: server.dataDir, ...EXTRAS },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout }
}

test('the page says a protected change reverts, and shows the pending line after a change', async () => {
  await settingsPage()
  await expect(row(adminPage, NAME)).toContainText('Protected setting: a change reverts in 1 minute unless confirmed after signing in again.')
  await change('7')
  await expect(pendingLine(adminPage)).toContainText('Waiting for confirmation: now 7.')
  expect(stored('loginFailures')).toBe('7')
  expect(pendingOf('loginFailures')).toMatchObject({ revert_to: null, new_value: '7', status: 'pending' })
  expect(events()).toContain('settings.pending')
})

test('an unconfirmed change reverts with nobody signed in', async ({ browser }) => {
  const deadline = pendingOf('loginFailures')!.deadline_at
  await adminContext.close() // nobody is signed in any more
  await waitForRevert()
  expect(Date.now()).toBeGreaterThanOrEqual(deadline)
  expect(stored('loginFailures')).toBeUndefined()
  expect(events()).toContain('settings.revert')
  await newAdmin(browser)
  await settingsPage()
  await expect(row(adminPage, NAME).getByLabel(NAME, { exact: true })).toHaveValue('5')
  await expect(pendingLine(adminPage)).toHaveCount(0)
})

test('the session that made the change cannot confirm it; signing in again and confirming keeps it', async ({ browser }) => {
  await settingsPage()
  await change('8')
  await pendingLine(adminPage).getByRole('button', { name: `Confirm change: ${NAME}` }).click()
  await expect(row(adminPage, NAME).getByRole('alert')).toContainText('Sign in again with the new settings, then confirm.')
  await newAdmin(browser)
  await settingsPage()
  await pendingLine(adminPage).getByRole('button', { name: `Confirm change: ${NAME}` }).click()
  await stepUpIfAsked(adminPage)
  await expect(row(adminPage, NAME)).toContainText('Change confirmed.')
  expect(pendingOf('loginFailures')?.status).toBe('confirmed')
  const deadline = pendingOf('loginFailures')!.deadline_at
  await expect.poll(() => Date.now(), { timeout: 90_000, intervals: [5000] }).toBeGreaterThan(deadline + 3000)
  expect(stored('loginFailures')).toBe('8')
  expect(pendingOf('loginFailures')?.status).toBe('confirmed')
  expect(events()).toContain('settings.confirm')
})

test('a server restart keeps the deadline, and an overdue change is reverted at start', async ({ browser }) => {
  await settingsPage()
  await change('9')
  const before = pendingOf('loginFailures')!
  expect(before.status).toBe('pending')
  expect(before.revert_to).toBe('8') // the value before the first change in this round
  await adminContext.close()
  await server.restart(EXTRAS)
  expect(pendingOf('loginFailures')).toMatchObject({ deadline_at: before.deadline_at, status: 'pending', revert_to: '8' })
  await waitForRevert()
  expect(stored('loginFailures')).toBe('8')
  await newAdmin(browser)
})

test('the CLI reset clears a pending change', async ({ browser }) => {
  await settingsPage()
  await change('6')
  expect(pendingOf('loginFailures')?.status).toBe('pending')
  const r = cli(['settings', 'reset', 'loginFailures'])
  expect(r.code).toBe(0)
  expect(pendingOf('loginFailures')?.status).toBe('superseded')
  expect(stored('loginFailures')).toBeUndefined()
  const list = cli(['settings', 'pending'])
  expect(list.code).toBe(0)
  expect(list.out).not.toContain('loginFailures')
  await adminPage.reload()
  await expect(pendingLine(adminPage)).toHaveCount(0)
  // the old timer must not touch the now-superseded row
  await new Promise((res) => setTimeout(res, 70_000))
  expect(pendingOf('loginFailures')?.status).toBe('superseded')
  expect(stored('loginFailures')).toBeUndefined()
  void browser
})
