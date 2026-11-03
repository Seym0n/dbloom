import { expect, test } from '@playwright/test'

// FR-SVR-018: the `__Host-` session cookie survives Traefik and a real browser accepts it on https://dbloom.test.
test('direct login through Traefik sets an accepted __Host- cookie and keeps the session', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Server').fill('mysql:3306')
  await page.getByLabel('User name').fill('root')
  await page.getByLabel('Password').fill('root')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Databases' })).toBeVisible()

  const cookie = (await page.context().cookies()).find((c) => c.name === '__Host-dbloom-session')
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/', domain: 'dbloom.test' })

  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Databases' })).toBeVisible()
})
