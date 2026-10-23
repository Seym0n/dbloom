import { test, type Page } from '@playwright/test'

// Visual review aid, not an assertion: `SHOTS=1 npx playwright test screenshots`.
test.skip(!process.env.SHOTS, 'set SHOTS=1 to take review screenshots')

const OUT = '.taste-skill/shots'
const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
]

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server').fill('127.0.0.1:33064')
  await page.getByLabel('User name').fill('root')
  await page.getByLabel('Password').fill('root')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('heading', { name: 'Open a table' }).waitFor()
}

for (const scheme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`${scheme} ${size.name}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        colorScheme: scheme,
      })
      const page = await context.newPage()
      const shot = (n: string) =>
        page.screenshot({ path: `${OUT}/${scheme}-${size.name}-${n}.png` })

      await page.goto('/')
      await shot('1-login')
      await signIn(page)
      await shot('2-empty')
      const phone = size.width < 768
      if (phone) await page.getByRole('button', { name: 'Databases' }).first().click()
      await page.getByRole('button', { name: 'e2e_shop', exact: true }).click()
      if (phone) await shot('2b-menu')
      await page.getByRole('button', { name: 'orders', exact: true }).click()
      await page.getByText('Rows 1–50').waitFor()
      await shot('3-table')
      if (!phone) {
        await page.getByRole('button', { name: 'Assistant' }).click()
        await shot('4-assistant')
      }
      await context.close()
    })
  }
}
