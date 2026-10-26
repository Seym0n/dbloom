import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-041 of SPEC/24: bulk delete and bulk edit of selected rows. */

test.describe('rows: bulk delete and edit', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 15)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
  })

  const check = (page: import('@playwright/test').Page, n: number) =>
    page.getByRole('checkbox', { name: `Select row ${n}`, exact: true })

  test('shift-click extends the selection; bulk delete needs the table name', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    await check(page, 1).check()
    await check(page, 12).click({ modifiers: ['Shift'] })
    await expect(page.getByRole('button', { name: 'Delete selected (12)' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Select all rows/ })).toHaveJSProperty(
      'indeterminate',
      true,
    )
    await page.getByRole('button', { name: 'Delete selected (12)' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('12 rows.')).toBeVisible()
    const confirm = dialog.getByRole('button', { name: 'Delete 12 rows' })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: /Type customer to confirm/ }).fill('customer')
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 15 }])
    await confirm.click()
    await expect(dialog).toBeHidden()
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 3 }])
  })

  test('bulk edit sets one column on every selected row', async ({ page, scratch }) => {
    const table = `\`${scratch.name}\`.customer`
    for (const n of [1, 2, 3, 4]) await check(page, n).check()
    await page.getByRole('button', { name: 'Edit selected (4)' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('checkbox', { name: 'flag', exact: true }).check()
    await dialog.getByRole('textbox', { name: 'flag', exact: true }).fill('1')
    await dialog.getByRole('button', { name: 'Save' }).click()
    // Soft class: the confirmation names the rows it will change.
    await page.getByRole('button', { name: 'Update 4 rows' }).click()
    await expect(async () => {
      const rows = await scratch.q<{ flag: number }>(`SELECT flag FROM ${table} WHERE id <= 4`)
      expect(rows.map((r) => r.flag)).toEqual([1, 1, 1, 1])
    }).toPass({ timeout: 8000 })
    const [others] = await scratch.q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE flag = 1`,
    )
    expect(others?.n).toBe(4)
  })

  test('a row changed by another session rolls the whole bulk delete back', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    for (const n of [1, 2, 3]) await check(page, n).check()
    await page.getByRole('button', { name: 'Delete selected (3)' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: /Type customer to confirm/ }).fill('customer')
    await scratch.q(`UPDATE ${table} SET name = 'changed elsewhere' WHERE id = 2`)
    await dialog.getByRole('button', { name: 'Delete 3 rows' }).click()
    await expect(page.getByText(/changed by someone else|conflict/i).first()).toBeVisible()
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 15 }])
    void gridRow
  })
})
