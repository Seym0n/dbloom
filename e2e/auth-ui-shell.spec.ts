import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { openMock, signInAs } from './fixtures/auth-ui'

/**
 * Account shell chrome against the mock layer: account menu (FR-AUT-026), idle warning (SEC-UIX-109) and the
 * "Connection lost" notice (SCN-072). The shell's own server functions are not mocked: aborting them is a network error.
 */

async function mockSetting(page: Page, key: string, value: string) {
  await page.addInitScript(([k, v]) => window.sessionStorage.setItem(k!, v!), [key, value])
}

async function toShell(page: Page) {
  await openMock(page, 'login')
  await signInAs(page, 'alice')
  await page.getByRole('tab', { name: 'Type credentials' }).click()
  await page.getByLabel('Host').fill('db.example.org')
  await page.getByLabel('Database user').fill('app')
  await page.getByLabel('Database password').fill('secret')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 })
}

test.describe('account menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/_serverFn/, (route) => route.abort())
  })

  test('shows the user name, Account and Log out', async ({ page }) => {
    await toShell(page)
    await page.getByRole('button', { name: 'Account menu' }).click()
    const menu = page.getByRole('menu', { name: 'Account menu' })
    await expect(menu).toContainText('Alice')
    await expect(menu.getByRole('menuitem')).toHaveText(['Account', 'Log out'])
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('[role="menu"]').analyze()
    expect(results.violations.map((v) => v.id)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Account' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account security')
  })

  test('Log out leads to the sign-in', async ({ page }) => {
    await toShell(page)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to DBLoom')
  })
})

test.describe('idle warning', () => {
  test('Stay signed in keeps the session', async ({ page }) => {
    await page.route(/_serverFn/, (route) => route.abort())
    await mockSetting(page, 'dbloom.authMock.idleMs', '123000')
    await toShell(page)
    const warning = page.getByRole('dialog', { name: 'Still there?' })
    await expect(warning).toBeVisible({ timeout: 15_000 })
    await expect(warning.getByTestId('idle-remaining')).toHaveText(/You will be signed out in [12]:\d\d\./)
    await warning.getByRole('button', { name: 'Stay signed in' }).click()
    await expect(warning).toBeHidden()
    await expect(page.getByRole('dialog', { name: 'Your session has ended' })).toBeHidden()
  })

  test('without an answer the session ends, on the connection picker as well as in the shell', async ({ page }) => {
    await page.route(/_serverFn/, (route) => route.abort())
    await mockSetting(page, 'dbloom.authMock.idleMs', '4000')
    // the picker is where a short limit runs out first: the neutral dialog must be there too
    await openMock(page, 'login')
    await signInAs(page, 'alice')
    await expect(page.getByRole('dialog', { name: 'Your session has ended' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('dialog', { name: 'Still there?' })).toBeHidden()
    await page.getByRole('button', { name: 'Sign in again' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to DBLoom')
  })
})

test('Connection lost shows Retry and keeps the session', async ({ page }) => {
  await page.route(/_serverFn/, (route) => route.abort())
  await toShell(page)
  const notice = page.getByRole('alert').filter({ hasText: 'Connection lost' })
  await expect(notice).toBeVisible({ timeout: 10_000 })
  await expect(notice).toContainText('You are still signed in.')
  await expect(page.getByRole('dialog', { name: 'Your session has ended' })).toBeHidden()
  // Still unreachable: Retry leaves the notice up.
  await notice.getByRole('button', { name: 'Retry' }).click()
  await expect(notice).toBeVisible()
  // Reachable again: Retry clears it.
  await page.unroute(/_serverFn/)
  await page.route(/_serverFn/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await notice.getByRole('button', { name: 'Retry' }).click()
  await expect(notice).toBeHidden()
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible()
})
