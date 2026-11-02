import { expect, test } from '@playwright/test'
import {
  fillSignIn,
  h1,
  openSignIn,
  runSetupWizard,
  sessionCookie,
  signInWithRecovery,
  signOutAtPicker,
  startServer,
  takeTotp,
  totpCode,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-066 (password + TOTP, recovery code, throttling, enumeration) and SCN-077 (login page details) on a real server. */

const FAILED = 'Sign-in failed. Check the user name and password.'
const MFA_FAILED = 'That code or passkey was not accepted. Try again.'

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let ana: Account

test.beforeAll(async ({ browser }) => {
  server = await startServer()
  const page = await browser.newPage()
  ana = await runSetupWizard(page, server, { username: 'ana' })
  await page.close()
})
test.afterAll(async () => server?.stop())

test('SCN-066 password then TOTP: the cookie changes with each state; a reused code and a reused recovery code are refused', async ({
  page,
}) => {
  await openSignIn(page, server)
  expect(await sessionCookie(page)).toBeUndefined()
  await fillSignIn(page, ana.username, ana.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  const pending = await sessionCookie(page)
  expect(pending).toBeTruthy()

  await page.getByLabel('Code from your authenticator app').fill(await takeTotp(ana))
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
  const full = await sessionCookie(page)
  expect(full).toBeTruthy()
  expect(full).not.toBe(pending)
  const usedCode = totpCode(ana.totpSecret!, ana.lastStep! * 30_000)
  await signOutAtPicker(page)
  expect(await sessionCookie(page)).not.toBe(full)

  // The same code again inside its window: refused, and the second-factor page keeps working without a reload.
  await fillSignIn(page, ana.username, ana.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  await page.getByLabel('Code from your authenticator app').fill(usedCode)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toHaveText(MFA_FAILED)
  await expect(page.getByRole('button', { name: 'Sign in as someone else' })).toBeVisible()

  // A recovery code (case and dashes do not matter) gets in once.
  const code = ana.recoveryCodes!.shift()!
  await page.getByRole('tab', { name: 'Recovery code' }).click()
  await page
    .getByRole('textbox', { name: 'Recovery code' })
    .fill(code.toLowerCase().replaceAll('-', ' '))
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
  await signOutAtPicker(page)

  await fillSignIn(page, ana.username, ana.password)
  await page.getByRole('tab', { name: 'Recovery code' }).click()
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toHaveText(MFA_FAILED)

  // The remaining count dropped by one (10 at setup, one used).
  await page.getByRole('button', { name: 'Sign in as someone else' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
  await signInWithRecovery(page, server, ana)
  await page.goto(server.baseURL + '/account')
  await expect(page.getByText(/Recovery codes left: \d+/)).toBeVisible()
  await expect(page.getByText('Recovery codes left: 8')).toBeVisible()
  // No password, code or recovery code in the log.
  const log = server.log()
  expect(log).not.toContain(ana.password)
  expect(log).not.toContain(code)
  expect(log).not.toContain(ana.totpSecret!)
})

test('SCN-066 five wrong codes end the challenge; sign-in starts over', async ({ page }) => {
  await openSignIn(page, server)
  await fillSignIn(page, ana.username, ana.password)
  await expect(h1(page)).toHaveText('Confirm it is you')
  for (let i = 0; i < 5; i += 1) {
    await page.getByLabel('Code from your authenticator app').fill(String(100_000 + i * 7))
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
  }
  // The fifth wrong code ended it: the page says so and offers the way back.
  await expect(page.getByRole('alert')).toContainText('Sign in again')
  await page.getByRole('button', { name: 'Back to sign-in' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
})

test('SCN-066 six wrong passwords: same message, status and delay for a known and an unknown user; Retry-After on 429', async ({
  browser,
}) => {
  // Two fresh servers (one throttle each, the address counts too): the throttle of the shared one must not lock the other tests out.
  const fresh = await startServer()
  const fresh2 = await startServer()
  for (const s of [fresh, fresh2]) {
    const setup = await browser.newPage()
    await runSetupWizard(setup, s, { username: 'ana' })
    await setup.close()
  }
  const run = async (on: LiveServer, username: string) => {
    const page = await browser.newPage()
    const statuses: number[] = []
    let retryAfter: string | undefined
    page.on('response', (r) => {
      if (r.url().includes('/_serverFn/') && r.request().method() === 'POST') {
        statuses.push(r.status())
        if (r.status() === 429) retryAfter = r.headers()['retry-after']
      }
    })
    await openSignIn(page, on)
    const messages: string[] = []
    for (let i = 0; i < 6; i += 1) {
      // After the throttle starts the button is disabled for the countdown: wait it out only for the message check.
      const button = page.getByRole('button', { name: /^(Sign in|Try again in \d+ s)$/ })
      if (await button.isDisabled()) break
      await fillSignIn(page, username, `wrong password ${i}`)
      await expect(page.getByRole('alert')).toBeVisible()
      messages.push((await page.getByRole('alert').innerText()).trim())
    }
    await page.close()
    return { statuses, retryAfter, messages }
  }
  try {
    const a = await run(fresh, 'ana')
    const b = await run(fresh2, 'bob')
    expect(a.messages[0]).toBe(FAILED)
    expect(b.messages[0]).toBe(FAILED)
    // Same behaviour for the existing and the unknown user: same statuses, both throttled with a Retry-After.
    expect(a.statuses).toEqual(b.statuses)
    expect(a.statuses).toContain(429)
    expect(Number(a.retryAfter)).toBeGreaterThan(0)
    expect(Number(b.retryAfter)).toBeGreaterThan(0)
    expect(a.messages.at(-1)).toContain('Too many sign-in attempts')
    expect(b.messages.at(-1)).toBe(a.messages.at(-1))
  } finally {
    await fresh.stop()
    await fresh2.stop()
  }
})

test('SCN-077 login page: the mode is named, autofocus follows the setting, the page works by keyboard', async ({
  page,
  browser,
}) => {
  await openSignIn(page, server)
  await expect(page.getByText(/account/i).first()).toBeVisible()
  // Default setting off: focus stays on the page, not in the user name field.
  await expect(page.getByLabel('User name')).not.toBeFocused()
  // Keyboard only: Tab reaches the user name, then the password, then the button; Enter submits.
  await page.getByLabel('User name').focus()
  await page.keyboard.type(ana.username)
  await page.keyboard.press('Tab')
  await page.keyboard.type(ana.password)
  await page.keyboard.press('Enter')
  await expect(h1(page)).toHaveText('Confirm it is you')

  // Setting on: a second server whose wizard ticks the focus option.
  const focused = await startServer()
  const wizard = await browser.newPage()
  await runSetupWizard(wizard, focused, { username: 'ana', autofocus: true })
  await wizard.close()
  const page2 = await browser.newPage()
  await page2.goto(focused.baseURL + '/')
  await expect(h1(page2)).toHaveText('Sign in to DBLoom')
  await expect(page2.getByLabel('User name')).toBeFocused()
  await page2.close()
  await focused.stop()
})

test('SCN-077 direct mode names itself and keeps no credentials in the browser', async ({
  page,
}) => {
  const direct = await startServer({
    DBLOOM_LOGIN_MODE: 'direct',
    DBLOOM_AUTO_SETUP: 'direct',
    DBLOOM_DIRECT_TARGETS: '127.0.0.1:33064,127.0.0.1:33061',
  })
  try {
    await page.goto(direct.baseURL + '/')
    await expect(h1(page)).toHaveText('Sign in to a database server')
    await expect(page.getByText('Direct mode:')).toBeVisible()
    await page.locator('#server').fill('127.0.0.1:33064')
    await page.getByLabel('User name').fill('root')
    await page.getByLabel('Password', { exact: true }).fill('root')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('127.0.0.1:33064').first()).toBeVisible()
    const stored = await page.evaluate(() =>
      JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }),
    )
    expect(stored).not.toContain('root')
  } finally {
    await direct.stop()
  }
})

// Not implemented (SPEC/26 15.6): ST-074 / FR-AUT-019 "direct mode with ST-074 on preselects the last named server". The
// setting is read but the direct login form has no named-server list and no recall.
test.fixme('SCN-077 direct mode: the last named server is preselected (ST-074)', async () => {})
