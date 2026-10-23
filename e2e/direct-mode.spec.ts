import { expect, test, type Page } from '@playwright/test'

const LOGIN_FAILED = 'Sign-in failed. Check the server, user name and password.'
const COOKIE = '__Host-dbloom-session'

async function signIn(page: Page, server = '127.0.0.1:33064', password = 'root') {
  await page.goto('/')
  await page.getByLabel('Server').fill(server)
  await page.getByLabel('User name').fill('root')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.describe('SCN-004 log in directly to a target', () => {
  test('login page names direct mode', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to a database server')
    await expect(page.getByText('Direct mode:')).toBeVisible()
  })

  test('wrong password and denied host give the same message', async ({ page }) => {
    await signIn(page, '127.0.0.1:33064', 'nope')
    await expect(page.getByRole('alert')).toHaveText(LOGIN_FAILED)
    await page.reload()
    await signIn(page, '169.254.169.254')
    await expect(page.getByRole('alert')).toHaveText(LOGIN_FAILED)
  })

  test('good credentials land on the database list', async ({ page }) => {
    await signIn(page)
    await expect(page.getByRole('navigation', { name: 'Databases' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'e2e_shop' })).toBeVisible()
    const session = (await page.context().cookies()).find((c) => c.name === COOKIE)
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' })
  })
})

test.describe('SCN-005 open a table', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.getByRole('button', { name: 'e2e_shop' }).click()
    await page.getByRole('button', { name: 'orders' }).click()
  })

  test('first page, sort, next page and the SQL that ran', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toContainText('orders')
    await expect(page.getByText('Rows 1–50')).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(50)

    await page.getByRole('button', { name: 'amount' }).click()
    await page.getByRole('button', { name: 'amount' }).click()
    await expect(page.getByRole('columnheader', { name: 'amount' })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    await expect(page.locator('tbody tr').first()).toContainText('882.00')
    await expect(page.locator('code')).toContainText('ORDER BY `amount` DESC LIMIT 50 OFFSET 0')

    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Rows 51–100')).toBeVisible()
    await expect(page.locator('code')).toContainText('OFFSET 50')
  })

  test('values are shown as text, binary is summarised, NULL is marked', async ({ page }) => {
    await expect(page.getByText('<script>alert(1)</script>')).toBeVisible()
    await expect(page.getByText('0xDEADBEEF')).toBeVisible()
    await expect(page.getByText('NULL').first()).toBeVisible()
  })

  test('a second table opens in its own tab; an empty table says so', async ({ page }) => {
    await page.getByRole('button', { name: 'empty_table' }).click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByText('This table has no rows.')).toBeVisible()
    await page.getByRole('button', { name: 'Close empty_table' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
  })
})

test.describe('requests and logout (SEC-TGT-042, SCN-010)', () => {
  test('no CSRF header is refused; logout kills the old cookie', async ({ page, browser }) => {
    const seen: { url: string; headers: Record<string, string>; body: string | null }[] = []
    page.on('request', (r) => {
      if (r.url().includes('/_serverFn/') && r.method() === 'POST') {
        seen.push({ url: r.url(), headers: r.headers(), body: r.postData() })
      }
    })
    await signIn(page)
    await expect(page.getByRole('button', { name: 'e2e_shop' })).toBeVisible()
    // The login call has no CSRF header yet; replay a later data call.
    await expect.poll(() => seen.some((r) => r.headers['x-dbloom-csrf'])).toBe(true)
    const { url, headers: original, body } = seen.find((r) => r.headers['x-dbloom-csrf'])!
    // Everything the browser sent except the cookie and the CSRF header.
    const headers = Object.fromEntries(
      Object.entries(original).filter(
        ([k]) => !['cookie', 'x-dbloom-csrf', 'content-length'].includes(k),
      ),
    )

    // Same cookie, no CSRF header: refused with the single "session ended" response.
    const forged = await page.request.post(url, {
      headers,
      data: body ?? undefined,
    })
    expect(await forged.text()).toContain('session_ended')

    const cookie = (await page.context().cookies()).find((c) => c.name === COOKIE)!
    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to a database server')

    const other = await browser.newContext()
    await other.addCookies([cookie])
    const reuse = await other.request.post(url, {
      headers: { ...headers, 'x-dbloom-csrf': original['x-dbloom-csrf'] ?? '' },
      data: body ?? undefined,
    })
    expect(await reuse.text()).toContain('session_ended')
    await other.close()
  })
})

test.describe('SCN-009 session ends', () => {
  test('one neutral dialog, work stays, signing in again continues', async ({ page, context }) => {
    await signIn(page)
    await page.getByRole('button', { name: 'e2e_shop' }).click()
    await page.getByRole('button', { name: 'orders' }).click()
    await expect(page.getByText('Rows 1–50')).toBeVisible()

    // Another tab of the same browser logs out: the cookie is gone for this page too.
    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: 'Log out' }).click()
    await expect(other.getByRole('heading', { level: 1 })).toHaveText(
      'Sign in to a database server',
    )

    await page.getByRole('button', { name: 'Next' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText('Your session has ended')
    await expect(dialog).toContainText('Unsaved work on this page is kept.')
    await expect(dialog).not.toContainText('inactivity')
    // The work behind the dialog is still there.
    await expect(page.getByRole('tab', { name: 'orders' })).toBeAttached()
    await expect(dialog.getByLabel('Server')).toHaveValue('127.0.0.1:33064')

    await dialog.getByLabel('Password').fill('root')
    await dialog.getByRole('button', { name: 'Sign in' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('tab', { name: 'orders' })).toBeVisible()
    await expect(page.getByText('Rows 51–100')).toBeVisible()
  })
})
