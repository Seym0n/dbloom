import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { INVITE_TOKEN, PASSWORD, openMock, signInAs } from './fixtures/auth-ui'

/** Users page (`/admin/users`) against the mock layer: list, create, roles, status, sessions, invites, recovery, delete (FR-AUT-004, 005, 015, 016, 028). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })
const row = (page: Page, username: string) => page.getByRole('list', { name: 'Users' }).getByRole('listitem').filter({ hasText: username })

async function clean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

/** Signs in as an administrator (alice) and opens the page; the mock keeps its session in this tab. */
async function usersPage(page: Page, username = 'alice') {
  await openMock(page, 'login')
  await signInAs(page, username)
  await expect(h1(page)).toHaveText('Connect to a database')
  await page.goto('/admin/users?authMock=login')
}

async function menu(page: Page, username: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${username}` }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

async function stepUp(page: Page) {
  const d = dialog(page, 'Confirm it is you')
  await d.getByLabel('Your password').fill(PASSWORD)
  await d.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(d).toBeHidden()
}

test.describe('access', () => {
  test('an administrator sees the list, the own row has no actions', async ({ page }) => {
    await usersPage(page)
    await expect(h1(page)).toHaveText('Users')
    await expect(row(page, 'alice')).toContainText('You')
    await expect(row(page, 'alice')).toContainText('Administrator')
    await expect(row(page, 'bob')).toContainText('authenticator app')
    await expect(row(page, 'alice').getByRole('combobox')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Actions for alice' })).toBeHidden()
    await expect(row(page, 'erin')).toContainText('never signed in')
  })

  test('someone who is not an administrator is told so', async ({ page }) => {
    await usersPage(page, 'erin')
    await expect(h1(page)).toHaveText('Administrators only')
  })

  test('without a session the front page takes over', async ({ page }) => {
    await page.goto('/admin/users?authMock=login')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
  })

  test('the front page links to it for an administrator', async ({ page }) => {
    await openMock(page, 'login')
    await signInAs(page, 'alice')
    await page.getByRole('link', { name: 'Users' }).click()
    await expect(h1(page)).toHaveText('Users')
    await page.getByRole('link', { name: 'Back to databases' }).click()
    await expect(h1(page)).toHaveText('Connect to a database')
  })
})

test.describe('managing users', () => {
  test.beforeEach(async ({ page }) => {
    await usersPage(page)
  })

  test('create with a generated temporary password, shown once', async ({ page }) => {
    await page.getByRole('button', { name: 'Create user' }).first().click()
    const d = dialog(page, 'Create a user')
    await d.getByLabel('User name').fill('frank')
    await d.getByLabel('Display name (optional)').fill('Frank')
    await d.getByRole('button', { name: 'Generate password' }).click()
    await d.getByRole('button', { name: 'Create user' }).click()
    const done = dialog(page, 'User created')
    const shown = await done.getByRole('list', { name: 'Temporary password' }).innerText()
    expect(shown.trim()).toMatch(/^[A-Za-z0-9]{20}$/)
    await expect(done.getByRole('button', { name: 'Done' })).toBeDisabled()
    await done.getByLabel('I passed it on').check()
    await done.getByRole('button', { name: 'Done' }).click()
    await expect(row(page, 'frank')).toContainText('Frank')
  })

  test('a weak temporary password and a taken name are refused', async ({ page }) => {
    await page.getByRole('button', { name: 'Create user' }).first().click()
    const d = dialog(page, 'Create a user')
    await d.getByLabel('User name').fill('gina')
    await d.getByLabel('Temporary password').fill('short')
    await d.getByRole('button', { name: 'Create user' }).click()
    await expect(d.getByRole('alert')).toHaveText('The password is too short.')
    await d.getByLabel('User name').fill('bob')
    await d.getByLabel('Temporary password').fill('a perfectly long password')
    await d.getByRole('button', { name: 'Create user' }).click()
    await expect(d.getByRole('alert')).toBeVisible()
  })

  test('change a role', async ({ page }) => {
    await row(page, 'erin').getByRole('combobox').selectOption('admin')
    await expect(page.getByText('Role of erin changed.')).toBeVisible()
    await expect(row(page, 'erin')).toContainText('Administrator')
  })

  test('disable, enable, end sessions', async ({ page }) => {
    await menu(page, 'bob', 'Disable account')
    await expect(page.getByText('bob is disabled and signed out.')).toBeVisible()
    await expect(row(page, 'bob')).toContainText('Disabled')
    await menu(page, 'bob', 'Enable account')
    await expect(row(page, 'bob')).not.toContainText('Disabled')
    await menu(page, 'bob', 'Sign out everywhere')
    await expect(page.getByText('Ended 2 sessions of bob.')).toBeVisible()
  })

  test('delete asks first', async ({ page }) => {
    await menu(page, 'dave', 'Delete user')
    const d = dialog(page, 'Delete dave?')
    await d.getByRole('button', { name: 'Cancel' }).click()
    await expect(row(page, 'dave')).toBeVisible()
    await menu(page, 'dave', 'Delete user')
    await dialog(page, 'Delete dave?').getByRole('button', { name: 'Delete user' }).click()
    await expect(page.getByText('dave was deleted.')).toBeVisible()
    await expect(row(page, 'dave')).toHaveCount(0)
  })

  test('recovery link: step-up first, link shown once', async ({ page }) => {
    await menu(page, 'bob', 'Issue recovery link')
    await stepUp(page)
    const d = dialog(page, 'Recovery link for bob')
    await expect(d.getByRole('list', { name: 'Link' })).toContainText('/recover#rec-')
    await expect(d.getByRole('button', { name: 'Done' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(d).toBeVisible()
    await d.getByLabel('I copied the link').check()
    await d.getByRole('button', { name: 'Done' }).click()
    await expect(d).toBeHidden()
  })

  test('invites: issue, list, revoke', async ({ page }) => {
    await expect(page.getByText('No open invites.')).toBeVisible()
    await page.getByRole('button', { name: 'Invite someone' }).click()
    const d = dialog(page, 'Invite someone')
    await d.getByLabel('Role they get').selectOption('admin')
    await d.getByLabel('Valid for').selectOption('h24')
    await d.getByRole('button', { name: 'Create invite link' }).click()
    await stepUp(page)
    const link = dialog(page, 'Invite link')
    await expect(link.getByRole('list', { name: 'Link' })).toContainText(`/invite#${INVITE_TOKEN}`)
    await link.getByLabel('I copied the link').check()
    await link.getByRole('button', { name: 'Done' }).click()
    const list = page.getByRole('list', { name: 'Open invites' })
    await expect(list).toContainText('Administrator')
    await list.getByRole('button', { name: /Revoke the invite/ }).click()
    await expect(page.getByText('No open invites.')).toBeVisible()
  })

  test('the step-up can be cancelled', async ({ page }) => {
    await menu(page, 'bob', 'Issue recovery link')
    await dialog(page, 'Confirm it is you').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('alert')).toHaveText('Confirm it is you to continue.')
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })

    test('page, menu and dialogs', async ({ page }) => {
      await usersPage(page)
      await clean(page)
      await page.getByRole('button', { name: 'Actions for bob' }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await clean(page)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Create user' }).first().click()
      await expect(dialog(page, 'Create a user')).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('no horizontal scroll on the list and the create dialog', async ({ page }) => {
    await usersPage(page)
    await noOverflow(page)
    await page.getByRole('button', { name: 'Create user' }).first().click()
    await expect(dialog(page, 'Create a user')).toBeVisible()
    await noOverflow(page)
    const box = await dialog(page, 'Create a user').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  })
})
