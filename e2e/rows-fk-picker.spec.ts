import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/** SCN-045 step 3 of SPEC/24: the foreign key picker in the edit form. */

test.describe('SCN-045 foreign key picker', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.customer (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40) NOT NULL)`,
    )
    await scratch.q(
      `CREATE TABLE ${db}.orders (id INT PRIMARY KEY, customer_id INT NOT NULL,
         CONSTRAINT fk_o FOREIGN KEY (customer_id) REFERENCES ${db}.customer (id))`,
    )
    const values = Array.from({ length: 60 }, (_, i) => `(${i + 1}, 'Cust ${i + 1}')`).join(',')
    await scratch.q(`INSERT INTO ${db}.customer (id, name) VALUES ${values}`)
    // The second order points at a customer that does not exist (written with the check off).
    await scratch.q('SET foreign_key_checks = 0')
    await scratch.q(`INSERT INTO ${db}.orders VALUES (1, 2), (2, 999)`)
    await scratch.q('SET foreign_key_checks = 1')
    await signIn(page, address)
    await openTable(page, scratch.name, 'orders')
  })

  const editRow = (page: import('@playwright/test').Page, n: number) =>
    page.getByRole('grid').getByRole('row').nth(n).getByRole('button', { name: 'Edit row' }).click()

  test('search server-side, pick a row, save the key', async ({ page, scratch }) => {
    await editRow(page, 1)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Refers to Cust 2 in customer')).toBeVisible()
    await dialog.getByRole('button', { name: 'Find a row in customer' }).click()
    await dialog.getByRole('combobox', { name: 'Search customer' }).fill('Cust 42')
    await dialog.getByRole('option', { name: 'Cust 42 (42)' }).click()
    await expect(dialog.getByRole('textbox', { name: 'customer_id', exact: true })).toHaveValue(
      '42',
    )
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(async () => {
      expect(
        await scratch.q(`SELECT customer_id FROM \`${scratch.name}\`.orders WHERE id = 1`),
      ).toEqual([{ customer_id: 42 }])
    }).toPass({ timeout: 8000 })
  })

  test('the list pages by 50', async ({ page }) => {
    await editRow(page, 1)
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Find a row in customer' }).click()
    await expect(dialog.getByRole('option')).toHaveCount(50)
    await dialog.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(dialog.getByRole('option')).toHaveCount(10)
    await expect(dialog.getByRole('option', { name: 'Cust 51 (51)' })).toBeVisible()
  })

  test('a key without a referenced row is kept and marked "not found"', async ({
    page,
    scratch,
  }) => {
    await editRow(page, 2)
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByText('No row in customer has this key. The value is kept as it is.'),
    ).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'customer_id', exact: true })).toHaveValue(
      '999',
    )
    expect(
      await scratch.q(`SELECT customer_id FROM \`${scratch.name}\`.orders WHERE id = 2`),
    ).toEqual([{ customer_id: 999 }])
  })

  test('Create new row opens the insert form of the referenced table and selects the new key', async ({
    page,
    scratch,
  }) => {
    await editRow(page, 1)
    const edit = page.getByRole('dialog').first()
    await edit.getByRole('button', { name: 'Find a row in customer' }).click()
    await page.getByRole('button', { name: 'Create new row…' }).click()
    const create = page.getByRole('dialog').last()
    await expect(create.getByRole('heading', { name: /Insert into customer/ })).toBeVisible()
    await create.getByRole('textbox', { name: 'name', exact: true }).fill('Brand new')
    await create.getByRole('button', { name: 'Go' }).last().click()
    let created: { id: number } | undefined
    await expect(async () => {
      ;[created] = await scratch.q<{ id: number }>(
        `SELECT id FROM \`${scratch.name}\`.customer WHERE name = 'Brand new'`,
      )
      expect(created?.id).toBeGreaterThan(60)
    }).toPass({ timeout: 8000 })
    // The edit form stays open and now holds the new key.
    await expect(edit.getByRole('textbox', { name: 'customer_id', exact: true })).toHaveValue(
      String(created?.id),
    )
    await expect(edit.getByRole('heading', { name: /Edit a row of orders/ })).toBeVisible()
    void gridRow
  })
})
