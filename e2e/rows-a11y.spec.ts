import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** Cross-cutting checks of module rows (SPEC/24 section 11): axe on the grid and its dialogs, storage scan. */

const scan = async (page: Page, include?: string) => {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  // The tab strip belongs to the app shell (skeleton a11y task: close buttons sit inside role=tablist).
  builder.exclude('[role=tablist]')
  if (include) builder.include(include)
  const { violations } = await builder.analyze()
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  )
}

test.describe('rows: accessibility and storage', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 5)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await expect(gridRow(page, 'customer 1')).toBeVisible()
  })

  test('axe: the grid page', async ({ page }) => {
    expect(await scan(page)).toEqual([])
  })

  test('axe: insert form, edit form, delete dialog, filter and columns', async ({ page }) => {
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    expect(await scan(page, 'dialog, [role=dialog]'), 'insert form').toEqual([])
    await page.getByRole('button', { name: 'Cancel' }).last().click()

    await gridRow(page, 'customer 1').getByRole('button', { name: 'Edit row' }).click()
    await expect(page.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('customer 1')
    expect(await scan(page, 'dialog, [role=dialog]'), 'edit form').toEqual([])
    await page.getByRole('button', { name: 'Cancel' }).last().click()

    await gridRow(page, 'customer 2').getByRole('button', { name: 'Delete row' }).click()
    await expect(
      page
        .getByRole('dialog')
        .getByText(/DELETE FROM/)
        .first(),
    ).toBeVisible()
    expect(await scan(page, 'dialog, [role=dialog]'), 'delete dialog').toEqual([])
    await page.getByRole('button', { name: 'Cancel' }).last().click()

    await page
      .getByRole('button', { name: /^Filter/ })
      .first()
      .click()
    expect(await scan(page, 'dialog, [role=dialog]'), 'filter').toEqual([])
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Columns' }).click()
    expect(await scan(page, 'dialog, [role=dialog]'), 'columns').toEqual([])
  })

  test('browser storage holds no row values, SQL or secrets', async ({ page }) => {
    await gridRow(page, 'customer 1').getByRole('button', { name: 'Edit row' }).click()
    await page.getByRole('button', { name: 'Cancel' }).last().click()
    await page.getByRole('searchbox', { name: 'Search in table' }).fill('secret-search-term')
    await page.getByRole('searchbox', { name: 'Search in table' }).press('Enter')
    const dump = await page.evaluate(async () => {
      const out: string[] = []
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i) as string
          out.push(`${k}=${store.getItem(k)}`)
        }
      }
      const dbs = (await indexedDB.databases?.()) ?? []
      out.push(...dbs.map((d) => `idb:${d.name}`))
      out.push(document.cookie)
      return out.join('\n')
    })
    for (const forbidden of [
      'customer 1',
      'c1@example.test',
      'secret-search-term',
      'SELECT ',
      'root',
    ]) {
      expect(dump, forbidden).not.toContain(forbidden)
    }
  })
})
