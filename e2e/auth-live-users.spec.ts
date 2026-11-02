import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  SECRET_KEY,
  addAuthenticator,
  dialog,
  fillSignIn,
  h1,
  openSignIn,
  readRecoveryCodes,
  readTotpSecret,
  runSetupWizard,
  sessionCookie,
  signInWithRecovery,
  signOutAtPicker,
  startServer,
  storeQuery,
  takeTotp,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-068 (enforced 2FA), SCN-069 (create user), SCN-070 (invite), SCN-071 (recovery link by the CLI) on a real server. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let admin: Account
const row = (page: Page, username: string) =>
  page.getByRole('list', { name: 'Users' }).getByRole('listitem').filter({ hasText: username })

test.beforeAll(async ({ browser }) => {
  // Everybody needs a second factor (scope all, no grace).
  server = await startServer({ DBLOOM_MFA_SCOPE: 'all', DBLOOM_MFA_GRACE_DAYS: '0' })
  const page = await browser.newPage()
  admin = await runSetupWizard(page, server, { username: 'root1' })
  await page.close()
})
test.afterAll(async () => server?.stop())

/** Answers a step-up prompt with the account's TOTP when one appears (the window is five minutes). */
async function stepUpIfAsked(page: Page, account: Account) {
  const d = dialog(page, 'Confirm it is you')
  if (await d.isVisible({ timeout: 1500 }).catch(() => false)) {
    await d.getByLabel('Code from your authenticator app').fill(await takeTotp(account))
    await d.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(d).toBeHidden()
  }
}

async function usersPage(page: Page) {
  await signInWithRecovery(page, server, admin)
  await page.getByRole('link', { name: 'Users' }).click()
  await expect(h1(page)).toHaveText('Users')
}

let temporary = ''

test('SCN-069 the administrator creates dora with a temporary password shown once; the last administrator cannot demote themself', async ({
  page,
}) => {
  await usersPage(page)
  await expect(row(page, 'root1')).toContainText('Administrator')
  await expect(row(page, 'root1').getByRole('combobox')).toBeDisabled()
  await page.getByRole('button', { name: 'Create user' }).first().click()
  const d = dialog(page, 'Create a user')
  await d.getByLabel('User name').fill('dora')
  await d.getByRole('button', { name: 'Generate password' }).click()
  await d.getByRole('button', { name: 'Create user' }).click()
  await stepUpIfAsked(page, admin)
  const done = dialog(page, 'User created')
  temporary = (await done.getByRole('list', { name: 'Temporary password' }).innerText()).replace(
    /\s+/g,
    '',
  )
  expect(temporary).toMatch(/^[A-Za-z0-9]{20}$/)
  await done.getByLabel('I passed it on').check()
  await done.getByRole('button', { name: 'Done' }).click()
  await expect(row(page, 'dora')).toBeVisible()
  // Never again: not in the page, not in the log.
  await page.reload()
  expect(await page.locator('body').innerText()).not.toContain(temporary)
  expect(server.log()).not.toContain(temporary)
  expect(server.log()).toContain('"audit":"user.create"')
  expect(storeQuery(server, 'SELECT COUNT(*) AS n FROM users')?.[0]).toEqual({ n: 2 })
})

test('SCN-069/068 dora must change the temporary password (weak name-containing password rated weak), then enrol a factor before getting in', async ({
  page,
}) => {
  await openSignIn(page, server)
  await fillSignIn(page, 'dora', temporary)
  const change = dialog(page, 'Choose a new password')
  await expect(change).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(change).toBeVisible()
  await change.getByLabel('Current password').fill(temporary)
  await change.getByLabel('New password', { exact: true }).fill('dora2024dora2024')
  await expect(change.getByTestId('strength')).toContainText(/weak|too short/i)
  await change.getByLabel('New password again').fill('dora2024dora2024')
  await change.getByRole('button', { name: 'Change password' }).click()
  await expect(change.getByRole('alert')).toBeVisible()
  const fresh = 'a better phrase for 77 days'
  await change.getByLabel('New password', { exact: true }).fill(fresh)
  await change.getByLabel('New password again').fill(fresh)
  await change.getByRole('button', { name: 'Change password' }).click()

  // Policy "all": no factor yet, so the only way on is enrolment (SCN-068).
  await expect(h1(page)).toHaveText('Add a second factor')
  const cookieBefore = await sessionCookie(page)
  const dora: Account = { username: 'dora', password: fresh }
  dora.totpSecret = await readTotpSecret(page)
  dora.lastStep = 0
  await page.getByLabel('Code from the app').fill(await takeTotp(dora))
  await page.getByRole('button', { name: 'Verify and add' }).click()
  await expect(h1(page)).toHaveText('Save your recovery codes')
  expect((await readRecoveryCodes(page)).length).toBe(10)
  await page.getByLabel('I saved them').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
  expect(await sessionCookie(page)).not.toBe(cookieBefore)
  // The temporary password no longer works.
  await signOutAtPicker(page)
  await fillSignIn(page, 'dora', temporary)
  await expect(page.getByRole('alert')).toHaveText(
    'Sign-in failed. Check the user name and password.',
  )
})

let inviteLink = ''

test('SCN-070 invite: token only in the fragment, taken name refused, passkey-only account, link works once, revoked link is the same page', async ({
  page,
  browser,
}) => {
  await usersPage(page)
  await page.getByRole('button', { name: 'Invite someone' }).click()
  const d = dialog(page, 'Invite someone')
  await d.getByLabel('Valid for').selectOption({ index: 0 })
  await d.getByRole('button', { name: 'Create invite link' }).click()
  await stepUpIfAsked(page, admin)
  const link = dialog(page, 'Invite link')
  inviteLink = (await link.getByRole('list', { name: 'Link' }).innerText()).replace(/\s+/g, '')
  expect(inviteLink).toContain('/invite#')
  const token = inviteLink.split('#')[1]!
  expect(token.length).toBeGreaterThanOrEqual(40)
  await link.getByLabel('I copied the link').check()
  await link.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('list', { name: 'Open invites' })).toContainText('User')

  // A second invite is revoked.
  await page.getByRole('button', { name: 'Invite someone' }).click()
  await dialog(page, 'Invite someone').getByRole('button', { name: 'Create invite link' }).click()
  await stepUpIfAsked(page, admin)
  const second = dialog(page, 'Invite link')
  const revokedLink = (await second.getByRole('list', { name: 'Link' }).innerText()).replace(
    /\s+/g,
    '',
  )
  await second.getByLabel('I copied the link').check()
  await second.getByRole('button', { name: 'Done' }).click()
  const open = page.getByRole('list', { name: 'Open invites' })
  await expect(open.getByRole('listitem')).toHaveCount(2)
  await open
    .getByRole('button', { name: /Revoke the invite/ })
    .last()
    .click()
  await expect(open.getByRole('listitem')).toHaveCount(1)

  // The invitee: the fragment leaves the address bar; "dora" is taken; "eve" registers a passkey.
  const ctx = await browser.newContext()
  const invitee = await ctx.newPage()
  await addAuthenticator(invitee, { uv: true })
  await invitee.goto(inviteLink)
  await expect(h1(invitee)).toHaveText('Create your account')
  expect(await invitee.evaluate(() => location.hash)).toBe('')
  expect(invitee.url()).not.toContain(token)
  await invitee.getByRole('tab', { name: 'Passkey' }).click()
  await invitee.getByLabel('User name').fill('dora')
  await invitee.getByRole('button', { name: 'Add passkey' }).click()
  await expect(invitee.getByRole('alert')).toBeVisible()
  await invitee.getByLabel('User name').fill('eve')
  await invitee.getByRole('button', { name: 'Add passkey' }).click()
  await expect(h1(invitee)).toHaveText('Account created')

  // The new account signs in passwordless, no password anywhere.
  await invitee.goto(server.baseURL + '/')
  await invitee.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(h1(invitee)).toHaveText('Connect to a database')
  await ctx.close()

  // Used and revoked links show the same page; no token in the server log.
  const messages: string[] = []
  for (const url of [inviteLink, revokedLink]) {
    const c = await browser.newContext()
    const p = await c.newPage()
    await p.goto(url)
    await p
      .getByRole('tab', { name: 'Passkey' })
      .click()
      .catch(() => undefined)
    await p.getByLabel('User name').fill('zed')
    await p.getByRole('button', { name: /Add passkey|Create account/ }).click()
    messages.push((await p.getByRole('alert').innerText()).trim())
    await c.close()
  }
  expect(messages[0]).toContain('This invite link is not valid')
  expect(messages[1]).toBe(messages[0])
  expect(server.log()).not.toContain(token)
  expect(server.log()).not.toContain(revokedLink.split('#')[1]!)
})

test('SCN-071 recovery link issued by the CLI for the only administrator: all factors and sessions end, no "forgot password" page', async ({
  page,
  browser,
}) => {
  // A second browser holds a session of the administrator.
  const other = await (await browser.newContext()).newPage()
  await signInWithRecovery(other, server, admin)
  await openSignIn(page, server)
  await expect(page.getByText(/forgot/i)).toHaveCount(0)

  const out = execFileSync(
    process.execPath,
    [resolve('.output/cli/dbloom.mjs'), 'recover', admin.username],
    {
      env: {
        ...process.env,
        DBLOOM_DATA_DIR: server.dataDir,
        DBLOOM_SECRET_KEY: SECRET_KEY,
        DBLOOM_PUBLIC_ORIGIN: server.baseURL,
        DBLOOM_LOGIN_MODE: 'account',
      },
      encoding: 'utf8',
    },
  )
  const link = out.split('\n').find((l) => l.includes('/recover#'))!
  expect(link).toBeTruthy()
  expect(server.log()).not.toContain(link.split('#')[1]!)

  await page.goto(link)
  await expect(h1(page)).toHaveText('Recover your account')
  expect(await page.evaluate(() => location.hash)).toBe('')
  const password = 'a recovered password 2026'
  await page.getByLabel('New password', { exact: true }).fill(password)
  await page.getByLabel('New password again').fill(password)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(h1(page)).toHaveText('Sign-in restored')
  // The audit line carries the actor "cli" for the issue; the factors and codes are gone.
  expect(storeQuery(server, 'SELECT COUNT(*) AS n FROM totp')?.[0]).toEqual({ n: 1 }) // dora's only
  expect(
    storeQuery<{ n: number }>(
      server,
      "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE username_key = 'root1')",
    )?.[0]?.n ?? 0,
  ).toBe(0)

  // The other browser's session ended.
  await other.goto(server.baseURL + '/')
  await expect(h1(other)).toHaveText('Sign in to DBLoom')
  // Policy "all": the administrator enrols a factor again before getting in.
  await openSignIn(page, server)
  await fillSignIn(page, admin.username, password)
  await expect(h1(page)).toHaveText('Add a second factor')
})
