import { readdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  BREACHED_PASSWORD,
  PASSWORD,
  SETUP_TOKEN,
  addAuthenticator,
  h1,
  setupTokenFile,
  startServer,
  storeQuery,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-064 and SCN-065 against a real account-mode server: first-run wizard, token, store untouched until step 5. */

const count = (server: LiveServer, table: string) =>
  storeQuery<{ n: number }>(server, `SELECT COUNT(*) AS n FROM ${table}`)?.[0]?.n ?? 0

test('SCN-064 setup wizard: token, breached password, passkey, store written only at the end, 404 afterwards', async ({
  page,
}) => {
  const server = await startServer()
  try {
    await addAuthenticator(page, { uv: true })
    // The token file (data directory, mode 0600) carries the token.
    expect(setupTokenFile(server)?.startsWith(SETUP_TOKEN)).toBe(true)

    // `/` sends the visitor to the wizard.
    await page.goto(server.baseURL + '/')
    await expect(page).toHaveURL(/\/setup/)
    await expect(h1(page)).toHaveText('Welcome to DBLoom')
    await expect(page.getByText('Step 1 of 5')).toBeVisible()
    await expect(page.getByText('Stateful (SQLite)')).toBeVisible()

    // A wrong token: same page, one message; then the right one.
    await page.getByLabel('Setup token').fill('wrong-token-wrong-token-1')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toHaveText('That token was not accepted.')
    await expect(h1(page)).toHaveText('Welcome to DBLoom')
    await page.getByLabel('Setup token').fill(SETUP_TOKEN)
    await page.getByRole('button', { name: 'Continue' }).click()

    // Step 2 preselects the mode from .env; step 3 shows the environment status.
    await expect(h1(page)).toHaveText('Login mode')
    await expect(page.getByLabel(/Account mode/)).toBeChecked()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(h1(page)).toHaveText('Site settings')
    await expect(page.getByRole('heading', { name: 'Server environment' })).toBeVisible()
    const ack = page.getByLabel('I understand and want to continue from this address.')
    if (await ack.isVisible().catch(() => false)) await ack.check()
    await page.getByRole('button', { name: 'Next' }).click()

    // Step 4: a breached password is refused (fail closed), a good one passes, a passkey is enrolled.
    await expect(h1(page)).toHaveText('First administrator')
    await page.getByLabel('User name').fill('admin')
    await page.getByLabel('Password', { exact: true }).fill(BREACHED_PASSWORD)
    await page.getByLabel('New password again').fill(BREACHED_PASSWORD)
    await page.getByRole('button', { name: 'Save and add a second factor' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('New password again').fill(PASSWORD)
    await page.getByRole('button', { name: 'Save and add a second factor' }).click()
    await page.getByRole('button', { name: 'Add a passkey' }).click()
    await page.getByRole('button', { name: 'Add passkey' }).click()
    await expect(page.getByText('Passkey added')).toBeVisible()
    // A passkey-only administrator gets no recovery codes in the wizard (finding, SPEC/26 15.6): codes come with TOTP.

    // Nothing is in the store before step 5.
    expect(count(server, 'users')).toBe(0)
    expect(count(server, 'webauthn_credentials')).toBe(0)
    expect(count(server, 'recovery_codes')).toBe(0)
    expect(count(server, 'passwords')).toBe(0)

    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(h1(page)).toHaveText('Setup complete')
    await expect(page.getByText('Step 5 of 5')).toBeVisible()

    // After step 5: rows exist, the token file is gone, the console says so, `/setup` is gone, also after a restart.
    expect(count(server, 'users')).toBe(1)
    expect(count(server, 'webauthn_credentials')).toBe(1)
    expect(setupTokenFile(server)).toBeUndefined()
    expect(readdirSync(server.dataDir).some((n) => n.startsWith('setup-token'))).toBe(false)
    expect(server.log()).toContain('setup token consumed')
    expect(server.log()).toContain('setup.complete')
    // No secrets in the log.
    expect(server.log()).not.toContain(PASSWORD)
    expect((await page.request.get(server.baseURL + '/setup')).status()).toBe(404)
    await server.restart()
    expect((await page.request.get(server.baseURL + '/setup')).status()).toBe(404)
    expect(setupTokenFile(server)).toBeUndefined()

    // The administrator signs in with the passkey alone and lands on the connection picker.
    await page.goto(server.baseURL + '/')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  } finally {
    await server.stop()
  }
})

test('SCN-064 repeated wrong tokens are throttled', async ({ page }) => {
  const fresh = await startServer()
  try {
    await page.goto(fresh.baseURL + '/setup')
    const label = page.getByLabel('Setup token')
    for (let i = 0; i < 7; i += 1) {
      await label.fill(`wrong-token-number-${i}-xxxxx`)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
    }
    // The right token straight after the failures is not accepted (delayed): still on step 1.
    await label.fill(SETUP_TOKEN)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(h1(page)).toHaveText('Welcome to DBLoom')
  } finally {
    await fresh.stop()
  }
})

test('SCN-065 mode mismatch: an account-mode start on a direct-mode store is refused naming both modes', async () => {
  const direct = await startServer({
    DBLOOM_LOGIN_MODE: 'direct',
    DBLOOM_AUTO_SETUP: 'direct',
    DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
  })
  try {
    expect((await fetch(direct.baseURL + '/setup')).status).toBe(404)
    await expect(direct.restart({ DBLOOM_LOGIN_MODE: 'account' })).rejects.toThrow(/direct/i)
    expect(direct.log()).toMatch(/account/i)
  } finally {
    await direct.stop()
  }
})

test('SCN-065 stateless start (DBLOOM_STORE=none): direct login, /setup is 404', async ({
  page,
}) => {
  const stateless = await startServer({
    DBLOOM_STORE: 'none',
    DBLOOM_LOGIN_MODE: 'direct',
    DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
  })
  try {
    await page.goto(stateless.baseURL + '/')
    await expect(h1(page)).toHaveText('Sign in to a database server')
    expect((await page.request.get(stateless.baseURL + '/setup')).status()).toBe(404)
  } finally {
    await stateless.stop()
  }
})

test('SCN-065 DBLOOM_AUTO_SETUP=direct on a fresh store: no /setup page, direct login', async ({
  page,
}) => {
  const auto = await startServer({
    DBLOOM_LOGIN_MODE: 'direct',
    DBLOOM_AUTO_SETUP: 'direct',
    DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
  })
  try {
    await page.goto(auto.baseURL + '/')
    await expect(h1(page)).toHaveText('Sign in to a database server')
    expect((await page.request.get(auto.baseURL + '/setup')).status()).toBe(404)
    expect(count(auto, 'users')).toBe(0)
  } finally {
    await auto.stop()
  }
})

test('SCN-065 direct mode through the wizard: four steps, no administrator', async ({ page }) => {
  // Without DBLOOM_LOGIN_MODE the mode is chosen in the wizard.
  const wiz = await startServer({ DBLOOM_LOGIN_MODE: '', DBLOOM_DIRECT_FREE_FORM_ACK: 'true' })
  try {
    await page.goto(wiz.baseURL + '/setup')
    await page.getByLabel('Setup token').fill(SETUP_TOKEN)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByLabel(/Direct mode/).check()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Step 3 of 4')).toBeVisible()
    const ack = page.getByLabel('I understand and want to continue from this address.')
    if (await ack.isVisible().catch(() => false)) await ack.check()
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page.getByText('Step 4 of 4')).toBeVisible()
    await expect(h1(page)).toHaveText('Setup complete')
    await page.goto(wiz.baseURL + '/')
    await expect(h1(page)).toHaveText('Sign in to a database server')
  } finally {
    await wiz.stop()
  }
})
