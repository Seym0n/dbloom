import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, openMock, signInAs } from './fixtures/auth-ui'

/**
 * Connection picker, typed credentials, vault and saved profiles against the mock layer (FR-AUT-018 to 022).
 * The shell behind an opened connection talks to the real server functions, which the mock does not serve; these specs
 * stop at what the account layer owns (picker, header id, switcher).
 */

const VAULT_PASSPHRASE = 'a long vault passphrase'
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function flags(page: Page, value: string) {
  await page.addInitScript((v) => window.sessionStorage.setItem('dbloom.authMock.flags', v), value)
}

async function toPicker(page: Page) {
  await openMock(page, 'login')
  await signInAs(page, 'alice')
  await expect(h1(page)).toHaveText('Connect to a database')
}

async function typed(page: Page, over: { host?: string; user?: string; password?: string } = {}) {
  await page.getByRole('tab', { name: 'Type credentials' }).click()
  await page.getByLabel('Host').fill(over.host ?? 'db.example.org')
  await page.getByLabel('Database user').fill(over.user ?? 'app')
  await page.getByLabel('Database password').fill(over.password ?? 'secret')
}

async function createVault(page: Page) {
  await page.getByRole('button', { name: 'Create vault' }).click()
  const d = dialog(page, 'Create the vault')
  await d.getByLabel('Passphrase', { exact: true }).fill(VAULT_PASSPHRASE)
  await d.getByLabel('Passphrase again').fill(VAULT_PASSPHRASE)
  await d.getByRole('button', { name: 'Create vault' }).click()
  const keyDialog = dialog(page, 'Your recovery key')
  await expect(keyDialog.getByRole('list', { name: 'Vault recovery key' })).toContainText('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-1001')
  await keyDialog.getByLabel('I saved it').check()
  await keyDialog.getByRole('button', { name: 'Done' }).click()
}

test.describe('typed credentials', () => {
  test('opens a connection and remembers it for the shell', async ({ page }) => {
    await toPicker(page)
    await typed(page)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('x-dbloom-connection'))).toBe('mock-conn-1')
    await expect(page.getByText('db.example.org:3306').first()).toBeVisible()
    await expect(page.getByRole('group', { name: 'Database connections' })).toBeVisible()
  })

  test('shows what the form is missing', async ({ page }) => {
    await toPicker(page)
    await page.getByRole('tab', { name: 'Type credentials' }).click()
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByText('This is required.')).toHaveCount(2)
    await page.getByLabel('Host').fill('db:3307')
    await page.getByLabel('Host').blur()
    await expect(page.getByLabel('Port')).toHaveValue('3307')
  })

  test('an empty password is refused with its own message', async ({ page }) => {
    await toPicker(page)
    await typed(page, { password: '' })
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Signing in with an empty database password is not allowed on this server.')
  })

  test('root is refused when the server denies it', async ({ page }) => {
    await flags(page, 'deny-root')
    await toPicker(page)
    await typed(page, { user: 'root' })
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Signing in as the database user root is not allowed on this server.')
  })

  test('any other failure is one generic message', async ({ page }) => {
    await toPicker(page)
    await typed(page, { host: 'bad.example.org' })
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Could not connect. Check the host, port, user name and password.')
  })
})

test.describe('vault and profiles', () => {
  test.beforeEach(async ({ page }) => {
    await toPicker(page)
    await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
    await expect(h1(page)).toHaveText('Profiles and vault')
  })

  test('create: the recovery key is shown once and cannot be skipped', async ({ page }) => {
    await expect(page.getByTestId('vault-status')).toHaveText('No vault yet.')
    await page.getByRole('button', { name: 'Create vault' }).click()
    const d = dialog(page, 'Create the vault')
    await d.getByLabel('Passphrase', { exact: true }).fill('too short')
    await d.getByLabel('Passphrase again').fill('too short')
    await d.getByRole('button', { name: 'Create vault' }).click()
    await expect(d.getByRole('alert')).toHaveText('The password is too short.')
    await d.getByLabel('Passphrase', { exact: true }).fill(VAULT_PASSPHRASE)
    await d.getByLabel('Passphrase again').fill('something else entirely')
    await d.getByRole('button', { name: 'Create vault' }).click()
    await expect(d.getByText('The two passphrases are not the same.')).toBeVisible()
    await d.getByLabel('Passphrase again').fill(VAULT_PASSPHRASE)
    await d.getByRole('button', { name: 'Create vault' }).click()
    const keyDialog = dialog(page, 'Your recovery key')
    await expect(keyDialog.getByRole('button', { name: 'Done' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(keyDialog).toBeVisible()
    await keyDialog.getByLabel('I saved it').check()
    await keyDialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('vault-status')).toContainText('The vault is unlocked.')
    await expect(page.getByTestId('vault-status')).toContainText('locks itself in')
  })

  test('lock, unlock with a wrong then the right passphrase, change it, use the recovery key', async ({ page }) => {
    await createVault(page)
    await page.getByRole('button', { name: 'Lock now' }).click()
    await expect(page.getByTestId('vault-status')).toHaveText('The vault is locked.')

    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    const unlock = dialog(page, 'Unlock the vault')
    await unlock.getByLabel('Passphrase').fill('not the passphrase')
    await unlock.getByRole('button', { name: 'Unlock' }).click()
    await expect(unlock.getByRole('alert')).toHaveText('That passphrase is not right.')
    await unlock.getByLabel('Passphrase').fill(VAULT_PASSPHRASE)
    await unlock.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByTestId('vault-status')).toContainText('The vault is unlocked.')

    await page.getByRole('button', { name: 'Change passphrase' }).click()
    const change = dialog(page, 'Change the passphrase')
    await change.getByLabel('Current passphrase').fill(VAULT_PASSPHRASE)
    await change.getByLabel('New passphrase').fill('another long passphrase')
    await change.getByLabel('Passphrase again').fill('another long passphrase')
    await change.getByRole('button', { name: 'Change passphrase' }).click()
    await expect(change).toBeHidden()

    await page.getByRole('button', { name: 'Lock now' }).click()
    await page.getByRole('button', { name: 'Use recovery key' }).click()
    const recover = dialog(page, 'Use the recovery key')
    await recover.getByLabel('Recovery key').fill('abcd-efgh-jkmn-pqrs-tvwx-yz01-2345-1001')
    await recover.getByLabel('New passphrase').fill('a third long passphrase')
    await recover.getByLabel('Passphrase again').fill('a third long passphrase')
    await recover.getByRole('button', { name: 'Reset passphrase' }).click()
    const key = dialog(page, 'Your recovery key')
    await expect(key.getByRole('list', { name: 'Vault recovery key' })).toContainText('2345-1002')
    await key.getByLabel('I saved it').check()
    await key.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('vault-status')).toContainText('The vault is unlocked.')
  })

  test('regenerate and rotate need a step-up and show the new key once', async ({ page }) => {
    await createVault(page)
    await page.getByRole('button', { name: 'New recovery key' }).click()
    await dialog(page, 'Create a new recovery key').getByRole('button', { name: 'Create new key' }).click()
    const stepUp = dialog(page, 'Confirm it is you')
    await stepUp.getByLabel('Your password').fill(PASSWORD)
    await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
    const key = dialog(page, 'Your recovery key')
    await expect(key.getByRole('list', { name: 'Vault recovery key' })).toContainText('2345-1002')
    await key.getByLabel('I saved it').check()
    await key.getByRole('button', { name: 'Done' }).click()

    await page.getByRole('button', { name: 'Rotate vault key' }).click()
    const rotate = dialog(page, 'Rotate the vault key')
    await rotate.getByLabel('Passphrase').fill(VAULT_PASSPHRASE)
    await rotate.getByRole('button', { name: 'Rotate key' }).click()
    const key2 = dialog(page, 'Your recovery key')
    await expect(key2.getByRole('list', { name: 'Vault recovery key' })).toContainText('2345-1003')
  })

  test('profiles: failed test, save anyway, edit, connect, delete', async ({ page }) => {
    await expect(page.getByText('Create a password vault to save profiles with their passwords.')).toBeVisible()
    await createVault(page)

    await page.getByRole('button', { name: 'New profile' }).click()
    const form = dialog(page, 'New profile')
    await form.getByLabel('Profile name').fill('Broken')
    await form.getByLabel('Host').fill('bad.example.org')
    await form.getByLabel('Database user').fill('app')
    await form.getByLabel('Database password').fill('secret')
    await form.getByRole('button', { name: 'Test connection' }).click()
    await expect(form.getByRole('status')).toHaveText('The test connection failed: Could not connect to the server.')
    await form.getByRole('button', { name: 'Save profile' }).click()
    await expect(form.getByRole('alert')).toHaveText('The test connection failed: Could not connect to the server.')
    await form.getByRole('button', { name: 'Save anyway' }).click()
    await expect(page.getByText('Profile saved without a working test.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Saved profiles' })).toContainText('Broken')

    await page.getByRole('button', { name: 'New profile' }).click()
    const good = dialog(page, 'New profile')
    await good.getByLabel('Profile name').fill('Prod')
    await good.getByLabel('Host').fill('db.example.org')
    await good.getByLabel('Database user').fill('app')
    await good.getByLabel('Database password').fill('secret')
    await good.getByText('Certificates').click()
    await good.getByLabel('Client certificate (PEM)').fill('-----BEGIN CERTIFICATE-----')
    await good.getByRole('button', { name: 'Save profile' }).click()
    await expect(good.getByText('Give both the client certificate and its key.')).toBeVisible()
    await good.getByLabel('Client private key (PEM)').fill('-----BEGIN PRIVATE KEY-----')
    await good.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Profile saved.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Saved profiles' })).toContainText('client certificate')

    // A locked vault still lets the options be edited, but hides user and password.
    await page.getByRole('button', { name: 'Lock now' }).click()
    await page.getByRole('button', { name: 'Edit Prod' }).click()
    const edit = dialog(page, 'Edit profile')
    await expect(edit.getByText('Database user and password are hidden while the vault is locked.')).toBeVisible()
    await edit.getByLabel('Profile name').fill('Production')
    await edit.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByRole('list', { name: 'Saved profiles' })).toContainText('Production')

    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    const unlock = dialog(page, 'Unlock the vault')
    await unlock.getByLabel('Passphrase').fill(VAULT_PASSPHRASE)
    await unlock.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByRole('list', { name: 'Saved profiles' })).toContainText('app@db.example.org:3306')

    await page.getByRole('button', { name: 'Delete Broken' }).click()
    await dialog(page, 'Delete profile Broken?').getByRole('button', { name: 'Delete profile' }).click()
    await expect(page.getByText('Profile deleted.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Saved profiles' })).not.toContainText('Broken')

    await page.getByRole('button', { name: 'Back to connecting' }).click()
    await page.getByRole('button', { name: 'Connect with Production' }).click()
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('x-dbloom-connection'))).toMatch(/^mock-conn-\d+$/)
  })

  test('profiles wait for the vault while it is locked', async ({ page }) => {
    await createVault(page)
    await page.getByRole('button', { name: 'Lock now' }).click()
    await page.getByRole('button', { name: 'Back to connecting' }).click()
    await expect(page.getByText('The vault is locked. Unlock it to connect with a profile')).toBeVisible()
  })
})

test('the vault locks itself and the screen says so', async ({ page }) => {
  await flags(page, 'short-lock')
  await toPicker(page)
  await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
  await createVault(page)
  await expect(page.getByTestId('vault-status')).toContainText('The vault is unlocked.')
  await expect(page.getByTestId('vault-status')).toHaveText('The vault is locked.', { timeout: 10_000 })
})

test('personal profiles switched off: typed credentials only', async ({ page }) => {
  await flags(page, 'vault-off')
  await toPicker(page)
  await expect(page.getByText('Saved profiles are switched off on this server.')).toBeVisible()
})

test.describe('switching in the shell', () => {
  // The shell's own server functions are not mocked; failing them keeps its session-ended dialog out of the way.
  test.beforeEach(async ({ page }) => {
    await page.route(/_serverFn/, (route) => route.abort())
  })

  test('several connections, switch, close', async ({ page }) => {
    await toPicker(page)
    await typed(page, { host: 'one.example.org' })
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Database connections' })).toBeVisible()
    await page.getByRole('button', { name: 'Add connection' }).click()
    const add = dialog(page, 'Connections')
    await add.getByRole('tab', { name: 'Type credentials' }).click()
    await add.getByLabel('Host').fill('two.example.org')
    await add.getByLabel('Database user').fill('app')
    await add.getByLabel('Database password').fill('secret')
    await add.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('x-dbloom-connection'))).toBe('mock-conn-2')
    const select = page.getByLabel('Connection', { exact: true })
    await expect(select).toHaveValue('mock-conn-2')
    await select.selectOption('mock-conn-1')
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('x-dbloom-connection'))).toBe('mock-conn-1')
    await page.getByRole('button', { name: 'Close this one' }).click()
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('x-dbloom-connection'))).toBe('mock-conn-2')
    await page.getByRole('button', { name: 'Close this one' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })

  test('direct mode has no switcher', async ({ page }) => {
    await openMock(page, 'direct')
    await expect(page.getByRole('group', { name: 'Database connections' })).toHaveCount(0)
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })

    test('picker, typed form, vault, profile form', async ({ page }) => {
      await toPicker(page)
      await clean(page)
      await page.getByRole('tab', { name: 'Type credentials' }).click()
      await clean(page)
      await page.getByRole('tab', { name: 'Saved profiles' }).click()
      await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
      await clean(page)
      await createVault(page)
      await clean(page)
      await page.getByRole('button', { name: 'New profile' }).click()
      await expect(dialog(page, 'New profile')).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('no horizontal scroll on the picker, the vault page and the profile form', async ({ page }) => {
    await toPicker(page)
    await noOverflow(page)
    await page.getByRole('tab', { name: 'Type credentials' }).click()
    await page.getByText('More options').click()
    await noOverflow(page)
    await page.getByRole('tab', { name: 'Saved profiles' }).click()
    await page.getByRole('button', { name: 'Manage profiles and vault' }).click()
    await createVault(page)
    await noOverflow(page)
    await page.getByRole('button', { name: 'New profile' }).click()
    await expect(dialog(page, 'New profile')).toBeVisible()
    await noOverflow(page)
    const box = await dialog(page, 'New profile').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  })
})
