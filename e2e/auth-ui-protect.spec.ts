import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, openMock, signInAs } from './fixtures/auth-ui'

/** Protected settings against the mock layer: guarded rows, pending line, confirm, revert, link on other pages (SPEC/33 FR-APR-011). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const FLAGS = 'dbloom.authMock.flags'
const REVERT_MS = 'dbloom.authMock.revertMs'
const NAME = 'Failed sign-ins before a delay'
const row = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })
const pendingBox = (page: Page, name = NAME) => row(page, name).getByRole('group', { name: 'Change waiting for confirmation' })
const link = (page: Page) => page.getByRole('complementary', { name: 'Change waiting for confirmation' })

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}
async function stepUp(page: Page) {
  const d = page.getByRole('dialog', { name: 'Confirm it is you' })
  await d.getByLabel('Your password').fill(PASSWORD)
  await d.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(d).toBeHidden()
}
async function signedIn(page: Page, flags = 'step-up-off') {
  await openMock(page, 'login')
  await signInAs(page, 'alice')
  await expect(h1(page)).toHaveText('Connect to a database')
  await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, flags])
}
async function settingsPage(page: Page, flags = 'step-up-off') {
  await signedIn(page, flags)
  await page.goto('/admin/settings?authMock=login')
  await expect(h1(page)).toHaveText('Settings')
}
async function change(page: Page, name: string, value: string) {
  const r = row(page, name)
  await r.getByLabel(name, { exact: true }).fill(value)
  await r.getByRole('button', { name: `Save: ${name}` }).click()
  return r
}

test.describe('guarded rows', () => {
  test('a protected row says when a change reverts, others do not', async ({ page }) => {
    await settingsPage(page)
    await expect(row(page, NAME)).toContainText('reverts in 5 minutes unless confirmed after signing in again')
    await expect(row(page, 'Administrator idle timeout')).toContainText('reverts in 5 minutes')
    await expect(row(page, 'Sessions per user')).not.toContainText('reverts in')
    await expect(row(page, 'Authenticator code tolerance (steps)')).not.toContainText('reverts in')
  })
})

test.describe('pending change', () => {
  test('a protected change shows the static pending line with the deadline', async ({ page }) => {
    await settingsPage(page)
    const r = await change(page, NAME, '7')
    const box = pendingBox(page)
    await expect(box).toBeVisible()
    await expect(box).toContainText('Waiting for confirmation: now 7. Reverts at ')
    await expect(box).not.toContainText('would')
    await expect(r.getByRole('button', { name: `Confirm change: ${NAME}` })).toBeVisible()
    await expect(r.getByRole('button', { name: `Revert now: ${NAME}` })).toBeVisible()
    // An unprotected row never shows the line.
    await change(page, 'Sessions per user', '4')
    await expect(pendingBox(page, 'Sessions per user')).toHaveCount(0)
  })

  test('Revert now puts the old value back without a second factor', async ({ page }) => {
    await settingsPage(page, '')
    await change(page, NAME, '7')
    await stepUp(page)
    await expect(pendingBox(page)).toBeVisible()
    await row(page, NAME).getByRole('button', { name: `Revert now: ${NAME}` }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(pendingBox(page)).toHaveCount(0)
    await expect(row(page, NAME).getByRole('status').filter({ hasText: 'Change reverted.' })).toBeVisible()
    await expect(row(page, NAME).getByLabel(NAME, { exact: true })).toHaveValue('5')
    await expect(row(page, NAME)).toContainText('Built-in default')
  })

  test('the session that made the change cannot confirm it', async ({ page }) => {
    await settingsPage(page)
    await change(page, NAME, '7')
    await row(page, NAME).getByRole('button', { name: `Confirm change: ${NAME}` }).click()
    await expect(row(page, NAME).getByRole('alert')).toContainText('Sign in again with the new settings, then confirm.')
    await expect(pendingBox(page)).toBeVisible()
  })

  test('after signing in again the change is confirmed with a second factor', async ({ page }) => {
    await settingsPage(page, '')
    await change(page, NAME, '7')
    await stepUp(page)
    await page.goto('/?authMock=login')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await signInAs(page, 'alice')
    await expect(h1(page)).toHaveText('Connect to a database')
    await page.goto('/admin/settings?authMock=login')
    await expect(pendingBox(page)).toBeVisible()
    // The earlier step-up window has run out by now.
    await page.evaluate((k) => {
      const x = JSON.parse(window.sessionStorage.getItem(k) ?? '{}')
      x.stepUpUntil = 0
      window.sessionStorage.setItem(k, JSON.stringify(x))
    }, 'dbloom.authMock.account')
    await row(page, NAME).getByRole('button', { name: `Confirm change: ${NAME}` }).click()
    await stepUp(page)
    await expect(pendingBox(page)).toHaveCount(0)
    await expect(row(page, NAME).getByRole('status').filter({ hasText: 'Change confirmed.' })).toBeVisible()
    await expect(row(page, NAME).getByLabel(NAME, { exact: true })).toHaveValue('7')
  })

  test('an unconfirmed change reverts at the deadline', async ({ page }) => {
    await page.addInitScript((k) => window.sessionStorage.setItem(k, '1500'), REVERT_MS)
    await settingsPage(page)
    await change(page, NAME, '7')
    await expect(pendingBox(page)).toBeVisible()
    await page.waitForTimeout(1800)
    await page.reload()
    await expect(row(page, NAME).getByLabel(NAME, { exact: true })).toHaveValue('5')
    await expect(pendingBox(page)).toHaveCount(0)
  })
})

test.describe('link on other admin pages', () => {
  test('shows while a change waits, goes when it is settled', async ({ page }) => {
    await settingsPage(page)
    await page.goto('/admin/users?authMock=login')
    await expect(h1(page)).toBeVisible()
    await expect(link(page)).toHaveCount(0)

    await page.goto('/admin/settings?authMock=login')
    await change(page, NAME, '7')
    await expect(pendingBox(page)).toBeVisible()
    for (const path of ['/admin/users', '/admin/audit', '/admin/exposure', '/']) {
      await page.goto(`${path}?authMock=login`)
      await expect(link(page)).toContainText('A settings change is waiting for confirmation and will revert if not confirmed.')
    }
    await link(page).getByRole('link', { name: 'Review in settings' }).click()
    await expect(h1(page)).toHaveText('Settings')
    await row(page, NAME).getByRole('button', { name: `Revert now: ${NAME}` }).click()
    await expect(pendingBox(page)).toHaveCount(0)
    await page.goto('/admin/users?authMock=login')
    await expect(h1(page)).toBeVisible()
    await expect(link(page)).toHaveCount(0)
  })

  test('a user who is not an administrator sees nothing', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'erin')
    await expect(h1(page)).toHaveText('Connect to a database')
    await expect(link(page)).toHaveCount(0)
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme at phone width`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.setViewportSize({ width: 375, height: 800 })
    })
    test('settings page with a pending line, and the link on the users page', async ({ page }) => {
      await settingsPage(page)
      await change(page, NAME, '7')
      await expect(pendingBox(page)).toBeVisible()
      await clean(page)
      await noOverflow(page)
      await page.goto('/admin/users?authMock=login')
      await expect(link(page)).toBeVisible()
      await clean(page)
      await noOverflow(page)
    })
  })
}
