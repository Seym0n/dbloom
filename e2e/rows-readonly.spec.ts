import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-042 of SPEC/24 against the server started with DBLOOM_READ_ONLY=true (port 3101). */

test.describe('SCN-042 rows on a read-only connection', () => {
  test.use({ baseURL: 'http://localhost:3101' })

  test('reading works, every write control is off with the reason, nothing changes', async ({
    page,
    scratch,
    address,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await expect(gridRow(page, 'customer 1')).toBeVisible()

    const off = async (name: string | RegExp) => {
      const button = page.getByRole('button', { name }).first()
      await expect(button).toBeDisabled()
      await expect(button).toHaveAttribute('title', 'This connection is read-only')
    }
    await off(/^Insert — /)
    await off(/^Edit selected/)
    await off(/^Delete selected/)
    const row = gridRow(page, 'customer 1')
    await off(/^Edit row — /)
    await expect(row.getByRole('button', { name: 'Copy row' })).toBeDisabled()
    await expect(row.getByRole('button', { name: 'Delete row' })).toBeDisabled()

    // Inline editing does not start.
    await row.getByRole('gridcell').filter({ hasText: 'customer 1' }).dblclick()
    await page.keyboard.press('F2')
    await expect(page.getByRole('textbox', { name: /customer 1/ })).toHaveCount(0)

    expect(await scratch.q(`SELECT name FROM ${table} ORDER BY id`)).toEqual([
      { name: 'customer 1' },
      { name: 'customer 2' },
      { name: 'customer 3' },
    ])
  })
})
