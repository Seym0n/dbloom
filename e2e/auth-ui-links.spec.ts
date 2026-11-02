import { expect, test, type Page } from '@playwright/test'
import { INVITE_TOKEN, PASSWORD, RECOVERY_TOKEN, openMock } from './fixtures/auth-ui'

/** Invite and recovery pages (FR-AUT-015, 016): the token leaves the address bar at once. */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

test('invite: token is removed from the address bar, account is created', async ({ page }) => {
  await openMock(page, 'login', '/invite', `#${INVITE_TOKEN}`)
  await expect(h1(page)).toHaveText('Create your account')
  expect(await page.evaluate(() => location.hash)).toBe('')
  expect(page.url()).not.toContain(INVITE_TOKEN)

  await page.getByLabel('User name').fill('frank')
  await page.getByLabel('New password', { exact: true }).fill('short')
  await page.getByLabel('New password again').fill('short')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toHaveText('The password is too short.')
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('New password again').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(h1(page)).toHaveText('Account created')
  await page.getByRole('link', { name: 'Go to sign-in' }).click()
  await expect(h1(page)).toHaveText('Sign in to DBLoom')
})

test('invite: passkey path needs a user name first', async ({ page }) => {
  await openMock(page, 'login', '/invite', `#${INVITE_TOKEN}`)
  await page.getByRole('tab', { name: 'Passkey' }).click()
  await expect(page.getByRole('button', { name: 'Add passkey' })).toBeDisabled()
  await page.getByLabel('User name').fill('gina')
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await expect(h1(page)).toHaveText('Account created')
})

test('invite: no token and a wrong token each show one fixed message', async ({ page }) => {
  await openMock(page, 'login', '/invite')
  await expect(h1(page)).toHaveText('Invite link not valid')
  await page.goto('about:blank')
  await page.goto(`/invite?authMock=login#${'z'.repeat(43)}`)
  await page.getByLabel('User name').fill('hank')
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('New password again').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toContainText('This invite link is not valid')
})

test('recovery: token removed, new password set', async ({ page }) => {
  await openMock(page, 'login', '/recover', `#${RECOVERY_TOKEN}`)
  await expect(h1(page)).toHaveText('Recover your account')
  expect(await page.evaluate(() => location.hash)).toBe('')
  await expect(page.getByLabel('User name')).toHaveCount(0)
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('New password again').fill(PASSWORD)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(h1(page)).toHaveText('Sign-in restored')
})
