import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  dialog,
  fillSignIn,
  h1,
  openSignIn,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  storeQuery,
  takeTotp,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SPEC/30 FR-AUS-006 on a real server: the Users page actions, the audit trail they leave, and the detector notices. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let admin: Account
let adminPage: Page
let adminContext: BrowserContext
const temps: Record<string, string> = {}
const row = (page: Page, username: string) => page.getByRole('list', { name: 'Users' }).getByRole('listitem').filter({ hasText: username })
const unread = (page: Page) => page.getByRole('list', { name: 'Unread notices' }).getByRole('listitem')

test.beforeAll(async ({ browser }) => {
  // Trusted loopback proxy: the specs choose the client address with `X-Forwarded-For`. Burst threshold at its minimum.
  server = await startServer({ DBLOOM_TRUST_PROXY: '127.0.0.1/32,::1/128', DBLOOM_NOTICE_BURST_FAILURES: '3' })
  const setup = await browser.newPage()
  admin = await runSetupWizard(setup, server, { username: 'root1' })
  await setup.close()
  adminContext = await browser.newContext()
  adminPage = await adminContext.newPage()
  await signInWithRecovery(adminPage, server, admin)
})
test.afterAll(async () => {
  await adminContext?.close()
  await server?.stop()
})

async function stepUpIfAsked(page: Page) {
  const d = dialog(page, 'Confirm it is you')
  if (await d.isVisible({ timeout: 1500 }).catch(() => false)) {
    await d.getByLabel('Code from your authenticator app').fill(await takeTotp(admin))
    await d.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(d).toBeHidden()
  }
}

async function usersPage() {
  await adminPage.goto(`${server.baseURL}/admin/users`)
  await expect(h1(adminPage)).toHaveText('Users')
}

async function menu(username: string, item: string) {
  await adminPage.getByRole('button', { name: `Actions for ${username}` }).click()
  await adminPage.getByRole('menuitem', { name: item }).click()
}

async function createUser(username: string): Promise<string> {
  await usersPage()
  await adminPage.getByRole('button', { name: 'Create user' }).first().click()
  const d = dialog(adminPage, 'Create a user')
  await d.getByLabel('User name').fill(username)
  await d.getByRole('button', { name: 'Generate password' }).click()
  await d.getByRole('button', { name: 'Create user' }).click()
  await stepUpIfAsked(adminPage)
  const done = dialog(adminPage, 'User created')
  const temporary = (await done.getByRole('list', { name: 'Temporary password' }).innerText()).replace(/\s+/g, '')
  await done.getByLabel('I passed it on').check()
  await done.getByRole('button', { name: 'Done' }).click()
  await expect(row(adminPage, username)).toBeVisible()
  temps[username] = temporary
  return temporary
}

/** A user in an own browser context, signed in from `address` (the client address the server sees through the trusted proxy). */
async function userSession(browser: Browser, username: string, address: string, password: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': address } })
  const page = await context.newPage()
  await openSignIn(page, server)
  await fillSignIn(page, username, password)
  return { context, page }
}

/** First sign-in with the temporary password: choose a new one, then land on the picker (no second factor is required here). */
async function firstSignIn(browser: Browser, username: string, address: string) {
  const s = await userSession(browser, username, address, temps[username]!)
  const change = dialog(s.page, 'Choose a new password')
  await change.getByLabel('Current password').fill(temps[username]!)
  const fresh = 'purple harbour violin 4242 quiet'
  await change.getByLabel('New password', { exact: true }).fill(fresh)
  await change.getByLabel('New password again').fill(fresh)
  await change.getByRole('button', { name: 'Change password' }).click()
  await expect(h1(s.page)).toHaveText('Connect to a database')
  temps[username] = fresh
  return s
}

const FAILED = 'Sign-in failed. Check the user name and password.'

test('three users are created from the Users page', async () => {
  for (const name of ['ann', 'ben', 'cat']) await createUser(name)
  await expect(row(adminPage, 'ann')).toContainText('User')
})

test('disable signs the user out at once and blocks the sign-in; enable lets them back', async ({ browser }) => {
  const ann = await firstSignIn(browser, 'ann', '203.0.113.5')
  await usersPage()
  await menu('ann', 'Disable account')
  await expect(adminPage.getByText('ann is disabled and signed out.')).toBeVisible()
  await expect(row(adminPage, 'ann')).toContainText('Disabled')
  await ann.page.reload()
  await expect(h1(ann.page)).toHaveText('Sign in to DBLoom')
  await fillSignIn(ann.page, 'ann', temps.ann!)
  await expect(ann.page.getByRole('alert')).toHaveText(FAILED)
  await menu('ann', 'Enable account')
  await expect(row(adminPage, 'ann')).not.toContainText('Disabled')
  await fillSignIn(ann.page, 'ann', temps.ann!)
  await expect(h1(ann.page)).toHaveText('Connect to a database')
  await ann.context.close()
  const events = storeQuery<{ event: string; subject: string | null }>(server, "SELECT event, subject FROM audit_log WHERE event = 'user.status' ORDER BY id")!
  expect(events.length).toBeGreaterThanOrEqual(2)
})

test('a role change shows at once; the own role cannot be changed', async () => {
  await usersPage()
  await expect(row(adminPage, 'root1').getByRole('combobox')).toBeDisabled()
  await row(adminPage, 'ben').getByRole('combobox').selectOption('admin')
  await stepUpIfAsked(adminPage)
  await expect(adminPage.getByText('Role of ben changed.')).toBeVisible()
  await expect(row(adminPage, 'ben').getByRole('combobox')).toHaveValue('admin')
  await row(adminPage, 'ben').getByRole('combobox').selectOption('user')
  await stepUpIfAsked(adminPage)
  await expect(row(adminPage, 'ben').getByRole('combobox')).toHaveValue('user')
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'user.role'")![0]!.n).toBe(2)
})

test('sign out everywhere ends the sessions of that user', async ({ browser }) => {
  const cat = await firstSignIn(browser, 'cat', '203.0.113.6')
  await usersPage()
  await menu('cat', 'Sign out everywhere')
  await stepUpIfAsked(adminPage)
  await expect(adminPage.getByText(/Ended \d+ sessions of cat\./)).toBeVisible()
  await cat.page.reload()
  await expect(h1(cat.page)).toHaveText('Sign in to DBLoom')
  await cat.context.close()
})

test('a burst of failed attempts and a sign-in from a new network reach the administrator panel', async ({ browser }) => {
  // Burst: three wrong passwords for ben from one address (threshold 3 on this server).
  const burst = await userSession(browser, 'ben', '203.0.113.50', 'not the password at all')
  await expect(burst.page.getByRole('alert')).toHaveText(FAILED)
  for (let i = 0; i < 2; i++) {
    // Wait for each answer: the alert text is the same every time, so it cannot tell the attempts apart.
    const answered = burst.page.waitForResponse((r) => r.url().includes('passwordSignIn'))
    await fillSignIn(burst.page, 'ben', 'not the password at all')
    await answered
  }
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'auth.signin' AND outcome = 'failed' AND subject = (SELECT id FROM users WHERE username = 'ben')")![0]!.n).toBe(3)
  await burst.context.close()

  // New location: ann signs in from the network she used before (silent), then from another one.
  const same = await userSession(browser, 'ann', '203.0.113.99', temps.ann!)
  await expect(h1(same.page)).toHaveText('Connect to a database')
  await same.context.close()
  const other = await userSession(browser, 'ann', '198.51.100.9', temps.ann!)
  await expect(h1(other.page)).toHaveText('Connect to a database')
  await other.context.close()

  await usersPage()
  await expect(unread(adminPage).filter({ hasText: 'account ben: 3 failed sign-in steps in 10 min' })).toHaveCount(1)
  await expect(unread(adminPage).filter({ hasText: 'address 203.0.113.0: 3 failed sign-in steps in 10 min' })).toHaveCount(1)
  await expect(unread(adminPage).filter({ hasText: 'account ann from 198.51.100.0' })).toHaveCount(1)
  // Exactly one new-location notice: the first sign-in and the same /24 raised none.
  await expect(unread(adminPage).filter({ hasText: 'new location' })).toHaveCount(1)

  // Dismiss one; it is gone from the unread list and survives a reload.
  const before = await unread(adminPage).count()
  await unread(adminPage).filter({ hasText: 'account ben:' }).getByRole('button', { name: /^Dismiss the notice/ }).click()
  await expect(unread(adminPage)).toHaveCount(before - 1)
  await adminPage.reload()
  await expect(unread(adminPage)).toHaveCount(before - 1)
  await adminPage.getByRole('button', { name: /^Show earlier notices/ }).click()
  await expect(adminPage.getByRole('list', { name: 'Earlier notices' })).toContainText('account ben:')
})

test('the Activity action opens the viewer for that user', async () => {
  await usersPage()
  await menu('ann', 'Activity')
  await expect(h1(adminPage)).toHaveText('Audit log')
  await expect(adminPage.getByLabel('Actor')).not.toHaveValue('')
  const entries = adminPage.getByRole('list', { name: 'Audit entries' }).getByRole('listitem')
  await expect(entries.first()).toBeVisible()
  for (const li of await entries.all()) await expect(li).toContainText('by ann')
})

test('a recovery link issued from the page needs a step-up and is audited', async () => {
  await usersPage()
  await menu('ben', 'Issue recovery link')
  await stepUpIfAsked(adminPage)
  const d = dialog(adminPage, 'Recovery link for ben')
  await expect(d.getByRole('list', { name: 'Link' })).toContainText(/\/recover#[A-Za-z0-9_-]{30,}/)
  await d.getByLabel('I copied the link').check()
  await d.getByRole('button', { name: 'Done' }).click()
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'recovery.issue'")![0]!.n).toBe(1)
  expect(server.log()).not.toMatch(/recover#[A-Za-z0-9_-]{20}/)
})

test('deleting a user keeps their audit history, removes the account and the sign-in then fails', async ({ browser }) => {
  const annRows = storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE actor_name = 'ann'")![0]!.n
  expect(annRows).toBeGreaterThan(0)
  await usersPage()
  await menu('ann', 'Delete user')
  await dialog(adminPage, 'Delete ann?').getByRole('button', { name: 'Delete user' }).click()
  await stepUpIfAsked(adminPage)
  await expect(adminPage.getByText('ann was deleted.')).toBeVisible()
  await expect(row(adminPage, 'ann')).toHaveCount(0)
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM users WHERE username = 'ann'")![0]!.n).toBe(0)
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE actor_name = 'ann'")![0]!.n).toBeGreaterThanOrEqual(annRows)
  expect(storeQuery<{ n: number }>(server, 'SELECT COUNT(*) AS n FROM seen_locations')![0]!.n).toBeGreaterThanOrEqual(0)
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM seen_locations WHERE user_id NOT IN (SELECT id FROM users)")![0]!.n).toBe(0)
  const gone = await userSession(browser, 'ann', '203.0.113.5', temps.ann!)
  await expect(gone.page.getByRole('alert')).toHaveText(FAILED)
  await gone.context.close()
})
