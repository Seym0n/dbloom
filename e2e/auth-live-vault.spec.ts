import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  MYSQL,
  SECRET_KEY,
  createDbUser,
  dialog,
  fillSignIn,
  h1,
  openSignIn,
  readRecoveryCodes,
  readTotpSecret,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  takeTotp,
  type Account,
  type DbUser,
  type LiveServer,
} from './fixtures/auth-live'

/** SCN-073 vault and saved profiles, plus the vault half of SCN-071 (a recovery link leaves the vault alone). */

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const PASS1 = 'a long vault passphrase'
const PASS2 = 'another long passphrase'
const PASS3 = 'a third long passphrase'

let server: LiveServer
let admin: Account
let db: DbUser
let recoveryKey = ''
let recovered: Account

test.beforeAll(async ({ browser }) => {
  server = await startServer({ DBLOOM_VAULT_AUTOLOCK_MINUTES: '1' })
  db = await createDbUser(MYSQL)
  const page = await browser.newPage()
  admin = await runSetupWizard(page, server, { username: 'ana' })
  await page.close()
})
test.afterAll(async () => {
  await server?.stop()
  await db?.drop().catch(() => undefined)
})

const status = (page: Page) => page.getByTestId('vault-status')

async function toVaultPage(page: Page) {
  await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
  await expect(h1(page)).toHaveText('Profiles and vault')
}

async function readKey(page: Page): Promise<string> {
  const keyDialog = dialog(page, 'Your recovery key')
  const text = (
    await keyDialog.getByRole('list', { name: 'Vault recovery key' }).innerText()
  ).replace(/\s+/g, '')
  await keyDialog.getByLabel('I saved it').check()
  await keyDialog.getByRole('button', { name: 'Done' }).click()
  return text
}

async function unlock(page: Page, passphrase: string) {
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  const d = dialog(page, 'Unlock the vault')
  await d.getByLabel('Passphrase').fill(passphrase)
  await d.getByRole('button', { name: 'Unlock' }).click()
}

test('SCN-073 create the vault (short passphrase refused), save a profile with a wrong password anyway, then correct it', async ({
  page,
}) => {
  await signInWithRecovery(page, server, admin)
  await toVaultPage(page)
  await expect(status(page)).toHaveText('No vault yet.')
  await page.getByRole('button', { name: 'Create vault' }).click()
  const d = dialog(page, 'Create the vault')
  await d.getByLabel('Passphrase', { exact: true }).fill('too short')
  await d.getByLabel('Passphrase again').fill('too short')
  await d.getByRole('button', { name: 'Create vault' }).click()
  await expect(d.getByRole('alert')).toBeVisible()
  await d.getByLabel('Passphrase', { exact: true }).fill(PASS1)
  await d.getByLabel('Passphrase again').fill(PASS1)
  await d.getByRole('button', { name: 'Create vault' }).click()
  recoveryKey = await readKey(page)
  expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
  await expect(status(page)).toContainText('The vault is unlocked.')

  await page.getByRole('button', { name: 'New profile' }).click()
  const form = dialog(page, 'New profile')
  await form.getByLabel('Profile name').fill('MySQL')
  await form.getByLabel('Host').fill(db.host)
  await form.getByLabel('Port').fill(String(db.port))
  await form.getByLabel('Database user').fill(db.user)
  await form.getByLabel('Database password').fill('not the password')
  await form.getByLabel('Connection security').selectOption({ label: 'Not encrypted' })
  await form.getByRole('button', { name: 'Test connection' }).click()
  await expect(form.getByRole('status')).toContainText('The test connection failed')
  await form.getByRole('button', { name: 'Save profile' }).click()
  await expect(form.getByRole('alert')).toContainText('The test connection failed')
  await form.getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByText('Profile saved without a working test.')).toBeVisible()

  // Correct the password: the editor shows the user name and no password.
  await page.getByRole('button', { name: 'Edit MySQL' }).click()
  const edit = dialog(page, 'Edit profile')
  await expect(edit.getByLabel('Database user')).toHaveValue(db.user)
  await expect(edit.getByLabel('Database password')).toHaveValue('')
  await edit.getByLabel('Database password').fill(db.password)
  await edit.getByRole('button', { name: 'Test connection' }).click()
  await expect(edit.getByRole('status')).not.toContainText('failed')
  await edit.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Profile saved.')).toBeVisible()

  // The store holds none of the profile's secrets in the clear.
  for (const f of readdirSync(server.dataDir).filter((n) => n.startsWith('dbloom.db'))) {
    const bytes = readFileSync(join(server.dataDir, f))
    for (const secret of [
      db.user,
      db.password,
      PASS1,
      recoveryKey,
      recoveryKey.replaceAll('-', ''),
      'not the password',
    ])
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
  }
  const log = server.log()
  for (const secret of [db.password, PASS1, recoveryKey]) expect(log).not.toContain(secret)
})

test('SCN-073 sign in again: the picker connects with the profile after the unlock prompt; a wrong passphrase is refused', async ({
  page,
}) => {
  await signInWithRecovery(page, server, admin)
  await page.getByRole('tab', { name: 'Saved profiles' }).click()
  await expect(page.getByText('MySQL').first()).toBeVisible()
  await expect(page.getByText(/vault is locked/i).first()).toBeVisible()
  await toVaultPage(page)
  await expect(status(page)).toHaveText('The vault is locked.')
  await unlock(page, 'not the passphrase')
  await expect(dialog(page, 'Unlock the vault').getByRole('alert')).toHaveText(
    'That passphrase is not right.',
  )
  await dialog(page, 'Unlock the vault').getByLabel('Passphrase').fill(PASS1)
  await dialog(page, 'Unlock the vault').getByRole('button', { name: 'Unlock' }).click()
  await expect(status(page)).toContainText('The vault is unlocked.')
  await page.getByRole('button', { name: 'Back to connecting' }).click()
  await page.getByRole('button', { name: 'Connect with MySQL' }).click()
  await expect(page.getByRole('button', { name: db.database, exact: true })).toBeVisible()
})

test('SCN-073 the vault locks itself after the idle time and says so', async ({ page }) => {
  await signInWithRecovery(page, server, admin)
  await toVaultPage(page)
  await unlock(page, PASS1)
  await expect(status(page)).toContainText('The vault is unlocked.')
  // Auto-lock is one minute here (DBLOOM_VAULT_AUTOLOCK_MINUTES): the page notices without a reload.
  await expect(status(page)).toHaveText('The vault is locked.', { timeout: 100_000 })
})

test('SCN-073 change the passphrase, then use the recovery key: a new passphrase and a new recovery key, the old key stops working', async ({
  page,
}) => {
  await signInWithRecovery(page, server, admin)
  await toVaultPage(page)
  await unlock(page, PASS1)
  await page.getByRole('button', { name: 'Change passphrase' }).click()
  const change = dialog(page, 'Change the passphrase')
  await change.getByLabel('Current passphrase').fill(PASS1)
  await change.getByLabel('New passphrase').fill(PASS2)
  await change.getByLabel('Passphrase again').fill(PASS2)
  await change.getByRole('button', { name: 'Change passphrase' }).click()
  await expect(change).toBeHidden()
  await page.getByRole('button', { name: 'Lock now' }).click()
  await unlock(page, PASS1)
  await expect(dialog(page, 'Unlock the vault').getByRole('alert')).toBeVisible()
  await dialog(page, 'Unlock the vault').getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Use recovery key' }).click()
  const recover = dialog(page, 'Use the recovery key')
  await recover.getByLabel('Recovery key').fill(recoveryKey.toLowerCase())
  await recover.getByLabel('New passphrase').fill(PASS3)
  await recover.getByLabel('Passphrase again').fill(PASS3)
  await recover.getByRole('button', { name: 'Reset passphrase' }).click()
  const fresh = await readKey(page)
  expect(fresh).not.toBe(recoveryKey)
  await expect(status(page)).toContainText('The vault is unlocked.')

  // The old recovery key no longer works.
  await page.getByRole('button', { name: 'Lock now' }).click()
  await page.getByRole('button', { name: 'Use recovery key' }).click()
  const again = dialog(page, 'Use the recovery key')
  await again.getByLabel('Recovery key').fill(recoveryKey)
  await again.getByLabel('New passphrase').fill('a fourth long passphrase')
  await again.getByLabel('Passphrase again').fill('a fourth long passphrase')
  await again.getByRole('button', { name: 'Reset passphrase' }).click()
  await expect(again.getByRole('alert')).toBeVisible()
  recoveryKey = fresh
})

test('SCN-071/073 a recovery link replaces the login factors and leaves the vault and the profile untouched', async ({
  page,
  browser,
}) => {
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
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  await p.goto(link)
  const password = 'a recovered password 2026'
  await p.getByLabel('New password', { exact: true }).fill(password)
  await p.getByLabel('New password again').fill(password)
  await p.getByRole('button', { name: 'Set password' }).click()
  await expect(h1(p)).toHaveText('Sign-in restored')
  await ctx.close()

  // An administrator needs a second factor: the sign-in leads to enrolment first, then to the picker.
  await openSignIn(page, server)
  await fillSignIn(page, admin.username, password)
  await expect(h1(page)).toHaveText('Add a second factor')
  recovered = {
    username: admin.username,
    password,
    totpSecret: await readTotpSecret(page),
    lastStep: 0,
  }
  await page.getByLabel('Code from the app').fill(await takeTotp(recovered))
  await page.getByRole('button', { name: 'Verify and add' }).click()
  await expect(h1(page)).toHaveText('Save your recovery codes')
  await readRecoveryCodes(page)
  await page.getByLabel('I saved them').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')

  // The vault opens with the passphrase set before the recovery, and the profile still connects.
  await toVaultPage(page)
  await expect(status(page)).toHaveText('The vault is locked.')
  await unlock(page, PASS3)
  await expect(status(page)).toContainText('The vault is unlocked.')
  await page.getByRole('button', { name: 'Back to connecting' }).click()
  await page.getByRole('button', { name: 'Connect with MySQL' }).click()
  await expect(page.getByRole('button', { name: db.database, exact: true })).toBeVisible()
})
