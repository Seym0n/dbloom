import { expect, test, type Page } from '@playwright/test'
import {
  NEW_PASSWORD,
  dialog,
  fillSignIn,
  h1,
  openSignIn,
  runSetupWizard,
  sessionCookie,
  signInWithRecovery,
  startServer,
  storeQuery,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-074 sessions: the per-user limit, invalidation by a security event, a disabled user, sign-out. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let admin: Account

test.beforeAll(async ({ browser }) => {
  // Administrators hold two full sessions at most (the default of ST-071 for the role).
  server = await startServer({ DBLOOM_SESSIONS_PER_ADMIN: '2' })
  const page = await browser.newPage()
  admin = await runSetupWizard(page, server, { username: 'ana' })
  await page.close()
})
test.afterAll(async () => server?.stop())

const fullSessions = () =>
  storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM sessions WHERE state = 'full'")?.[0]
    ?.n ?? 0

async function newSession(browser: import('@playwright/test').Browser): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await signInWithRecovery(page, server, admin)
  return page
}

test('SCN-074 a third sign-in evicts the oldest session of an administrator, which then ends with a notice for the user', async ({
  browser,
}) => {
  const a = await newSession(browser)
  const b = await newSession(browser)
  expect(fullSessions()).toBe(2)
  const c = await newSession(browser)
  expect(fullSessions()).toBe(2)

  // The evicted session is gone on its next request: back to the sign-in page.
  await a.reload()
  await expect(h1(a)).toHaveText('Sign in to DBLoom')
  // The user is told in the security events list.
  await c.goto(server.baseURL + '/account')
  await expect(c.getByRole('list', { name: 'Recent security events' })).toBeVisible()
  await expect(
    c.getByRole('list', { name: 'Recent security events' }).getByRole('listitem').first(),
  ).toBeVisible()
  // Both remaining sessions are listed, one of them marked as this session.
  const sessions = c.getByRole('list', { name: 'Where you are signed in' })
  await expect(sessions.getByRole('listitem')).toHaveCount(2)
  await expect(sessions.getByText('This session')).toBeVisible()
  await a.context().close()
  await b.context().close()
  await c.context().close()
})

test('SCN-074 a password change ends the other sessions; the current one continues with a new cookie', async ({
  browser,
}) => {
  const b = await newSession(browser)
  const c = await newSession(browser)
  await b.goto(server.baseURL + '/account')
  const before = await sessionCookie(b)
  await b.getByRole('button', { name: 'Change password' }).click()
  const change = dialog(b, 'Change password')
  await change.getByLabel('Current password').fill(admin.password)
  await change.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await change.getByLabel('New password again').fill(NEW_PASSWORD)
  await change.getByRole('button', { name: 'Change password' }).click()
  await expect(b.getByText('Password changed.')).toBeVisible()
  admin.password = NEW_PASSWORD
  expect(await sessionCookie(b)).not.toBe(before)
  // The other session ends; this one still works after a reload.
  await c.reload()
  await expect(h1(c)).toHaveText('Sign in to DBLoom')
  await b.reload()
  await expect(h1(b)).toHaveText('Account security')
  expect(fullSessions()).toBe(1)

  // Sign-out ends the session on the server (SCN-010): the row is gone and the page returns to sign-in.
  await b.goto(server.baseURL + '/')
  await b.getByRole('button', { name: 'Sign out' }).click()
  await expect(h1(b)).toHaveText('Sign in to DBLoom')
  expect(fullSessions()).toBe(0)
  await b.goto(server.baseURL + '/account')
  await expect(h1(b)).toHaveText('Sign in to DBLoom')
  await b.context().close()
  await c.context().close()
})

test('SCN-074 an administrator disables a user with an open session: the next request ends it', async ({
  browser,
}) => {
  const adminPage = await newSession(browser)
  await adminPage.getByRole('link', { name: 'Users' }).click()
  await adminPage.getByRole('button', { name: 'Create user' }).first().click()
  const d = dialog(adminPage, 'Create a user')
  await d.getByLabel('User name').fill('dora')
  await d.getByLabel('Temporary password').fill('temporary pass phrase 11')
  await d.getByRole('button', { name: 'Create user' }).click()
  const done = dialog(adminPage, 'User created')
  await done.getByLabel('I passed it on').check()
  await done.getByRole('button', { name: 'Done' }).click()

  const ctx = await browser.newContext()
  const dora = await ctx.newPage()
  await openSignIn(dora, server)
  await fillSignIn(dora, 'dora', 'temporary pass phrase 11')
  const change = dialog(dora, 'Choose a new password')
  await change.getByLabel('Current password').fill('temporary pass phrase 11')
  await change.getByLabel('New password', { exact: true }).fill('a brand new phrase 2026')
  await change.getByLabel('New password again').fill('a brand new phrase 2026')
  await change.getByRole('button', { name: 'Change password' }).click()
  await expect(h1(dora)).toHaveText('Connect to a database')

  await adminPage.getByRole('button', { name: 'Actions for dora' }).click()
  await adminPage.getByRole('menuitem', { name: 'Disable account' }).click()
  await expect(adminPage.getByText('dora is disabled and signed out.')).toBeVisible()
  await dora.reload()
  await expect(h1(dora)).toHaveText('Sign in to DBLoom')
  await fillSignIn(dora, 'dora', 'a brand new phrase 2026')
  await expect(dora.getByRole('alert')).toHaveText(
    'Sign-in failed. Check the user name and password.',
  )
  await ctx.close()
  await adminPage.context().close()
})

// Not covered live (SPEC/26 15.6): the idle limit of an administrator has a floor of 5 minutes, and the two-minute
// warning with "Stay signed in" (SEC-UIX-109, FR-AUT-017) is not built in the UI.
test.fixme('SCN-074 the idle warning appears two minutes before the limit and "Stay signed in" renews it', async () => {})
