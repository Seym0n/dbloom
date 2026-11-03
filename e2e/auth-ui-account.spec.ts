import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { TOTP, openMock, signInAs } from './fixtures/auth-ui'

/** Account security and preferences against the mock layer (SPEC/26 5.10; FR-AUT-004, 009 to 013, 017, 024, 025). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })

async function signedIn(page: Page, username: 'alice' | 'bob', path = '/account') {
  await openMock(page, 'login')
  await signInAs(page, username)
  if (username === 'bob') {
    await page.getByLabel('Code from your authenticator app').fill(TOTP)
    await page.getByRole('button', { name: 'Continue' }).click()
  }
  await expect(h1(page)).toHaveText(/database/i)
  await page.goto(path)
}

async function setFlags(page: Page, flags: string) {
  await page.evaluate((value) => window.sessionStorage.setItem('dbloom.authMock.flags', value), flags)
}

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test.describe('access', () => {
  test('without a session the page sends you to sign-in', async ({ page }) => {
    await openMock(page, 'login', '/account')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
  })

  test('back link returns to the app, the two pages are linked', async ({ page }) => {
    await signedIn(page, 'alice')
    await expect(h1(page)).toHaveText('Account security')
    await page.getByRole('link', { name: 'Preferences' }).click()
    await expect(h1(page)).toHaveText('Preferences')
    await expect(page.getByRole('link', { name: 'Preferences' })).toHaveAttribute('aria-current', 'page')
    await page.getByRole('link', { name: 'Back to DBLoom' }).click()
    await expect(h1(page)).toHaveText(/database/i)
  })
})

test.describe('security', () => {
  test('set up the authenticator app: codes shown once, then step-up before removal', async ({ page }) => {
    await signedIn(page, 'alice')
    await expect(page.getByText('No passkeys yet.')).toBeVisible()
    await expect(page.getByText('No authenticator app yet.')).toBeVisible()

    await page.getByRole('button', { name: 'Set up' }).click()
    const enrol = dialog(page, 'Set up an authenticator app')
    await expect(enrol.getByTestId('totp-secret')).toBeVisible()
    await enrol.getByLabel('Code from the app').fill(TOTP)
    await enrol.getByRole('button', { name: 'Verify and add' }).click()

    const codes = dialog(page, 'Recovery codes')
    await expect(codes.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10)
    await expect(codes.getByRole('button', { name: 'Done' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(codes).toBeVisible()
    await codes.getByLabel('I saved them').check()
    await codes.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText('Recovery codes left: 10')).toBeVisible()
    await expect(page.getByText('An authenticator app is set up.')).toBeVisible()

    // The only factor of an administrator: the step-up comes first, then the server refuses.
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await dialog(page, 'Remove the authenticator app?').getByRole('button', { name: 'Remove' }).click()
    const stepUp = dialog(page, 'Confirm it is you')
    await stepUp.getByLabel('Code from your authenticator app').fill('000000')
    await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(stepUp.getByRole('alert')).toHaveText('That code or passkey was not accepted. Try again.')
    await stepUp.getByLabel('Code from your authenticator app').fill(TOTP)
    await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(dialog(page, 'Remove the authenticator app?').getByRole('alert')).toHaveText('Add a second factor to continue.')
    await dialog(page, 'Remove the authenticator app?').getByRole('button', { name: 'Cancel' }).click()

    // With a passkey added the removal goes through, and the step-up window means no second prompt.
    await page.getByRole('button', { name: 'Add passkey' }).click()
    await dialog(page, 'Add a passkey').getByRole('button', { name: 'Add passkey' }).click()
    await expect(page.getByText('Passkey added.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Passkeys' }).getByText('Passkey 1')).toBeVisible()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await dialog(page, 'Remove the authenticator app?').getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('Authenticator app removed.')).toBeVisible()
    await expect(page.getByText('No authenticator app yet.')).toBeVisible()
  })

  test('passkeys: rename, remove with a passkey step-up, recovery codes, switch two-factor off', async ({ page }) => {
    await signedIn(page, 'bob')
    const list = page.getByRole('list', { name: 'Passkeys' })
    await expect(list.getByText('Passkey 1')).toBeVisible()
    await expect(page.getByText('Only a few codes are left')).toBeVisible()

    await page.getByRole('button', { name: 'Rename passkey Passkey 1' }).click()
    await page.getByLabel('Passkey name').fill('Laptop')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Passkey renamed.')).toBeVisible()
    await expect(list.getByText('Laptop')).toBeVisible()

    await page.getByRole('button', { name: 'Make new codes' }).click()
    await dialog(page, 'Make new recovery codes?').getByRole('button', { name: 'Make new codes' }).click()
    const stepUp = dialog(page, 'Confirm it is you')
    await expect(stepUp.getByRole('tab', { name: 'Passkey' })).toHaveAttribute('aria-selected', 'true')
    await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
    const codes = dialog(page, 'Recovery codes')
    await expect(codes.getByRole('listitem')).toHaveCount(10)
    await codes.getByLabel('I saved them').check()
    await codes.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText('Recovery codes left: 10')).toBeVisible()
    await expect(page.getByText('Only a few codes are left')).toHaveCount(0)

    await page.getByRole('button', { name: 'Remove passkey Laptop' }).click()
    await dialog(page, 'Remove this passkey?').getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('Passkey removed.')).toBeVisible()
    await expect(page.getByText('No passkeys yet.')).toBeVisible()

    await page.getByRole('button', { name: 'Turn off', exact: true }).click()
    await dialog(page, 'Turn off two-factor sign-in').getByRole('button', { name: 'Turn off' }).click()
    await expect(page.getByText('Two-factor sign-in is off.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Turn off', exact: true })).toHaveCount(0)
  })

  test('the step-up dialog can be cancelled and the action stays undone', async ({ page }) => {
    await signedIn(page, 'bob')
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click()
    await dialog(page, 'Remove the authenticator app?').getByRole('button', { name: 'Remove' }).click()
    const stepUp = dialog(page, 'Confirm it is you')
    await expect(stepUp).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(stepUp).toBeHidden()
    await expect(dialog(page, 'Remove the authenticator app?').getByRole('alert')).toHaveText('Confirm it is you to continue.')
  })

  test('step-up by password when there is no factor', async ({ page }) => {
    await signedIn(page, 'alice')
    await setFlags(page, 'step-up-add')
    await page.getByRole('button', { name: 'Add passkey' }).click()
    await dialog(page, 'Add a passkey').getByRole('button', { name: 'Add passkey' }).click()
    const stepUp = dialog(page, 'Confirm it is you')
    await expect(stepUp.getByRole('tab')).toHaveCount(0)
    await stepUp.getByLabel('Your password').fill('wrong wrong wrong')
    await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(stepUp.getByRole('alert')).toHaveText('Sign-in failed. Check the user name and password.')
    await stepUp.getByLabel('Your password').fill('correct horse battery')
    await stepUp.getByRole('button', { name: 'Confirm and continue' }).click()
    // The first factor brings the recovery codes, shown once.
    await expect(dialog(page, 'Recovery codes')).toBeVisible()
  })

  test('change password from the page, then sessions and notices', async ({ page }) => {
    await signedIn(page, 'alice')
    await page.getByRole('button', { name: 'Change password' }).click()
    const change = dialog(page, 'Change password')
    await change.getByLabel('Current password').fill('correct horse battery')
    await change.getByLabel('New password', { exact: true }).fill('short')
    await change.getByLabel('New password again').fill('short')
    await change.getByRole('button', { name: 'Change password' }).click()
    await expect(change.getByRole('alert')).toHaveText('The password is too short.')
    await change.getByLabel('New password', { exact: true }).fill('a much longer new password')
    await change.getByLabel('New password again').fill('a much longer new password')
    await change.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Password changed.')).toBeVisible()

    await expect(page.getByRole('list', { name: 'Recent security events' }).getByRole('listitem')).toHaveCount(4) // two own plus the two administrator notices of the mock
    const sessions = page.getByRole('list', { name: 'Where you are signed in' })
    await expect(sessions.getByRole('listitem')).toHaveCount(2)
    await expect(sessions.getByText('This session')).toBeVisible()
    await page.getByRole('button', { name: 'Sign out the session of Safari on iOS at 198.51.100.24' }).click()
    await expect(page.getByText('Session signed out.')).toBeVisible()
    await expect(sessions.getByRole('listitem')).toHaveCount(1)
  })
})

test.describe('preferences', () => {
  test('saves as you go, keeps the value, rejects out-of-range input', async ({ page }) => {
    await signedIn(page, 'alice', '/account/preferences')
    await expect(h1(page)).toHaveText('Preferences')
    await expect(page.getByText('Settings for a server appear here once you are connected to it.')).toBeVisible()

    await page.getByLabel('Theme').selectOption('dark')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    const width = page.getByLabel('Navigation width (px)')
    await width.fill('100')
    await width.press('Enter')
    await expect(page.getByText('That number is outside the allowed range.')).toBeVisible()
    await width.fill('300')
    await width.press('Enter')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()

    await page.getByLabel('Hidden databases').fill('mysql, sys, mysql')
    await page.getByLabel('Hidden databases').blur()
    // Every field keeps its own status line, so the third save shows two "Saved"; look at this field's own.
    await expect(
      page.getByLabel('Hidden databases').locator('xpath=ancestor::*[.//p[@role="status"]][1]').getByRole('status'),
    ).toHaveText('Saved')

    await page.reload()
    await expect(page.getByLabel('Theme')).toHaveValue('dark')
    await expect(page.getByLabel('Navigation width (px)')).toHaveValue('300')
    await expect(page.getByLabel('Hidden databases')).toHaveValue('mysql, sys')
    await expect(page.getByText('Last saved')).toBeVisible()
  })

  test('a failed save says so and can be retried or discarded', async ({ page }) => {
    await signedIn(page, 'alice', '/account/preferences')
    await setFlags(page, 'prefs-fail')
    await page.getByLabel('Open the app after sign-in').click()
    await expect(page.getByText('Could not be saved. Your change was not stored.')).toBeVisible()
    await setFlags(page, '')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Open the app after sign-in')).not.toBeChecked()
  })

  test('stateless servers say that preferences are not kept', async ({ page }) => {
    await signedIn(page, 'alice', '/account/preferences')
    await setFlags(page, 'stateless')
    await page.reload()
    await expect(page.getByRole('note')).toHaveText('This server does not keep preferences. Changes last until you sign out.')
  })

  test('export, then reset with confirmation', async ({ page }) => {
    await signedIn(page, 'alice', '/account/preferences')
    await page.getByLabel('Theme').selectOption('light')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export preferences' }).click()])
    expect(download.suggestedFilename()).toBe('dbloom-preferences.json')
    const text = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8')
    expect(JSON.parse(text).user).toEqual({ theme: 'light' })

    await page.getByRole('button', { name: 'Reset all' }).click()
    const confirm = dialog(page, 'Reset all preferences?')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByLabel('Theme')).toHaveValue('light')
    await page.getByRole('button', { name: 'Reset all' }).click()
    await confirm.getByRole('button', { name: 'Reset all' }).click()
    await expect(page.getByText('Preferences reset.')).toBeVisible()
    await expect(page.getByLabel('Theme')).toHaveValue('system')
  })

  test('import lists the problems, writes nothing, then the valid entries only', async ({ page }) => {
    await signedIn(page, 'alice', '/account/preferences')
    const file = { dbloomPreferences: 1, exportedAt: '2026-11-02T00:00:00Z', user: { theme: 'dark', bogus: 1, navWidth: 10 }, targets: {} }
    await page.getByLabel('Preferences file').setInputFiles({ name: 'prefs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const result = page.getByRole('region', { name: 'Import result' })
    await expect(result).toContainText('Nothing was saved. 2 entries have problems.')
    await expect(result).toContainText('bogus: Not a known preference.')
    await expect(result).toContainText('navWidth: The value is not allowed.')
    await expect(page.getByLabel('Theme')).toHaveValue('system')

    await result.getByRole('button', { name: 'Import the valid entries only' }).click()
    await expect(result).toContainText('1 saved, 2 skipped.')
    await expect(page.getByLabel('Theme')).toHaveValue('dark')
  })

  test('a file that is not a preferences file is named as such', async ({ page }) => {
    await signedIn(page, 'alice', '/account/preferences')
    await page.getByLabel('Preferences file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('not json') })
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Import result' })).toContainText('This is not a DBLoom preferences file.')
    await expect(page.getByRole('button', { name: 'Import the valid entries only' })).toHaveCount(0)
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })

    test('security page, a dialog and the step-up dialog are axe clean', async ({ page }) => {
      await signedIn(page, 'bob')
      await expect(page.getByRole('list', { name: 'Passkeys' })).toBeVisible()
      await expect(page.getByRole('list', { name: 'Where you are signed in' })).toBeVisible()
      await clean(page)
      await page.getByRole('button', { name: 'Remove passkey Passkey 1' }).click()
      await clean(page)
      await dialog(page, 'Remove this passkey?').getByRole('button', { name: 'Remove' }).click()
      await expect(dialog(page, 'Confirm it is you')).toBeVisible()
      await clean(page)
    })

    test('empty security page and the add dialogs are axe clean', async ({ page }) => {
      await signedIn(page, 'alice')
      await expect(page.getByText('No passkeys yet.')).toBeVisible()
      await clean(page)
      await page.getByRole('button', { name: 'Set up' }).click()
      await expect(dialog(page, 'Set up an authenticator app').getByTestId('totp-secret')).toBeVisible()
      await clean(page)
    })

    test('preferences page with an import result is axe clean', async ({ page }) => {
      await signedIn(page, 'alice', '/account/preferences')
      await expect(page.getByLabel('Theme')).toBeVisible()
      await clean(page)
      const file = { dbloomPreferences: 1, exportedAt: 'x', user: { bogus: 1 }, targets: {} }
      await page.getByLabel('Preferences file').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
      await page.getByRole('button', { name: 'Import', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Import result' })).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('security and preferences fit without horizontal scroll', async ({ page }) => {
    await signedIn(page, 'bob')
    await expect(page.getByRole('list', { name: 'Passkeys' })).toBeVisible()
    await noOverflow(page)
    await page.getByRole('button', { name: 'Remove passkey Passkey 1' }).click()
    const box = await dialog(page, 'Remove this passkey?').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    await page.keyboard.press('Escape')
    await page.getByRole('link', { name: 'Preferences' }).click()
    await expect(page.getByLabel('Theme')).toBeVisible()
    await noOverflow(page)
  })
})
