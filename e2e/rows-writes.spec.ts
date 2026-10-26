import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** Rest of SCN-037, SCN-040 and SCN-041 (SPEC/24): multi-row insert, copy, cascade and restrict deletes, caps. */

test.describe('SCN-037 multi-row insert and copy', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 2)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
  })

  test('three rows insert one statement each with their own ids', async ({ page, scratch }) => {
    const t = `\`${scratch.name}\`.customer`
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Rows to insert' }).fill('3')
    for (const n of [1, 2, 3]) {
      const row = dialog.getByRole('region', { name: `Row ${n}` })
      await row.getByRole('textbox', { name: 'name', exact: true }).fill(`new ${n}`)
      await row.getByRole('textbox', { name: 'email', exact: true }).fill(`new${n}@example.test`)
    }
    await dialog.getByRole('button', { name: 'Go' }).last().click()
    await expect(page.getByText(/Inserted 3 rows/)).toBeVisible()
    const rows = await scratch.q<{ id: number; name: string }>(
      `SELECT id, name FROM ${t} WHERE name LIKE 'new %' ORDER BY id`,
    )
    expect(rows.map((r) => r.name)).toEqual(['new 1', 'new 2', 'new 3'])
    expect(rows.map((r) => r.id)).toEqual([3, 4, 5])
  })

  test('without Ignore a duplicate rolls the whole batch back; the form keeps the values', async ({
    page,
    scratch,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Rows to insert' }).fill('2')
    const r1 = dialog.getByRole('region', { name: 'Row 1' })
    const r2 = dialog.getByRole('region', { name: 'Row 2' })
    await r1.getByRole('textbox', { name: 'name', exact: true }).fill('first ok')
    await r1.getByRole('textbox', { name: 'email', exact: true }).fill('ok@example.test')
    await r2.getByRole('textbox', { name: 'name', exact: true }).fill('second dup')
    await r2.getByRole('textbox', { name: 'email', exact: true }).fill('c1@example.test')
    await dialog.getByRole('button', { name: 'Go' }).last().click()
    await expect(page.getByText(/1062|Duplicate entry/).first()).toBeVisible()
    expect(await scratch.q(`SELECT id FROM ${t} WHERE name = 'first ok'`)).toHaveLength(0)
    await expect(r1.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('first ok')
    await expect(r2.getByRole('textbox', { name: 'email', exact: true })).toHaveValue(
      'c1@example.test',
    )
  })

  test('with Ignore the duplicate row is skipped and the others are inserted', async ({
    page,
    scratch,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('spinbutton', { name: 'Rows to insert' }).fill('2')
    await dialog.getByRole('checkbox', { name: /INSERT IGNORE/ }).check()
    const r1 = dialog.getByRole('region', { name: 'Row 1' })
    const r2 = dialog.getByRole('region', { name: 'Row 2' })
    await r1.getByRole('textbox', { name: 'name', exact: true }).fill('kept')
    await r1.getByRole('textbox', { name: 'email', exact: true }).fill('kept@example.test')
    await r2.getByRole('textbox', { name: 'name', exact: true }).fill('skipped')
    await r2.getByRole('textbox', { name: 'email', exact: true }).fill('c1@example.test')
    await dialog.getByRole('button', { name: 'Go' }).last().click()
    await expect(page.getByText('Server warnings')).toBeVisible()
    expect(await scratch.q(`SELECT name FROM ${t} WHERE name IN ('kept', 'skipped')`)).toEqual([
      { name: 'kept' },
    ])
  })

  test('Copy opens the form with the stored values and saves a new row', async ({
    page,
    scratch,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    await page
      .getByRole('grid')
      .getByRole('row')
      .nth(1)
      .getByRole('button', { name: 'Copy row' })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('textbox', { name: 'name', exact: true })).toHaveValue(
      'customer 1',
    )
    await dialog.getByRole('textbox', { name: 'email', exact: true }).fill('copy@example.test')
    await dialog.getByRole('button', { name: 'Go' }).last().click()
    await expect(async () => {
      expect(await scratch.q(`SELECT name FROM ${t} WHERE email = 'copy@example.test'`)).toEqual([
        { name: 'customer 1' },
      ])
    }).toPass({ timeout: 8000 })
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${t}`)).toEqual([{ n: 3 }])
  })
})

test.describe('SCN-040 cascade and restrict deletes', () => {
  test('a delete that cascades is hard and lists the referencing table; a restrict gives 1451', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.customer (id INT PRIMARY KEY, name VARCHAR(20))`)
    await scratch.q(
      `CREATE TABLE ${db}.orders (id INT PRIMARY KEY, customer_id INT NOT NULL,
         CONSTRAINT fk_o FOREIGN KEY (customer_id) REFERENCES ${db}.customer (id) ON DELETE CASCADE)`,
    )
    await scratch.q(
      `CREATE TABLE ${db}.pins (id INT PRIMARY KEY, customer_id INT NOT NULL,
         CONSTRAINT fk_p FOREIGN KEY (customer_id) REFERENCES ${db}.customer (id) ON DELETE RESTRICT)`,
    )
    await scratch.q(`INSERT INTO ${db}.customer VALUES (1,'cascades'),(2,'restricted'),(3,'plain')`)
    await scratch.q(`INSERT INTO ${db}.orders VALUES (1,1),(2,1)`)
    await scratch.q(`INSERT INTO ${db}.pins VALUES (1,2)`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    // Cascade: hard, the dialog names the referencing table, and the type-to-confirm guard is on.
    await gridRow(page, 'cascades').getByRole('button', { name: 'Delete row' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/orders/).first()).toBeVisible()
    const confirm = dialog.getByRole('textbox', { name: /Type customer to confirm/ })
    await expect(confirm).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Delete/ }).last()).toBeDisabled()
    await confirm.fill('customer')
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect(dialog).toBeHidden()
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${db}.orders`)).toEqual([{ n: 0 }])
    expect(await scratch.q(`SELECT id FROM ${db}.customer WHERE id = 1`)).toHaveLength(0)

    // Restrict: the server's error 1451 is shown and the row stays. Wait for the grid to settle first.
    await expect(gridRow(page, 'cascades')).toHaveCount(0)
    await expect(page.getByRole('grid').getByRole('row')).toHaveCount(3)
    await gridRow(page, 'restricted').getByRole('button', { name: 'Delete row' }).click()
    // Still hard: the table has a cascading foreign key, so the guard asks for the table name again.
    const second = page.getByRole('dialog')
    await expect(second.getByText(/DELETE FROM/).first()).toContainText('restricted')
    await second.getByRole('textbox', { name: /Type customer to confirm/ }).fill('customer')
    await second
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect(page.getByText(/1451|foreign key constraint/i).first()).toBeVisible()
    expect(await scratch.q(`SELECT id FROM ${db}.customer WHERE id = 2`)).toHaveLength(1)
  })
})

test.describe('SCN-041 non-transactional tables', () => {
  test('on a MyISAM table the plan warns that there is no rollback', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.isam (id INT PRIMARY KEY, v INT) ENGINE=MyISAM`)
    await scratch.q(`INSERT INTO ${db}.isam VALUES (1,0),(2,0),(3,0)`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'isam')
    for (const n of [1, 2]) {
      await page.getByRole('checkbox', { name: `Select row ${n}`, exact: true }).check()
    }
    await page.getByRole('button', { name: 'Delete selected (2)' }).click()
    await expect(
      page
        .getByRole('dialog')
        .getByText(/roll(ed)? back|rollback|transaction/i)
        .first(),
    ).toBeVisible()
  })
})
