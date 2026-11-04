import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, openMock, signInAs } from './fixtures/auth-ui'

/** The assistant administrator page (`/admin/assistant`) against the mock layer (SPEC/34 FR-AST-006, FR-AST-019). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })
const FLAGS = 'dbloom.authMock.flags'

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}
async function stepUp(page: Page) {
  const d = dialog(page, 'Confirm it is you')
  await d.getByLabel('Your password').fill(PASSWORD)
  await d.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(d).toBeHidden()
}
async function adminPage(page: Page, username = 'alice', flags = 'step-up-off') {
  await openMock(page, 'login')
  await signInAs(page, username)
  await expect(h1(page)).toHaveText('Connect to a database')
  if (flags) await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, flags])
  await page.goto('/admin/assistant?authMock=login')
}
const marks = (page: Page) => page.getByRole('list', { name: 'Markings kept here' })
const addMarking = async (page: Page, rule: string) => {
  await page.getByLabel('Marking', { exact: true }).fill(rule)
  await page.getByRole('button', { name: 'Add marking' }).click()
}

test.describe('access', () => {
  test('an administrator sees the endpoint without a key value, the switches and the markings', async ({ page }) => {
    await adminPage(page)
    await expect(h1(page)).toHaveText('AI assistant')
    const endpoint = page.getByRole('region', { name: 'AI service' })
    await expect(endpoint).toContainText('Connected to an address')
    await expect(endpoint).toContainText('https://ai.example.com')
    await expect(endpoint.getByText('Set', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('sk-')
    const switches = page.getByRole('list', { name: 'Switches' })
    for (const label of ['AI assistant is on', 'AI model name', 'Users may let the assistant run queries without asking each time', 'Hide the names of PII columns from the AI']) {
      await expect(switches.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(page.getByText('*.*.ssn')).toBeVisible()
    await expect(page.getByText('No markings yet.')).toBeVisible()
  })

  test('a user who is not an administrator is turned away', async ({ page }) => {
    await adminPage(page, 'erin', '')
    await expect(h1(page)).toHaveText('Administrators only')
  })

  test('not configured says so; a problem of the environment is listed', async ({ page }) => {
    await adminPage(page, 'alice', 'step-up-off,assistant-off')
    await expect(page.getByRole('region', { name: 'AI service' })).toContainText('Not configured')
    await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, 'step-up-off,assistant-endpoint-problem'])
    await page.reload()
    await expect(page.getByRole('group', { name: 'Problems with the environment' })).toContainText('DBLOOM_AI_MAX_ROWS is not a whole number')
  })

  test('the connection home links to the page for administrators', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'alice')
    await page.getByRole('link', { name: 'Assistant' }).click()
    await expect(h1(page)).toHaveText('AI assistant')
  })
})

test.describe('markings', () => {
  test('add, repeat, remove: normalised, once, and gone', async ({ page }) => {
    await adminPage(page)
    await addMarking(page, ' Shop.Customers.Email ')
    await expect(page.getByRole('status').filter({ hasText: 'Marking added.' })).toBeVisible()
    await expect(marks(page).getByRole('listitem')).toHaveCount(1)
    await expect(marks(page)).toContainText('shop.customers.email')
    await expect(marks(page)).toContainText('All connections')
    await expect(page.getByLabel('Marking', { exact: true })).toHaveValue('')
    await addMarking(page, 'shop.customers.email')
    await expect(page.getByRole('status').filter({ hasText: 'That marking exists already.' })).toBeVisible()
    await expect(marks(page).getByRole('listitem')).toHaveCount(1)
    await page.getByRole('button', { name: 'Remove marking: shop.customers.email' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Marking removed.' })).toBeVisible()
    await expect(page.getByText('No markings yet.')).toBeVisible()
  })

  test('a marking for one connection shows its scope', async ({ page }) => {
    await adminPage(page)
    await page.getByLabel('Applies to', { exact: true }).first().selectOption('one')
    await page.getByLabel('Connection (host:port)').fill('db.example.org:3306')
    await addMarking(page, '*.*.phone')
    await expect(marks(page)).toContainText('db.example.org:3306')
    await expect(marks(page)).toContainText('*.*.phone')
  })

  test('refusals: a rule that is not db.table.column, a bad connection, a failing audit write', async ({ page }) => {
    await adminPage(page, 'alice', 'step-up-off,assistant-audit-fail')
    await addMarking(page, 'email')
    await expect(page.getByRole('alert')).toContainText('That is not a marking.')
    await addMarking(page, 'a.b.c')
    await expect(page.getByRole('alert')).toContainText('The audit log could not be written, so nothing was changed.')
    await expect(page.getByText('No markings yet.')).toBeVisible()
    await page.getByLabel('Applies to', { exact: true }).first().selectOption('one')
    await page.getByLabel('Connection (host:port)').fill('has space')
    await addMarking(page, 'a.b.c')
    await expect(page.getByRole('alert')).toContainText('That is not a connection.')
  })

  test('every change asks for a second-factor confirmation; cancelling changes nothing', async ({ page }) => {
    await adminPage(page, 'alice', '')
    await addMarking(page, 'a.b.c')
    await dialog(page, 'Confirm it is you').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('No markings yet.')).toBeVisible()
    await addMarking(page, 'a.b.c')
    await stepUp(page)
    await expect(marks(page).getByRole('listitem')).toHaveCount(1)
  })

  test('without a store nothing can be saved and the page says why', async ({ page }) => {
    await adminPage(page, 'alice', 'step-up-off,stateless')
    await expect(page.getByText('This installation keeps no store, so markings can only be set in the environment')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add marking' })).toHaveCount(0)
  })
})

test.describe('suggestions', () => {
  test('need a connection', async ({ page }) => {
    await adminPage(page)
    await expect(page.getByRole('button', { name: 'Look at the current connection' })).toBeDisabled()
    await expect(page.getByText('Open a database connection first')).toBeVisible()
  })

  test('with a connection they list columns to pick; marking them adds the markings', async ({ page }) => {
    await page.route(/_serverFn/, (route) => route.abort())
    await openMock(page, 'login')
    await signInAs(page, 'alice')
    await page.getByRole('tab', { name: 'Type credentials' }).click()
    await page.getByLabel('Host').fill('db.example.org')
    await page.getByLabel('Database user').fill('app')
    await page.getByLabel('Database password').fill('secret')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 })
    await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, 'step-up-off'])
    await page.goto('/admin/assistant?authMock=login')
    await page.getByRole('button', { name: 'Look at the current connection' }).click()
    const list = page.getByRole('list', { name: 'Suggested columns' })
    await expect(list.getByRole('listitem')).toHaveCount(4)
    await expect(list).toContainText('shop.customers.first_name')
    await expect(list).toContainText('looks like a person')
    await page.getByLabel('Mark shop.customers.first_name').check()
    await page.getByLabel('Mark shop.orders.shipping_address').check()
    await page.getByRole('button', { name: 'Mark selected' }).click()
    await expect(page.getByRole('status').filter({ hasText: '2 markings added.' })).toBeVisible()
    await expect(marks(page).getByRole('listitem')).toHaveCount(2)
    await expect(list.getByRole('listitem')).toHaveCount(2)
  })

  test('nothing to suggest is said plainly', async ({ page }) => {
    await page.route(/_serverFn/, (route) => route.abort())
    await openMock(page, 'login')
    await signInAs(page, 'alice')
    await page.getByRole('tab', { name: 'Type credentials' }).click()
    await page.getByLabel('Host').fill('db.example.org')
    await page.getByLabel('Database user').fill('app')
    await page.getByLabel('Database password').fill('secret')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({ timeout: 10_000 })
    await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, 'step-up-off,assistant-suggest-empty'])
    await page.goto('/admin/assistant?authMock=login')
    await page.getByRole('button', { name: 'Look at the current connection' }).click()
    await expect(page.getByText('No column names look like personal data, or they are marked already.')).toBeVisible()
  })
})

test.describe('no personal data', () => {
  test('say it for a connection, see who and when, take it back', async ({ page }) => {
    await adminPage(page)
    await expect(page.getByText('No connection is declared free of personal data.')).toBeVisible()
    await page.getByLabel('Applies to', { exact: true }).first().selectOption('one')
    await page.getByLabel('Connection (host:port)').fill('db.example.org:3306')
    await page.getByRole('button', { name: 'There is no personal data here' }).click()
    const list = page.getByRole('list', { name: 'Connections declared free of personal data' })
    await expect(list).toContainText('db.example.org:3306')
    await expect(page.getByRole('button', { name: 'There is no personal data here' })).toBeDisabled()
    await page.getByRole('button', { name: 'Remove statement: db.example.org:3306' }).click()
    await expect(page.getByText('No connection is declared free of personal data.')).toBeVisible()
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })
    test('page, lists, forms and messages are accessible', async ({ page }) => {
      await adminPage(page, 'alice', 'step-up-off,assistant-endpoint-problem')
      await clean(page)
      await addMarking(page, 'shop.customers.email')
      await expect(marks(page).getByRole('listitem')).toHaveCount(1)
      await addMarking(page, 'email')
      await expect(page.getByRole('alert')).toBeVisible()
      await page.getByLabel('Applies to', { exact: true }).first().selectOption('one')
      await page.getByLabel('Connection (host:port)').fill('db.example.org:3306')
      await page.getByRole('button', { name: 'There is no personal data here' }).click()
      await expect(page.getByRole('list', { name: 'Connections declared free of personal data' })).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })
  test('no horizontal scroll with long rules and targets', async ({ page }) => {
    await adminPage(page, 'alice', 'step-up-off,assistant-endpoint-problem')
    await page.getByLabel('Applies to', { exact: true }).first().selectOption('one')
    await page.getByLabel('Connection (host:port)').fill(`${'host'.repeat(30)}.example.org:3306`)
    await addMarking(page, `${'database'.repeat(5)}.${'table'.repeat(5)}.${'column'.repeat(5)}`)
    await page.getByRole('button', { name: 'There is no personal data here' }).click()
    await noOverflow(page)
  })
})
