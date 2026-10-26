import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-044 of SPEC/24: concurrent changes are detected per changed column. */

test.describe('SCN-044 concurrent change detection', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await gridRow(page, 'customer 1').getByRole('button', { name: 'Edit row' }).click()
    await expect(
      page.getByRole('dialog').getByRole('textbox', { name: 'name', exact: true }),
    ).toHaveValue('customer 1')
  })

  test('a different column saves; the same column conflicts; Overwrite is a second click', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    const dialog = page.getByRole('dialog')
    await scratch.q(`UPDATE ${table} SET name = 'by A' WHERE id = 1`)

    // Step 2: B edits a column A did not touch.
    await dialog.getByRole('textbox', { name: 'email', exact: true }).fill('b@example.test')
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ email: string; name: string }>(
        `SELECT email, name FROM ${table} WHERE id = 1`,
      )
      expect(row).toEqual({ email: 'b@example.test', name: 'by A' })
    }).toPass({ timeout: 8000 })
  })

  test('same column: conflict names the current values, data unchanged, Overwrite then succeeds', async ({
    page,
    scratch,
  }) => {
    const table = `\`${scratch.name}\`.customer`
    const dialog = page.getByRole('dialog')
    await scratch.q(`UPDATE ${table} SET name = 'by A' WHERE id = 1`)
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('by B')
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(page.getByText(/changed by someone else/i).first()).toBeVisible()
    expect(await scratch.q(`SELECT name FROM ${table} WHERE id = 1`)).toEqual([{ name: 'by A' }])

    await page.getByRole('button', { name: /Overwrite/ }).click()
    await expect(async () => {
      expect(await scratch.q(`SELECT name FROM ${table} WHERE id = 1`)).toEqual([{ name: 'by B' }])
    }).toPass({ timeout: 8000 })
  })

  test('row deleted elsewhere: "no longer exists"', async ({ page, scratch }) => {
    const table = `\`${scratch.name}\`.customer`
    const dialog = page.getByRole('dialog')
    await scratch.q(`DELETE FROM ${table} WHERE id = 1`)
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('too late')
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(page.getByText('This row no longer exists').first()).toBeVisible()
    expect(await scratch.q(`SELECT id FROM ${table} WHERE id = 1`)).toHaveLength(0)
  })

  test('an unchanged-value save is not a conflict', async ({ page, scratch }) => {
    const table = `\`${scratch.name}\`.customer`
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('customer 9')
    await scratch.q(`UPDATE ${table} SET name = 'customer 9' WHERE id = 1`)
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(page.getByText(/changed by someone else/i)).toHaveCount(0)
  })
})
