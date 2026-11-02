import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  MYSQL,
  createDbUser,
  addAuthenticator,
  dialog,
  h1,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  type Account,
  type DbUser,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-075 preferences follow the user (account mode: owner u:<id>; direct mode: the target owner key). */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let ana: Account
let db: DbUser

test.beforeAll(async ({ browser }) => {
  server = await startServer()
  db = await createDbUser(MYSQL)
  const page = await browser.newPage()
  ana = await runSetupWizard(page, server, { username: 'ana' })
  await page.close()
})
test.afterAll(async () => {
  await server?.stop()
  await db?.drop().catch(() => undefined)
})

/** The per-server preferences (hidden databases) appear once a connection is open. */
async function connect(page: Page) {
  await page.getByRole('tab', { name: 'Type credentials' }).click()
  await page.getByLabel('Host').fill(db.host)
  await page.getByLabel('Port').fill(String(db.port))
  await page.getByLabel('Database user').fill(db.user)
  await page.getByLabel('Database password').fill(db.password)
  await page.getByLabel('Connection security').selectOption({ label: 'Not encrypted' })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: db.database, exact: true })).toBeVisible()
}

const saved = (page: Page) => page.getByText('Saved', { exact: true }).last()

test('SCN-075 set theme, navigation width and hidden databases; another browser sees them; the factor survives a preference save', async ({
  page,
  browser,
}) => {
  await addAuthenticator(page, { uv: true })
  await signInWithRecovery(page, server, ana)
  await connect(page)
  await page.goto(server.baseURL + '/account/preferences')
  await expect(h1(page)).toHaveText('Preferences')
  await page.getByLabel('Theme').selectOption('dark')
  await expect(saved(page)).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const width = page.getByLabel('Navigation width (px)')
  await width.fill('100')
  await width.press('Enter')
  await expect(page.getByText('That number is outside the allowed range.')).toBeVisible()
  await width.fill('300')
  await width.press('Enter')
  await expect(saved(page)).toBeVisible()
  await page.getByLabel('Hidden databases').fill('mysql, sys, mysql')
  await page.getByLabel('Hidden databases').blur()
  await expect(saved(page)).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Hidden databases')).toHaveValue('mysql, sys')

  // A passkey is enrolled, then one more preference is saved: the factor is still there (FR-UPD-003).
  await page.goto(server.baseURL + '/account')
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await dialog(page, 'Add a passkey').getByRole('button', { name: 'Add passkey' }).click()
  await expect(page.getByText('Passkey added.')).toBeVisible()
  await page.goto(server.baseURL + '/account/preferences')
  await page.getByLabel('Open the app after sign-in').click()
  await expect(saved(page)).toBeVisible()
  await page.goto(server.baseURL + '/account')
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText('An authenticator app is set up.')).toBeVisible()

  // Another browser: dark theme, width and hidden databases come back with the user.
  const other = await (await browser.newContext()).newPage()
  await signInWithRecovery(other, server, ana)
  await connect(other)
  await other.goto(server.baseURL + '/account/preferences')
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(other.getByLabel('Theme')).toHaveValue('dark')
  await expect(other.getByLabel('Navigation width (px)')).toHaveValue('300')
  await expect(other.getByLabel('Hidden databases')).toHaveValue('mysql, sys')
  await other.context().close()
})

test('SCN-075 export holds no secret and no factor; an import with an invalid entry writes nothing; merge keeps keys not in the file', async ({
  page,
}) => {
  await signInWithRecovery(page, server, ana)
  await connect(page)
  await page.goto(server.baseURL + '/account/preferences')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export preferences' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('dbloom-preferences.json')
  const text = await readFile((await download.path())!, 'utf8')
  const exported = JSON.parse(text) as { dbloomPreferences: number; user: Record<string, unknown> }
  expect(exported.dbloomPreferences).toBe(1)
  expect(exported.user.theme).toBe('dark')
  expect(text).not.toMatch(/totp|passkey|recovery|password|secret|credential/i)

  const bad = {
    dbloomPreferences: 1,
    exportedAt: '2026-11-02T00:00:00Z',
    user: { theme: 'light', bogus: 1 },
    targets: {},
  }
  await page
    .getByLabel('Preferences file')
    .setInputFiles({
      name: 'p.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(bad)),
    })
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const result = page.getByRole('region', { name: 'Import result' })
  await expect(result).toContainText('Nothing was saved.')
  await expect(result).toContainText('bogus')
  await expect(page.getByLabel('Theme')).toHaveValue('dark')

  // Merge of the valid entries: the theme changes, the width and the hidden databases stay.
  await result.getByRole('button', { name: 'Import the valid entries only' }).click()
  await expect(result).toContainText('1 saved')
  await expect(page.getByLabel('Theme')).toHaveValue('light')
  await page.reload()
  await expect(page.getByLabel('Navigation width (px)')).toHaveValue('300')
  await expect(page.getByLabel('Hidden databases')).toHaveValue('mysql, sys')

  await page.getByRole('button', { name: 'Reset all' }).click()
  await dialog(page, 'Reset all preferences?').getByRole('button', { name: 'Reset all' }).click()
  await expect(page.getByText('Preferences reset.')).toBeVisible()
  await expect(page.getByLabel('Theme')).toHaveValue('system')
})

test('SCN-075 direct mode stores the same pages under the target owner key', async ({ page }) => {
  const direct = await startServer({
    DBLOOM_LOGIN_MODE: 'direct',
    DBLOOM_AUTO_SETUP: 'direct',
    DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
  })
  try {
    const signIn = async () => {
      await page.goto(direct.baseURL + '/')
      await page.locator('#server').fill(`${MYSQL.host}:${MYSQL.port}`)
      await page.getByLabel('User name').fill(MYSQL.user)
      await page.getByLabel('Password', { exact: true }).fill(MYSQL.password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.getByText(`${MYSQL.host}:${MYSQL.port}`).first()).toBeVisible()
    }
    await signIn()
    await page.goto(direct.baseURL + '/account/preferences')
    await expect(h1(page)).toHaveText('Preferences')
    await page.getByLabel('Theme').selectOption('dark')
    await expect(saved(page)).toBeVisible()
    await page.goto(direct.baseURL + '/')
    await page.getByRole('button', { name: 'Log out' }).click()
    await signIn()
    await page.goto(direct.baseURL + '/account/preferences')
    await expect(page.getByLabel('Theme')).toHaveValue('dark')
  } finally {
    await direct.stop()
  }
})
