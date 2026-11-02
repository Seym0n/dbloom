import { expect, test } from '@playwright/test'
import { FAILED, PASSWORD, RECOVERY_CODE, TOTP, openMock, signInAs } from './fixtures/auth-ui'

/** Account-mode sign-in, second factor, enrolment and forced change against the mock layer (SCN-066, FR-AUT-006 to 012). */

const h1 = (page: import('@playwright/test').Page) => page.getByRole('heading', { level: 1 })

test.describe('account sign-in', () => {
  test('direct mode keeps its own login page', async ({ page }) => {
    await openMock(page, 'direct')
    await expect(h1(page)).toHaveText('Sign in to a database server')
    await expect(page.getByText('Direct mode:')).toBeVisible()
  })

  test('a full session lands on the app', async ({ page }) => {
    await openMock(page, 'login')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
    await signInAs(page, 'alice')
    await expect(h1(page)).toHaveText('Connect to a database')
  })

  test('unknown user and wrong password show the same fixed message', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'alice', 'nope nope nope')
    await expect(page.getByRole('alert')).toHaveText(FAILED)
    await signInAs(page, 'nobody', PASSWORD)
    await expect(page.getByRole('alert')).toHaveText(FAILED)
  })

  test('throttle shows a countdown and lifts', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'erin', 'wrong one')
    await signInAs(page, 'erin', 'wrong two')
    await expect(page.getByRole('alert')).toContainText('Too many sign-in attempts')
    await expect(page.getByRole('button', { name: /Try again in \d+ s/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 10_000 })
  })

  test('passkey button signs in', async ({ page }) => {
    await openMock(page, 'login')
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })
})

test.describe('second factor', () => {
  test.beforeEach(async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'bob')
    await expect(h1(page)).toHaveText('Confirm it is you')
  })

  test('wrong code, then the right code', async ({ page }) => {
    await page.getByLabel('Code from your authenticator app').fill('000000')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toHaveText('That code or passkey was not accepted. Try again.')
    await page.getByLabel('Code from your authenticator app').fill(TOTP)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })

  test('tabs: arrow keys move, recovery code works', async ({ page }) => {
    await page.getByRole('tab', { name: 'Authenticator app' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Passkey' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Recovery code' })).toBeFocused()
    await page.getByRole('textbox', { name: 'Recovery code' }).fill(RECOVERY_CODE.toLowerCase())
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })

  test('passkey tab confirms with the device', async ({ page }) => {
    await page.getByRole('tab', { name: 'Passkey' }).click()
    await page.getByRole('button', { name: 'Use passkey' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })

  test('a reload keeps the half-signed-in guard', async ({ page }) => {
    await page.reload()
    await expect(h1(page)).toHaveText('Confirm it is you')
  })

  test('other account signs out and returns to sign-in', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign in as someone else' }).click()
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
  })
})

test.describe('enrol only', () => {
  test('authenticator app enrolment, recovery codes once, then in', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'carol')
    await expect(h1(page)).toHaveText('Add a second factor')
    await expect(page.getByTestId('totp-secret')).toBeVisible()
    await page.getByLabel('Code from the app').fill(TOTP)
    await page.getByRole('button', { name: 'Verify and add' }).click()
    await expect(h1(page)).toHaveText('Save your recovery codes')
    await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10)
    const next = page.getByRole('button', { name: 'Continue' })
    await expect(next).toBeDisabled()
    await page.getByLabel('I saved them').check()
    await next.click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })
})

test.describe('must change password', () => {
  test('the dialog cannot be dismissed and accepts a valid new password', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'dave')
    const dialog = page.getByRole('dialog', { name: 'Choose a new password' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Current password')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    await dialog.getByLabel('Current password').fill(PASSWORD)
    await dialog.getByLabel('New password', { exact: true }).fill('short')
    await dialog.getByLabel('New password again').fill('short')
    await dialog.getByRole('button', { name: 'Change password' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('The password is too short.')

    await dialog.getByLabel('New password', { exact: true }).fill('a much longer new password')
    await expect(dialog.getByTestId('strength')).toContainText('Strength')
    await dialog.getByLabel('New password again').fill('another one entirely')
    await dialog.getByRole('button', { name: 'Change password' }).click()
    await expect(dialog.getByText('The two passwords are not the same.')).toBeVisible()

    await dialog.getByLabel('New password again').fill('a much longer new password')
    await dialog.getByRole('button', { name: 'Change password' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })
})
