import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, openMock, signInAs } from './fixtures/auth-ui'

/** Audit log page (`/admin/audit`) and own activity on the account page against the mock layer (SPEC/29 FR-AAU-007, 008). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const entries = (page: Page) => page.getByRole('list', { name: 'Audit entries' }).getByRole('listitem')
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function auditPage(page: Page, username = 'alice', path = '/admin/audit') {
  await openMock(page, 'login')
  await signInAs(page, username)
  await expect(h1(page)).toHaveText('Connect to a database')
  await page.goto(`${path}?authMock=login`)
}

async function apply(page: Page, fill: (p: Page) => Promise<unknown>) {
  await fill(page)
  await page.getByRole('button', { name: 'Apply filters' }).click()
}

test.describe('access', () => {
  test('an administrator sees the newest entries first', async ({ page }) => {
    await auditPage(page)
    await expect(h1(page)).toHaveText('Audit log')
    await expect(entries(page)).toHaveCount(50)
    await expect(entries(page).first()).toContainText('subject-130')
    await expect(entries(page).nth(1)).toContainText('subject-129')
  })

  test('someone who is not an administrator is told so', async ({ page }) => {
    await auditPage(page, 'erin')
    await expect(h1(page)).toHaveText('Administrators only')
  })

  test('without a session the front page takes over', async ({ page }) => {
    await page.goto('/admin/audit?authMock=login')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
  })

  test('direct mode shows a notice, no list', async ({ page }) => {
    await openMock(page, 'direct', '/admin/audit')
    await expect(h1(page)).toHaveText('Audit log')
    await expect(page.getByText('No audit table in this mode')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Audit entries' })).toHaveCount(0)
  })
})

test.describe('paging and filters', () => {
  test.beforeEach(async ({ page }) => {
    await auditPage(page)
    await expect(entries(page)).toHaveCount(50)
  })

  test('older entries load by page until the end', async ({ page }) => {
    await page.getByRole('button', { name: 'Load older entries' }).click()
    await expect(entries(page)).toHaveCount(100)
    await page.getByRole('button', { name: 'Load older entries' }).click()
    await expect(entries(page)).toHaveCount(130)
    await expect(page.getByRole('button', { name: 'Load older entries' })).toBeHidden()
    await expect(entries(page).last()).toContainText('subject-1')
  })

  test('event, actor, outcome and subject filters narrow the list; reset restores it', async ({ page }) => {
    await apply(page, (p) => p.getByLabel('Event').selectOption('sql.run'))
    await expect(entries(page).first()).toBeVisible()
    for (const li of await entries(page).all()) await expect(li).toContainText('sql.run')

    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(entries(page)).toHaveCount(50)

    await apply(page, (p) => p.getByLabel('Actor').fill('cli'))
    await expect(entries(page).first()).toBeVisible()
    for (const li of await entries(page).all()) await expect(li).toContainText('Host command line')

    await page.getByRole('button', { name: 'Reset' }).click()
    await apply(page, (p) => p.getByLabel('Outcome').selectOption('failed'))
    await expect(entries(page).first()).toBeVisible()
    for (const li of await entries(page).all()) await expect(li).toContainText('failed')

    await page.getByRole('button', { name: 'Reset' }).click()
    await apply(page, (p) => p.getByLabel('Subject contains').fill('subject-12'))
    await expect(entries(page)).toHaveCount(11)
  })

  test('no match shows the empty text', async ({ page }) => {
    await apply(page, (p) => p.getByLabel('Subject contains').fill('nothing like this'))
    await expect(page.getByText('No entries match.')).toBeVisible()
  })

  test('the detail panel shows the redacted fields and closes', async ({ page }) => {
    await page.getByRole('button', { name: 'Show details of entry 130' }).click()
    const panel = page.getByRole('region', { name: 'Entry 130' })
    await expect(panel).toContainText('subject-130')
    await expect(panel).toContainText('"note": "row 130"')
    await panel.getByRole('button', { name: 'Close details' }).click()
    await expect(panel).toBeHidden()
  })
})

test.describe('status banner', () => {
  test('a failing external sink is stated', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'alice')
    await expect(h1(page)).toHaveText('Connect to a database')
    await page.evaluate(() => window.sessionStorage.setItem('dbloom.authMock.flags', 'audit-degraded'))
    await page.goto('/admin/audit?authMock=login')
    await expect(page.getByRole('alert')).toContainText('The external audit sink is failing: 42 entries are held in memory, 0 were dropped. Error: EACCES.')
  })

  test('no banner while everything works', async ({ page }) => {
    await auditPage(page)
    await expect(entries(page).first()).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test.describe('export', () => {
  test('needs a step-up, then reports the row count', async ({ page }) => {
    await auditPage(page)
    await page.getByRole('button', { name: 'Export CSV' }).click()
    const d = dialog(page, 'Confirm it is you')
    await d.getByLabel('Your password').fill(PASSWORD)
    await d.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(d).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Export started: 130 entries.' })).toBeVisible()
  })

  test('the step-up can be cancelled; nothing is exported', async ({ page }) => {
    await auditPage(page)
    await page.getByRole('button', { name: 'Export NDJSON' }).click()
    await dialog(page, 'Confirm it is you').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Export started')).toHaveCount(0)
  })
})

test.describe('own activity on the account page', () => {
  test('an administrator sees their own recent activity', async ({ page }) => {
    await auditPage(page, 'alice', '/account')
    const list = page.getByRole('list', { name: 'Recent activity' })
    await expect(list.getByRole('listitem').first()).toBeVisible()
    await expect(list).not.toContainText('Host command line')
  })

  test('a user with none sees the empty text', async ({ page }) => {
    await auditPage(page, 'erin', '/account')
    await expect(page.getByText('No activity recorded.')).toBeVisible()
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })

    test('page and detail panel', async ({ page }) => {
      await auditPage(page)
      await expect(entries(page).first()).toBeVisible()
      await clean(page)
      await page.getByRole('button', { name: 'Show details of entry 130' }).click()
      await expect(page.getByRole('region', { name: 'Entry 130' })).toBeVisible()
      await clean(page)
    })

    test('account activity section', async ({ page }) => {
      await auditPage(page, 'alice', '/account')
      await expect(page.getByRole('list', { name: 'Recent activity' })).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('no horizontal scroll on the list and the detail panel', async ({ page }) => {
    await auditPage(page)
    await expect(entries(page).first()).toBeVisible()
    await noOverflow(page)
    await page.getByRole('button', { name: 'Show details of entry 130' }).click()
    await expect(page.getByRole('region', { name: 'Entry 130' })).toBeVisible()
    await noOverflow(page)
  })
})
