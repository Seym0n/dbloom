import type { Page } from '@playwright/test'

/** Constants of the mock layer (src/lib/auth/mock-api.ts); the specs do not import app code. */
export const PASSWORD = 'correct horse battery'
export const SETUP_TOKEN = 'MOCK-SETUP-TOKEN'
export const TOTP = '123456'
export const RECOVERY_CODE = 'AAAA-BBBB-CCCC'
export const INVITE_TOKEN = `inv-${'a'.repeat(39)}`
export const RECOVERY_TOKEN = `rec-${'b'.repeat(39)}`
export const FAILED = 'Sign-in failed. Check the user name and password.'

/**
 * Opens `path` on a mock scenario. The mock keeps its state in the tab's session storage, so a second call with the
 * same scenario inside one test continues where the first left off; every test starts in a fresh context.
 */
export async function openMock(page: Page, scenario: 'setup' | 'login' | 'direct', path = '/', hash = '') {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}authMock=${scenario}${hash}`)
}

export async function signInAs(page: Page, username: string, password = PASSWORD) {
  await page.getByLabel('User name').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
