import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-037, SCN-038 and SCN-040 of SPEC/24: insert, inline edit, delete. */

test.describe('rows: insert, inline edit, delete', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
  })

  test('SCN-037 insert: nothing runs before Go, real id is shown, duplicate rolls back', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('Ada')
    await dialog.getByRole('textbox', { name: 'email', exact: true }).fill('ada@example.test')
    await dialog.getByRole('button', { name: 'Show SQL' }).click()
    await expect(dialog.getByText(/INSERT INTO/).first()).toBeVisible()
    await page.getByRole('dialog').last().getByRole('button', { name: 'Close' }).click()
    expect(
      await scratch.q(`SELECT id FROM ${table} WHERE email = 'ada@example.test'`),
    ).toHaveLength(0)

    await dialog.getByRole('button', { name: 'Go' }).last().click()
    await expect(page.getByText(/Inserted 1 row/)).toBeVisible()
    const rows = await scratch.q<{ id: number; note: string | null }>(
      `SELECT id, note FROM ${table} WHERE email = 'ada@example.test'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.note).toBeNull()
    await expect(page.getByText(String(rows[0]?.id)).first()).toBeVisible()
  })

  test('SCN-037 duplicate email: server error shown, form keeps values, nothing inserted', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('Dup')
    await dialog.getByRole('textbox', { name: 'email', exact: true }).fill('c1@example.test')
    await dialog.getByRole('button', { name: 'Go' }).last().click()
    await expect(page.getByText(/1062|Duplicate entry/).first()).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('Dup')
    expect(await scratch.q(`SELECT id FROM ${table} WHERE name = 'Dup'`)).toHaveLength(0)
  })

  test('SCN-038 inline edit: Enter saves one column, Esc cancels', async ({ page, scratch }) => {
    const table = `\`${scratch.name}\`.customer`
    const cell = gridRow(page, 'customer 1').getByRole('gridcell').filter({ hasText: 'customer 1' })
    await cell.dblclick()
    const editor = page.getByRole('textbox').last()
    await editor.fill('renamed')
    await page.keyboard.press('Enter')
    await expect(gridRow(page, 'renamed')).toBeVisible()
    await expect(page.locator('code')).toContainText('UPDATE')
    const [row] = await scratch.q<{ name: string }>(`SELECT name FROM ${table} WHERE id = 1`)
    expect(row?.name).toBe('renamed')

    await gridRow(page, 'customer 2')
      .getByRole('gridcell')
      .filter({ hasText: 'customer 2' })
      .dblclick()
    await page.getByRole('textbox').last().fill('never saved')
    await page.keyboard.press('Escape')
    await expect(gridRow(page, 'customer 2')).toBeVisible()
    const [row2] = await scratch.q<{ name: string }>(`SELECT name FROM ${table} WHERE id = 2`)
    expect(row2?.name).toBe('customer 2')
  })

  test('SCN-038 inline edit to a duplicate email: server error, cell reverts', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    await gridRow(page, 'c2@example.test')
      .getByRole('gridcell')
      .filter({ hasText: 'c2@example.test' })
      .dblclick()
    await page.getByRole('textbox').last().fill('c1@example.test')
    await page.keyboard.press('Enter')
    await expect(page.getByText(/1062|Duplicate entry/).first()).toBeVisible()
    const [row] = await scratch.q<{ email: string }>(`SELECT email FROM ${table} WHERE id = 2`)
    expect(row?.email).toBe('c2@example.test')
  })

  test('SCN-040 delete: confirmation shows the statement, nothing runs before confirm', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    await gridRow(page, 'customer 3').getByRole('button', { name: 'Delete row' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/DELETE FROM/).first()).toBeVisible()
    expect(await scratch.q(`SELECT id FROM ${table} WHERE id = 3`)).toHaveLength(1)
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect(gridRow(page, 'customer 3')).toHaveCount(0)
    expect(await scratch.q(`SELECT id FROM ${table} WHERE id = 3`)).toHaveLength(0)
  })
})
