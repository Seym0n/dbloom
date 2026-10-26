import { expect, signIn, test } from './fixtures/scratch-db'
import { openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-046 of SPEC/24: filter builder, table search, hex search, page-local find. */

const names = ['Ann Lee', 'Joanna Ray', 'Bob Stone', 'Cy 100% Real', 'Cy 100x Real', "O'Brien"]

async function seedNamed(scratch: Parameters<typeof seedRowsCustomer>[0]) {
  await seedRowsCustomer(scratch, 0)
  const t = `\`${scratch.name}\`.customer`
  await scratch.q(`INSERT INTO ${t} (name, email, note) VALUES ?`, [
    names.map((n, i) => [n, `n${i}@example.test`, i % 2 === 0 ? null : `note ${i}`]),
  ])
}

test.describe('SCN-046 filter and search', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedNamed(scratch)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
  })

  test('filter builder: any-of, unary operator hides the value, result matches SQL, survives refresh', async ({
    page,
    scratch,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    await page
      .getByRole('button', { name: /^Filter/ })
      .first()
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox', { name: 'How the conditions combine' }).selectOption({
      label: 'any of these (or)',
    })
    await dialog.getByRole('combobox', { name: 'Column of condition 1' }).selectOption('name')
    await dialog.getByRole('combobox', { name: 'Operator of condition 1' }).selectOption({
      label: 'contains',
    })
    await dialog.getByRole('textbox', { name: 'Value of condition 1' }).fill('ann')
    await dialog.getByRole('button', { name: 'Add condition' }).click()
    await dialog.getByRole('combobox', { name: 'Column of condition 2' }).selectOption('note')
    await dialog.getByRole('combobox', { name: 'Operator of condition 2' }).selectOption({
      label: 'is NULL',
    })
    await expect(dialog.getByRole('textbox', { name: 'Value of condition 2' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(dialog).toBeHidden()

    const expected = await scratch.q<{ name: string }>(
      `SELECT name FROM ${t} WHERE name LIKE '%ann%' OR note IS NULL ORDER BY id`,
    )
    expect(expected.length).toBeGreaterThan(0)
    const grid = page.getByRole('grid')
    await expect(grid.getByRole('row')).toHaveCount(expected.length + 1)
    for (const { name } of expected)
      await expect(grid.getByText(name, { exact: true })).toBeVisible()
    await expect(grid.getByText('Cy 100% Real')).toHaveCount(0)

    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(grid.getByRole('row')).toHaveCount(expected.length + 1)
    await expect(page.locator('code')).toContainText('WHERE')
  })

  test('quick search: injection text is plain text, LIKE wildcards match literally', async ({
    page,
    scratch,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    const search = page.getByRole('searchbox', { name: 'Search in table' })
    await search.fill("o'brien; DROP TABLE customer; --")
    await search.press('Enter')
    await expect(page.getByText('Searching the table for')).toBeVisible()
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${t}`)).toEqual([{ n: names.length }])

    await search.fill('100%')
    await search.press('Enter')
    const grid = page.getByRole('grid')
    await expect(grid.getByText('Cy 100% Real')).toBeVisible()
    await expect(grid.getByText('Cy 100x Real')).toHaveCount(0)
  })

  test('find on this page is page-local with a live count', async ({ page }) => {
    await page.getByRole('searchbox', { name: 'Find on this page' }).fill('cy 100')
    await expect(page.getByText(`2 of ${names.length} rows on this page`)).toBeVisible()
    await page.getByRole('searchbox', { name: 'Find on this page' }).fill('zzz')
    await expect(page.getByText('No row on this page matches.')).toBeVisible()
  })
})

test('SCN-046 hex search finds a BINARY(4) value shown as 0x7F000001', async ({
  page,
  scratch,
  address,
}) => {
  const db = `\`${scratch.name}\``
  await scratch.q(`CREATE TABLE ${db}.hosts (id INT PRIMARY KEY, ip BINARY(4) NOT NULL)`)
  await scratch.q(`INSERT INTO ${db}.hosts VALUES (1, 0x7F000001), (2, 0x0A000001)`)
  await signIn(page, address)
  await openTable(page, scratch.name, 'hosts')
  await page.getByRole('searchbox', { name: 'Search in table' }).fill('0x7F000001')
  await page.getByRole('searchbox', { name: 'Search in table' }).press('Enter')
  const grid = page.getByRole('grid')
  await expect(grid.getByText('0x7F000001')).toBeVisible()
  await expect(grid.getByText('0x0A000001')).toHaveCount(0)
})
