import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { INVITE_TOKEN, PASSWORD, SETUP_TOKEN, openMock, signInAs } from './fixtures/auth-ui'

/** Axe, dark theme, phone width and reduced motion on the auth screens (SPEC/26 5.10). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

async function clean(page: Page) {
  // The first page of a cold dev server can reload once while Vite optimises its dependencies, which destroys the
  // execution context axe runs in; one reload is expected, so try again after the page settled.
  let results: Awaited<ReturnType<AxeBuilder['analyze']>> | undefined
  for (let attempt = 1; !results; attempt += 1) {
    try {
      results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    } catch (error) {
      if (attempt >= 3 || !/Execution context was destroyed/.test(String(error))) throw error
      await page.waitForLoadState('load')
    }
  }
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })

    test('setup steps', async ({ page }) => {
      await openMock(page, 'setup', '/setup')
      await clean(page)
      await page.getByLabel('Setup token').fill(SETUP_TOKEN)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(h1(page)).toHaveText('Login mode')
      await clean(page)
      await page.getByRole('button', { name: 'Next' }).click()
      await expect(h1(page)).toHaveText('Site settings')
      await clean(page)
      await page.getByLabel('I understand and want to continue from this address.').check()
      await page.getByRole('button', { name: 'Next' }).click()
      await expect(h1(page)).toHaveText('First administrator')
      await page.getByLabel('User name').fill('admin')
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await clean(page)
    })

    test('sign-in, second factor, enrolment, forced change', async ({ page }) => {
      await openMock(page, 'login')
      await clean(page)
      await signInAs(page, 'bob')
      await expect(h1(page)).toHaveText('Confirm it is you')
      await clean(page)
      await page.getByRole('button', { name: 'Sign in as someone else' }).click()
      await signInAs(page, 'carol')
      await expect(h1(page)).toHaveText('Add a second factor')
      await clean(page)
      await page.getByRole('button', { name: 'Sign out' }).click()
      await signInAs(page, 'dave')
      await expect(page.getByRole('dialog')).toBeVisible()
      await clean(page)
    })

    test('invite page', async ({ page }) => {
      await openMock(page, 'login', '/invite', `#${INVITE_TOKEN}`)
      await expect(h1(page)).toHaveText('Create your account')
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('no horizontal scroll on the wizard and the sign-in pages', async ({ page }) => {
    await openMock(page, 'setup', '/setup')
    await noOverflow(page)
    await page.getByLabel('Setup token').fill(SETUP_TOKEN)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(h1(page)).toHaveText('Site settings')
    await noOverflow(page)
    await page.goto('/?authMock=login')
    await noOverflow(page)
  })

  test('the forced change dialog fits the screen', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'dave')
    await expect(page.getByRole('dialog')).toBeVisible()
    await noOverflow(page)
    const box = await page.getByRole('dialog').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  })
})
