import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { openMock, signInAs } from './fixtures/auth-ui'

/** Exposure page (`/admin/exposure`) and the banner against the mock layer (SPEC/31 FR-AEX-003, 004, 005). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const banner = (page: Page) => page.getByRole('complementary', { name: 'Exposure and status' })
const warnings = (page: Page) => page.getByRole('list', { name: 'Warnings' }).getByRole('listitem')
const FLAGS = 'dbloom.authMock.flags'

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function signedIn(page: Page, username = 'alice', flags = '') {
  await openMock(page, 'login')
  await signInAs(page, username)
  await expect(h1(page)).toHaveText('Connect to a database')
  if (flags) await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, flags])
}
async function exposurePage(page: Page, username = 'alice', flags = '') {
  await signedIn(page, username, flags)
  await page.goto('/admin/exposure?authMock=login')
}

test.describe('access', () => {
  test('an administrator sees warnings, the report and the status block', async ({ page }) => {
    await exposurePage(page)
    await expect(h1(page)).toHaveText('Exposure and status')
    await expect(warnings(page)).toHaveCount(3)
    await expect(warnings(page).nth(0)).toContainText('Targets on loopback or private networks are allowed')
    await expect(warnings(page).nth(0)).toContainText('Configuration')
    await expect(warnings(page).nth(1)).toContainText('No second factor is enforced for sign-in')
    await expect(warnings(page).nth(1)).toContainText('Running state')
    await expect(page.getByText(/^Report as at start:/)).toBeVisible()
    // Every line of the report is on the page.
    for (const [label, value] of [
      ['bind', '0.0.0.0:3000'], ['public origin', 'https://db.example.com'], ['scheme', 'https'], ['trusted proxies', '172.18.0.0/16'],
      ['hsts', 'on, max-age 31536000'], ['login mode', 'account'], ['store', 'sqlite in /data'], ['target tls', 'verify'],
    ] as const) {
      await expect(page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible()
      await expect(page.getByRole('definition').filter({ hasText: value }).first()).toBeVisible()
    }
    await expect(page.getByRole('definition').filter({ hasText: /^yes$/ })).toBeVisible()
    await expect(page.getByRole('definition').filter({ hasText: /^working$/ })).toBeVisible()
    await expect(page.getByRole('definition').filter({ hasText: /^stdout, ok$/ })).toBeVisible()
  })

  test('someone who is not an administrator is told so, and sees no banner at home', async ({ page }) => {
    await signedIn(page, 'erin')
    await expect(banner(page)).toHaveCount(0)
    await page.goto('/admin/exposure?authMock=login')
    await expect(h1(page)).toHaveText('Administrators only')
  })

  test('without a session the front page takes over', async ({ page }) => {
    await page.goto('/admin/exposure?authMock=login')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
  })

  test('direct mode has no administrators: the front page', async ({ page }) => {
    await openMock(page, 'direct', '/admin/exposure')
    await expect(h1(page)).not.toHaveText('Exposure and status')
  })
})

test.describe('banner', () => {
  test('raised for an administrator at home, with the count and a link to the page', async ({ page }) => {
    await signedIn(page)
    await expect(banner(page)).toContainText('3 exposure warnings need attention.')
    await banner(page).getByRole('link', { name: 'Review on the exposure page' }).click()
    await expect(h1(page)).toHaveText('Exposure and status')
  })

  test('also on the Users and Audit pages', async ({ page }) => {
    await signedIn(page)
    for (const [path, title] of [['/admin/users', 'Users'], ['/admin/audit', 'Audit log']] as const) {
      await page.goto(`${path}?authMock=login`)
      await expect(h1(page)).toHaveText(title)
      await expect(banner(page)).toContainText('3 exposure warnings need attention.')
    }
  })

  test('acknowledging one lowers the count; the warning stays listed with who and when; all acknowledged hides the banner', async ({ page }) => {
    await exposurePage(page)
    await page.getByRole('button', { name: /^Acknowledge: No second factor/ }).click()
    await expect(warnings(page).nth(1)).toContainText(/Acknowledged by .+ at /)
    await expect(warnings(page)).toHaveCount(3)
    await expect(page.getByRole('button', { name: /^Acknowledge:/ })).toHaveCount(2)
    await page.goto('/?authMock=login')
    await expect(banner(page)).toContainText('2 exposure warnings need attention.')
    await page.goto('/admin/exposure?authMock=login')
    for (const name of [/^Acknowledge: Targets/, /^Acknowledge: Administration/]) await page.getByRole('button', { name }).click()
    await expect(page.getByRole('button', { name: /^Acknowledge:/ })).toHaveCount(0)
    await page.goto('/?authMock=login')
    await expect(h1(page)).toHaveText('Connect to a database')
    await expect(banner(page)).toHaveCount(0)
  })

  test('a loopback install lists the warnings but raises no banner', async ({ page }) => {
    await exposurePage(page, 'alice', 'exposure-loopback')
    await expect(warnings(page)).toHaveCount(3)
    await page.goto('/?authMock=login')
    await expect(h1(page)).toHaveText('Connect to a database')
    await expect(banner(page)).toHaveCount(0)
  })

  test('without warnings: the empty text and no banner', async ({ page }) => {
    await exposurePage(page, 'alice', 'exposure-clean')
    await expect(page.getByText('No warnings.')).toBeVisible()
    await page.goto('/?authMock=login')
    await expect(banner(page)).toHaveCount(0)
  })
})

test.describe('status block', () => {
  test('a failing external sink is shown as degraded', async ({ page }) => {
    await exposurePage(page, 'alice', 'audit-degraded')
    await expect(page.getByRole('definition').filter({ hasText: /^file, degraded$/ })).toBeVisible()
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })
    test('page and banner', async ({ page }) => {
      await signedIn(page)
      await expect(banner(page)).toBeVisible()
      await clean(page)
      await page.getByRole('link', { name: 'Review on the exposure page' }).click()
      await expect(warnings(page)).toHaveCount(3)
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })
  test('no horizontal scroll at home with the banner and on the page', async ({ page }) => {
    await signedIn(page)
    await expect(banner(page)).toBeVisible()
    await noOverflow(page)
    await page.goto('/admin/exposure?authMock=login')
    await expect(warnings(page)).toHaveCount(3)
    await noOverflow(page)
  })
})
