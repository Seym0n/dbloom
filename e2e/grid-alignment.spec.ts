import { expect, test, type Page } from '@playwright/test'

/**
 * Cells of one row must share a text baseline, whatever their font or size. Mono numbers next to sans text
 * once sat 1-3 px higher (tailwind-merge dropped the line height of the mono cell).
 */

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server').fill('127.0.0.1:33064')
  await page.getByLabel('User name').fill('root')
  await page.getByLabel('Password').fill('root')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('heading', { name: 'Open a table' }).waitFor()
}

/** Distance from the top of each cell to its text baseline, measured with a zero-size inline probe. */
async function baselines(page: Page, cellSelector: string, rows: number): Promise<number[][]> {
  return page.evaluate(
    ({ cellSelector, rows }) =>
      [...document.querySelectorAll('tbody tr, [role=row]')]
        .filter((row) => row.querySelector(cellSelector))
        .slice(0, rows)
        .map((row) =>
          [...row.querySelectorAll(cellSelector)]
            .filter((cell) => !cell.matches('[data-rows-actions]'))
            .map((cell) => {
              const probe = document.createElement('span')
              probe.style.cssText = 'display:inline-block;width:0;height:0'
              cell.appendChild(probe)
              const y = probe.getBoundingClientRect().bottom - cell.getBoundingClientRect().top
              probe.remove()
              return Math.round(y * 2) / 2
            }),
        ),
    { cellSelector, rows },
  )
}

function expectLevel(rows: number[][]) {
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) expect(new Set(row).size, `baselines ${JSON.stringify(row)}`).toBe(1)
}

test('table view: numbers, dates and text share a baseline', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'e2e_shop', exact: true }).click()
  await page.getByRole('button', { name: 'orders', exact: true }).click()
  await expect(page.getByText('Rows 1–50')).toBeVisible()
  expectLevel(await baselines(page, 'td', 3))
})

test('SQL result grid: numbers, dates and text share a baseline', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'SQL', exact: true }).first().click()
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT id, customer, amount, placed_at FROM e2e_shop.orders LIMIT 5')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('[role=gridcell]').first()).toBeVisible()
  expectLevel(await baselines(page, '[role=gridcell]', 3))
})

/** Baseline of each element's text, relative to the top of the strip that holds them. */
async function stripBaselines(page: Page, labelText: string, targets: string[]): Promise<number[]> {
  return page.evaluate(
    ({ labelText, targets }) => {
      const label = [...document.querySelectorAll('span')].find((s) => s.textContent === labelText)!
      const strip = label.parentElement!
      const top = strip.getBoundingClientRect().top
      const baseline = (el: Element) => {
        const probe = document.createElement('span')
        probe.style.cssText = 'display:inline-block;width:0;height:0'
        el.appendChild(probe)
        const y = probe.getBoundingClientRect().bottom - top
        probe.remove()
        return Math.round(y * 2) / 2
      }
      return [label, ...targets.map((sel) => strip.querySelector(sel)!)].map(baseline)
    },
    { labelText, targets },
  )
}

test('table view: the "SQL that ran" strip shares one baseline', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'e2e_shop', exact: true }).click()
  await page.getByRole('button', { name: 'orders', exact: true }).click()
  await expect(page.getByText('SQL that ran')).toBeVisible()
  const [label, code, button] = await stripBaselines(page, 'SQL that ran', ['code', 'button'])
  expect([label, code, button], 'label, code, copy button').toEqual([label, label, label])
})

test('SQL tab: the "SQL that ran" label sits on the statement baseline', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'SQL', exact: true }).first().click()
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT id, customer FROM e2e_shop.orders LIMIT 5')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByText('SQL that ran')).toBeVisible()
  const [label, line] = await stripBaselines(page, 'SQL that ran', ['.cm-line'])
  expect([label, line], 'label, statement').toEqual([label, label])
})
