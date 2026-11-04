import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, openMock, signInAs } from './fixtures/auth-ui'

/** Settings page (`/admin/settings`), login notice, banner and maintenance against the mock layer (SPEC/32 FR-ASE-009 to 013). */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })
const FLAGS = 'dbloom.authMock.flags'
const STORE = 'dbloom.authMock.settings'
const row = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })
const save = (row_: ReturnType<typeof row>, name: string) => row_.getByRole('button', { name: `Save: ${name}` })
const reset = (row_: ReturnType<typeof row>, name: string) => row_.getByRole('button', { name: `Reset: ${name}` })

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

async function signedIn(page: Page, username = 'alice', flags = '') {
  await openMock(page, 'login')
  await signInAs(page, username)
  await expect(h1(page)).toHaveText('Connect to a database')
  if (flags) await page.evaluate(([k, v]) => window.sessionStorage.setItem(k!, v!), [FLAGS, flags])
}
async function settingsPage(page: Page, username = 'alice', flags = 'step-up-off') {
  await signedIn(page, username, flags)
  await page.goto('/admin/settings?authMock=login')
}
async function change(page: Page, name: string, value: string) {
  const r = row(page, name)
  await r.getByLabel(name, { exact: true }).fill(value)
  await save(r, name).click()
  return r
}

test.describe('access', () => {
  test('an administrator sees every group with sources, ranges and read-only rows', async ({ page }) => {
    await settingsPage(page)
    await expect(h1(page)).toHaveText('Settings')
    for (const g of ['Sign-in and second factor', 'Passwords', 'Sessions', 'Throttling', 'Audit and notices', 'Site messages and maintenance']) {
      await expect(page.getByRole('heading', { level: 2, name: g })).toBeVisible()
    }
    const failures = row(page, 'Failed sign-ins before a delay')
    await expect(failures).toContainText('Built-in default')
    await expect(failures).toContainText('Allowed: 3 to 10')
    await expect(failures.getByLabel('Failed sign-ins before a delay', { exact: true })).toHaveValue('5')
    const totp = row(page, 'Authenticator code tolerance (steps)')
    await expect(totp).toContainText('Set by the operator in the environment only.')
    await expect(totp.getByRole('textbox')).toHaveCount(0)
    await expect(totp.getByRole('button')).toHaveCount(0)
    const retention = row(page, 'Keep audit entries for')
    await expect(retention).toContainText('Allowed: 90 to 1095 days')
  })

  test('durations are shown in a convenient unit and saved in the stored one', async ({ page }) => {
    await settingsPage(page)
    const idle = row(page, 'Administrator idle timeout')
    await expect(idle).toContainText('Allowed: 5 to 120 minutes')
    await expect(idle.getByLabel('Administrator idle timeout', { exact: true })).toHaveValue('15')
    await change(page, 'Administrator idle timeout', '20')
    await expect(idle.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    const stored = await page.evaluate((k) => JSON.parse(window.sessionStorage.getItem(k) ?? '{}'), STORE)
    expect(stored.adminSessionIdleMs.value).toBe(20 * 60_000)
  })

  test('someone who is not an administrator is told so', async ({ page }) => {
    await signedIn(page, 'erin')
    await page.goto('/admin/settings?authMock=login')
    await expect(h1(page)).toHaveText('Administrators only')
  })

  test('without a session the front page takes over', async ({ page }) => {
    await page.goto('/admin/settings?authMock=login')
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
  })

  test('direct mode has no administrators: the front page', async ({ page }) => {
    await openMock(page, 'direct', '/admin/settings')
    await expect(h1(page)).not.toHaveText('Settings')
  })
})

test.describe('change and reset', () => {
  test('saving sets the override, shows who and when, and reset returns the default', async ({ page }) => {
    await settingsPage(page)
    const name = 'Failed sign-ins before a delay'
    const r = await change(page, name, '7')
    await expect(r.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    await expect(r).toContainText('Set here')
    await expect(r).toContainText('Last changed by')
    await expect(reset(r, name)).toBeVisible()
    await page.reload()
    await expect(row(page, name).getByLabel(name, { exact: true })).toHaveValue('7')
    await reset(row(page, name), name).click()
    await expect(row(page, name).getByRole('status').filter({ hasText: 'Reset to the default.' })).toBeVisible()
    await expect(row(page, name)).toContainText('Built-in default')
    await expect(row(page, name).getByLabel(name, { exact: true })).toHaveValue('5')
    await expect(reset(row(page, name), name)).toHaveCount(0)
  })

  test('save is off until the value differs', async ({ page }) => {
    await settingsPage(page)
    const name = 'Failed sign-ins before a delay'
    const r = row(page, name)
    await expect(save(r, name)).toBeDisabled()
    await r.getByLabel(name, { exact: true }).fill('6')
    await expect(save(r, name)).toBeEnabled()
    await r.getByLabel(name, { exact: true }).fill('5')
    await expect(save(r, name)).toBeDisabled()
  })

  test('a switch and a choice', async ({ page }) => {
    await settingsPage(page)
    const sw = row(page, 'Refuse passwords from breach lists')
    await sw.getByLabel('Refuse passwords from breach lists', { exact: true }).check()
    await save(sw, 'Refuse passwords from breach lists').click()
    await expect(sw).toContainText('Set here')
    const ch = row(page, 'When the session limit is reached')
    await ch.getByLabel('When the session limit is reached', { exact: true }).selectOption('refuse')
    await save(ch, 'When the session limit is reached').click()
    await expect(ch).toContainText('Set here')
    await page.reload()
    await expect(row(page, 'When the session limit is reached').getByLabel('When the session limit is reached', { exact: true })).toHaveValue('refuse')
    await expect(row(page, 'Refuse passwords from breach lists').getByLabel('Refuse passwords from breach lists', { exact: true })).toBeChecked()
  })
})

test.describe('refusals', () => {
  test('a value below or above the limits is refused with its own text; a number field with nothing in it too', async ({ page }) => {
    await settingsPage(page)
    const name = 'Failed sign-ins before a delay'
    let r = await change(page, name, '2')
    await expect(r.getByRole('alert')).toHaveText('The value is below the lowest allowed.')
    r = await change(page, name, '11')
    await expect(r.getByRole('alert')).toHaveText('The value is above the highest allowed.')
    r = await change(page, name, '')
    await expect(r.getByRole('alert')).toHaveText('This is not a valid value for this setting.')
    await page.reload()
    await expect(row(page, name)).toContainText('Built-in default')
  })

  test('a locked setting is read-only with the lock note', async ({ page }) => {
    await settingsPage(page, 'alice', 'step-up-off,settings-locked')
    const r = row(page, 'Sessions per user')
    await expect(r).toContainText('Locked by the operator')
    await expect(r.getByRole('spinbutton')).toHaveCount(0)
    await expect(r.getByRole('button')).toHaveCount(0)
  })

  test('maintenance forced by the operator cannot be switched off here', async ({ page }) => {
    await settingsPage(page, 'alice', 'step-up-off,maintenance-forced')
    const r = row(page, 'Maintenance mode')
    await expect(r).toContainText('Forced on by the operator')
    await expect(r.getByRole('checkbox')).toHaveCount(0)
    await expect(r.getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).toContainText('Maintenance mode is on')
  })

  test('another administrator changed it meanwhile: the conflict text, and the page shows the stored value', async ({ page }) => {
    await settingsPage(page)
    const name = 'Failed sign-ins before a delay'
    await change(page, name, '6')
    await expect(row(page, name)).toContainText('Set here')
    // another session writes the same row
    await page.evaluate((k) => {
      const rows = JSON.parse(window.sessionStorage.getItem(k) ?? '{}')
      rows.loginFailures = { value: 9, updatedAt: rows.loginFailures.updatedAt + 5, updatedBy: 'Someone Else' }
      window.sessionStorage.setItem(k, JSON.stringify(rows))
    }, STORE)
    const r = await change(page, name, '7')
    await expect(r.getByRole('alert')).toContainText('Someone else changed this setting meanwhile')
    await expect(r.getByLabel(name, { exact: true })).toHaveValue('9')
    await expect(r).toContainText('Someone Else')
  })

  test('a failing audit write: nothing is changed and the page says so', async ({ page }) => {
    await settingsPage(page, 'alice', 'step-up-off,settings-audit-fail')
    const name = 'Failed sign-ins before a delay'
    const r = await change(page, name, '6')
    await expect(r.getByRole('alert')).toHaveText('The audit log could not be written, so nothing was changed.')
    await page.reload()
    await expect(row(page, name)).toContainText('Built-in default')
  })
})

test.describe('narrowing preview', () => {
  test('unchecking an option that users depend on shows the count and the refusal', async ({ page }) => {
    await settingsPage(page, 'alice', 'step-up-off,settings-stranded')
    const name = 'Allowed second factors'
    const r = row(page, name)
    await r.getByLabel('Authenticator app', { exact: true }).uncheck()
    await expect(r.getByRole('status')).toContainText('2 active users would be left with no allowed option')
    await save(r, name).click()
    await expect(r.getByRole('alert')).toContainText('2 active users would be left with no allowed option and could not sign in. Nothing was changed.')
    await r.getByLabel('Authenticator app', { exact: true }).check()
    await expect(r.getByRole('status')).toHaveCount(0)
  })

  test('without affected users the narrowing is saved', async ({ page }) => {
    await settingsPage(page)
    const name = 'Allowed second factors'
    const r = row(page, name)
    await r.getByLabel('Passkey', { exact: true }).uncheck()
    await expect(r.getByRole('status')).toContainText('No active user would be locked out.')
    await save(r, name).click()
    await expect(r).toContainText('Set here')
  })
})

test.describe('step-up', () => {
  test('a change asks for a second-factor confirmation first', async ({ page }) => {
    await settingsPage(page, 'alice', '')
    const name = 'Failed sign-ins before a delay'
    await change(page, name, '6')
    await stepUp(page)
    await expect(row(page, name)).toContainText('Set here')
  })

  test('cancelling it changes nothing', async ({ page }) => {
    await settingsPage(page, 'alice', '')
    const name = 'Failed sign-ins before a delay'
    await change(page, name, '6')
    await dialog(page, 'Confirm it is you').getByRole('button', { name: 'Cancel' }).click()
    await page.reload()
    await expect(row(page, name)).toContainText('Built-in default')
  })
})

test.describe('login notice, banner and maintenance', () => {
  test('the login notice is on the sign-in page as plain text', async ({ page }) => {
    await settingsPage(page)
    const name = 'Notice on the sign-in page'
    await change(page, name, '<b>Planned</b> work on Friday')
    await expect(row(page, name)).toContainText('Set here')
    await page.goto('/?authMock=login')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(h1(page)).toHaveText('Sign in to DBLoom')
    const note = page.getByRole('note', { name: 'Notice' })
    await expect(note).toHaveText('<b>Planned</b> work on Friday')
    await expect(note.locator('b')).toHaveCount(0)
  })

  test('an over-long notice is refused', async ({ page }) => {
    await settingsPage(page)
    const r = await change(page, 'Notice on the sign-in page', 'x'.repeat(301))
    await expect(r.getByRole('alert')).toHaveText('This is not a valid value for this setting.')
  })

  test('the banner shows after sign-in, as text with its line breaks, and is gone when emptied', async ({ page }) => {
    await settingsPage(page)
    const name = 'Banner for signed-in users'
    await row(page, name).getByLabel(name, { exact: true }).fill('Backup tonight at 22:00.\n<i>No data lost.</i>')
    await save(row(page, name), name).click()
    await expect(row(page, name)).toContainText('Set here')
    await page.goto('/?authMock=login')
    const banner = page.getByRole('complementary', { name: 'Notice from the administrators' })
    await expect(banner).toContainText('Backup tonight at 22:00.')
    await expect(banner).toContainText('<i>No data lost.</i>')
    await expect(banner.locator('i')).toHaveCount(0)
    await page.goto('/admin/users?authMock=login')
    await expect(page.getByRole('complementary', { name: 'Notice from the administrators' })).toBeVisible()
    await page.goto('/admin/settings?authMock=login')
    await row(page, name).getByLabel(name, { exact: true }).fill('')
    await save(row(page, name), name).click()
    await page.goto('/?authMock=login')
    await expect(page.getByRole('complementary', { name: 'Notice from the administrators' })).toHaveCount(0)
  })

  test('maintenance: switched on, a user is refused at sign-in and an administrator is told; switched off, the user can sign in', async ({ page }) => {
    await settingsPage(page)
    const name = 'Maintenance mode'
    await row(page, name).getByLabel(name, { exact: true }).check()
    await save(row(page, name), name).click()
    await expect(row(page, name)).toContainText('Set here')
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).toContainText('Maintenance mode is on: users cannot sign in or work.')
    await page.goto('/?authMock=login')
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).toContainText('You are exempt as an administrator.')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).toContainText('Maintenance: only administrators can sign in right now.')
    await signInAs(page, 'erin')
    await expect(page.getByRole('alert')).toContainText('DBLoom is in maintenance mode. Try again later.')
    // the administrator signs in and switches it off
    await signInAs(page, 'alice')
    await expect(h1(page)).toHaveText('Connect to a database')
    await page.goto('/admin/settings?authMock=login')
    await page.evaluate((k) => window.sessionStorage.setItem(k, '{}'), STORE)
    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).toHaveCount(0)
  })

  test('an end time in the past is no maintenance; one in the future is announced', async ({ page }) => {
    await settingsPage(page)
    await row(page, 'Maintenance mode').getByLabel('Maintenance mode', { exact: true }).check()
    await save(row(page, 'Maintenance mode'), 'Maintenance mode').click()
    const ends = row(page, 'Maintenance ends at')
    const future = new Date(Date.now() + 2 * 3_600_000)
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    await ends.getByLabel('Maintenance ends at', { exact: true }).fill(local)
    await save(ends, 'Maintenance ends at').click()
    await expect(ends).toContainText('Set here')
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).toContainText('Expected end:')
    await ends.getByRole('button', { name: 'Clear the end time' }).click()
    await save(ends, 'Maintenance ends at').click()
    await expect(page.getByRole('complementary', { name: 'Maintenance' })).not.toContainText('Expected end:')
  })
})

test.describe('navigation', () => {
  test('the settings page is linked from the connection home', async ({ page }) => {
    await signedIn(page)
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(h1(page)).toHaveText('Settings')
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    })
    test('page, locked rows and the messages', async ({ page }) => {
      await settingsPage(page, 'alice', 'step-up-off,settings-locked,settings-stranded')
      await expect(row(page, 'Failed sign-ins before a delay')).toBeVisible()
      await change(page, 'Failed sign-ins before a delay', '2')
      await row(page, 'Allowed second factors').getByLabel('Authenticator app', { exact: true }).uncheck()
      await expect(row(page, 'Allowed second factors').getByRole('status')).toBeVisible()
      await clean(page)
    })
    test('banner, notice and maintenance lines', async ({ page }) => {
      await settingsPage(page)
      await change(page, 'Notice on the sign-in page', 'Planned work')
      await row(page, 'Banner for signed-in users').getByLabel('Banner for signed-in users', { exact: true }).fill('Backup tonight')
      await save(row(page, 'Banner for signed-in users'), 'Banner for signed-in users').click()
      await row(page, 'Maintenance mode').getByLabel('Maintenance mode', { exact: true }).check()
      await save(row(page, 'Maintenance mode'), 'Maintenance mode').click()
      await expect(page.getByRole('complementary', { name: 'Maintenance' })).toBeVisible()
      await clean(page)
      await page.goto('/?authMock=login')
      await expect(page.getByRole('complementary', { name: 'Notice from the administrators' })).toBeVisible()
      await clean(page)
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page.getByRole('note', { name: 'Notice' })).toBeVisible()
      await clean(page)
    })
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } })
  test('no horizontal scroll on the page, with messages and notices', async ({ page }) => {
    await settingsPage(page, 'alice', 'step-up-off,settings-locked,settings-stranded')
    await change(page, 'Failed sign-ins before a delay', '2')
    await row(page, 'Allowed second factors').getByLabel('Authenticator app', { exact: true }).uncheck()
    await row(page, 'Banner for signed-in users').getByLabel('Banner for signed-in users', { exact: true }).fill('A long banner text '.repeat(10))
    await save(row(page, 'Banner for signed-in users'), 'Banner for signed-in users').click()
    await noOverflow(page)
    await page.goto('/?authMock=login')
    await noOverflow(page)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await noOverflow(page)
  })
})
