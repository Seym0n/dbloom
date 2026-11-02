import { expect, test } from '@playwright/test'
import { PASSWORD, SETUP_TOKEN, TOTP, openMock, signInAs } from './fixtures/auth-ui'

/** First-run wizard against the mock layer (SCN-064, SCN-065, FR-AUT-003, UI-TGT-002). */

const h1 = (page: import('@playwright/test').Page) => page.getByRole('heading', { level: 1 })

test('the front page sends a pending setup to /setup', async ({ page }) => {
  await openMock(page, 'setup', '/')
  await expect(page).toHaveURL(/\/setup/)
  await expect(h1(page)).toHaveText('Welcome to DBLoom')
})

test('five steps in account mode, then sign in as the new administrator', async ({ page }) => {
  await openMock(page, 'setup', '/setup')
  await expect(page.getByText('Step 1 of 5')).toBeVisible()
  await expect(page.getByText('Stateful (SQLite)')).toBeVisible()

  // Step 1: a wrong token gives the same page and one fixed message.
  await page.getByLabel('Setup token').fill('WRONG-TOKEN')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toHaveText('That token was not accepted.')
  await page.getByLabel('Setup token').fill(SETUP_TOKEN)
  await page.getByRole('button', { name: 'Continue' }).click()

  // Step 2
  await expect(h1(page)).toHaveText('Login mode')
  await expect(page.getByLabel(/Account mode/)).toBeChecked()
  await page.getByRole('button', { name: 'Next' }).click()

  // Step 3: read-only environment status, warnings, acknowledgement.
  await expect(h1(page)).toHaveText('Site settings')
  await expect(page.getByRole('heading', { name: 'Server environment' })).toBeVisible()
  await expect(page.getByText('Differs from the address in this browser')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Confirm the administration network warning to continue.')).toBeVisible()
  await page.getByLabel('I understand and want to continue from this address.').check()
  await page.getByLabel('Site name').fill('')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Required.')).toBeVisible()
  await page.getByLabel('Site name').fill('Team DB')
  await page.getByRole('button', { name: 'Next' }).click()

  // Step 4: password, then an authenticator app, recovery codes once.
  await expect(h1(page)).toHaveText('First administrator')
  await page.getByLabel('User name').fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByLabel('New password again').fill('short')
  await expect(page.getByTestId('strength')).toContainText('too short')
  await page.getByRole('button', { name: 'Save and add a second factor' }).click()
  await expect(page.getByRole('alert')).toHaveText('The password is too short.')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('New password again').fill(PASSWORD)
  await page.getByRole('button', { name: 'Save and add a second factor' }).click()
  await page.getByRole('button', { name: 'Add an authenticator app' }).click()
  await page.getByLabel('Code from the app').fill(TOTP)
  await page.getByRole('button', { name: 'Verify and add' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10)
  const carryOn = page.getByRole('button', { name: 'Continue' })
  await expect(carryOn).toBeDisabled()
  await page.getByLabel('I saved them').check()
  await carryOn.click()
  await page.getByRole('button', { name: 'Finish setup' }).click()

  // Step 5
  await expect(h1(page)).toHaveText('Setup complete')
  await expect(page.getByText('Team DB')).toBeVisible()
  await page.getByRole('link', { name: 'Go to sign-in' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
  await signInAs(page, 'admin')
  await expect(h1(page)).toHaveText('Confirm it is you')
  await page.getByLabel('Code from your authenticator app').fill(TOTP)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(h1(page)).toHaveText('Connect to a database')
})

test('four steps in direct mode: no administrator step', async ({ page }) => {
  await openMock(page, 'setup', '/setup')
  await page.getByLabel('Setup token').fill(SETUP_TOKEN)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/Direct mode/).check()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Step 3 of 4')).toBeVisible()
  await expect(page.getByLabel('Minimum length (characters)')).toHaveCount(0)
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await expect(page.getByText('Step 4 of 4')).toBeVisible()
  await expect(h1(page)).toHaveText('Setup complete')
})

test('passkey enrolment in the wizard', async ({ page }) => {
  await openMock(page, 'setup', '/setup')
  await page.getByLabel('Setup token').fill(SETUP_TOKEN)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('I understand and want to continue from this address.').check()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(h1(page)).toHaveText('First administrator')
  await page.getByLabel('User name').fill('admin')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('New password again').fill(PASSWORD)
  await page.getByRole('button', { name: 'Save and add a second factor' }).click()
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await expect(page.getByText('Passkey added')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish setup' })).toBeEnabled()
})
