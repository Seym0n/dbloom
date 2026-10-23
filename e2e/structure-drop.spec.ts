import type { Locator, Page } from '@playwright/test'
import {
  expandDatabase,
  expect,
  formDialog,
  previewDialog,
  seedCustomer,
  sidebar,
  signIn,
  tableAction,
  tableNames,
  test,
  type Scratch,
} from './fixtures/scratch-db'

/** `orders` has a foreign key to `customer`. */
async function seedOrders(scratch: Scratch) {
  await scratch.q(
    `CREATE TABLE \`${scratch.name}\`.orders (
       id INT PRIMARY KEY, customer_id BIGINT UNSIGNED NOT NULL,
       CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id)
         REFERENCES \`${scratch.name}\`.customer (id))`,
  )
}

async function startDrop(page: Page, scratch: Scratch, table: string, item: string) {
  await expandDatabase(page, scratch.name)
  await tableAction(page, table, item)
  return formDialog(page)
}

/** Types the table name into the confirmation field and checks the button follows. */
async function confirmByName(dialog: Locator, name: string, run: Locator) {
  await expect(run).toBeDisabled()
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name.slice(0, -1))
  await expect(dialog.getByText('The name does not match.')).toBeVisible()
  await expect(run).toBeDisabled()
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name)
  await expect(run).toBeEnabled()
}

test.describe('SCN-016 drop a table', () => {
  test('typed name enables the button; the table and its sidebar entry go', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 5 })
    await signIn(page, address)
    const form = await startDrop(page, scratch, 'customer', 'Drop table')
    await expect(
      form.getByRole('heading', { name: `Drop table ${scratch.name}.customer` }),
    ).toBeVisible()
    await form.getByRole('button', { name: 'Preview SQL' }).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText(`DROP TABLE \`${scratch.name}\`.\`customer\``)
    await expect(dialog).toContainText('Can delete data')
    await expect(dialog).toContainText('This deletes data permanently.')
    const run = dialog.getByRole('button', { name: 'Drop', exact: true })
    await confirmByName(dialog, 'customer', run)
    expect(await tableNames(scratch)).toEqual(['customer'])
    await run.click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    expect(await tableNames(scratch)).toEqual([])
    await expect(sidebar(page).getByRole('button', { name: 'customer', exact: true })).toHaveCount(
      0,
    )
  })

  test('a foreign key blocks the drop with the server error; ignoring the checks works', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await seedCustomer(scratch, { rows: 2 })
    await seedOrders(scratch)
    await signIn(page, address)

    // Without the option: the server's error, verbatim, with a hint; the table stays.
    let form = await startDrop(page, scratch, 'customer', 'Drop table')
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await dialog.getByLabel('Type customer to confirm').fill('customer')
    await dialog.getByRole('button', { name: 'Drop', exact: true }).click()
    const alert = dialog.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(product === 'mysql' ? 'Error 3730.' : /Error (1451|1217)\./)
    await expect(alert).toContainText(/foreign key/i)
    await expect(alert).toContainText(/foreign key/i)
    await expect(alert).toContainText(
      /drop those foreign keys first|still reference|foreign key constraint blocks/,
    )
    expect(await tableNames(scratch)).toEqual(['customer', 'orders'])
    await dialog.getByRole('button', { name: 'Close' }).click()

    // With "ignore foreign key checks for this statement": three statements, then it succeeds.
    form = formDialog(page)
    await form.getByLabel('Ignore foreign key checks for this statement').check()
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(dialog).toContainText('Statement 1 of 3')
    await expect(dialog).toContainText('SET SESSION foreign_key_checks=0')
    await expect(dialog).toContainText('Statement 3 of 3')
    await expect(dialog).toContainText('SET SESSION foreign_key_checks=1')
    await expect(dialog).toContainText('These statements run one after another')
    const run = dialog.getByRole('button', { name: 'Drop', exact: true })
    await confirmByName(dialog, 'customer', run)
    await run.click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    await expect(dialog).toContainText('3 statements ran.')
    await dialog.getByRole('button', { name: 'Close' }).click()
    expect(await tableNames(scratch)).toEqual(['orders'])

    // The variable is back to 1: a later drop of a referenced table is blocked again.
    await scratch.q(`CREATE TABLE \`${scratch.name}\`.parent2 (id INT PRIMARY KEY)`)
    await scratch.q(
      `CREATE TABLE \`${scratch.name}\`.child2 (id INT PRIMARY KEY, p INT,
         FOREIGN KEY (p) REFERENCES \`${scratch.name}\`.parent2 (id))`,
    )
    await page.reload()
    form = await startDrop(page, scratch, 'parent2', 'Drop table')
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await dialog.getByLabel('Type parent2 to confirm').fill('parent2')
    await dialog.getByRole('button', { name: 'Drop', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(await tableNames(scratch)).toContain('parent2')
  })

  test('a view is dropped with DROP VIEW and has no Empty table entry', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 2 })
    await scratch.q(
      `CREATE VIEW \`${scratch.name}\`.v_customer AS SELECT id FROM \`${scratch.name}\`.customer`,
    )
    await signIn(page, address)
    await expandDatabase(page, scratch.name)
    await sidebar(page).getByRole('button', { name: 'Actions for v_customer', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Empty table' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Design table' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'Drop view' }).click()

    const form = formDialog(page)
    await expect(
      form.getByRole('heading', { name: `Drop view ${scratch.name}.v_customer` }),
    ).toBeVisible()
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText(`DROP VIEW \`${scratch.name}\`.\`v_customer\``)
    const run = dialog.getByRole('button', { name: 'Drop', exact: true })
    await confirmByName(dialog, 'v_customer', run)
    await run.click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    const views = await scratch.q(
      'SELECT 1 FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [scratch.name, 'v_customer'],
    )
    expect(views).toHaveLength(0)
    expect(await tableNames(scratch)).toEqual(['customer'])
  })
})

test.describe('SCN-019 truncate a table', () => {
  test('typed name, table empty, AUTO_INCREMENT restarts at 1', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 1000 })
    await signIn(page, address)
    const form = await startDrop(page, scratch, 'customer', 'Empty table')
    await expect(
      form.getByRole('heading', { name: `Empty table ${scratch.name}.customer` }),
    ).toBeVisible()
    await form.getByRole('button', { name: 'Preview SQL' }).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText(`TRUNCATE TABLE \`${scratch.name}\`.\`customer\``)
    await expect(dialog).toContainText('Can delete data')
    const run = dialog.getByRole('button', { name: 'Empty table' })
    await confirmByName(dialog, 'customer', run)
    const q = `SELECT COUNT(*) AS n FROM \`${scratch.name}\`.customer`
    expect(Number((await scratch.q<{ n: number }>(q))[0]?.n)).toBe(1000)
    await run.click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    expect(Number((await scratch.q<{ n: number }>(q))[0]?.n)).toBe(0)

    await scratch.q(`INSERT INTO \`${scratch.name}\`.customer (name) VALUES ('first')`)
    const [row] = await scratch.q<{ id: number }>(
      `SELECT id FROM \`${scratch.name}\`.customer LIMIT 1`,
    )
    expect(Number(row?.id)).toBe(1)
  })

  test('a table referenced by a foreign key: server error, then the option works', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 3 })
    await seedOrders(scratch)
    await signIn(page, address)
    let form = await startDrop(page, scratch, 'customer', 'Empty table')
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await dialog.getByLabel('Type customer to confirm').fill('customer')
    await dialog.getByRole('button', { name: 'Empty table' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Error 1701.')
    const q = `SELECT COUNT(*) AS n FROM \`${scratch.name}\`.customer`
    expect(Number((await scratch.q<{ n: number }>(q))[0]?.n)).toBe(3)
    await dialog.getByRole('button', { name: 'Close' }).click()

    form = formDialog(page)
    await form.getByLabel('Ignore foreign key checks for this statement').check()
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(dialog).toContainText('Statement 3 of 3')
    await dialog.getByLabel('Type customer to confirm').fill('customer')
    await dialog.getByRole('button', { name: 'Empty table' }).click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    expect(Number((await scratch.q<{ n: number }>(q))[0]?.n)).toBe(0)
  })
})

test.describe('SCN-023 multi-statement failure', () => {
  test('executed, failed and not-run are listed; the first change stays', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 2 })
    await signIn(page, address)
    const form = await startDrop(page, scratch, 'customer', 'Drop table')
    await form.getByLabel('Ignore foreign key checks for this statement').check()
    await form.getByRole('button', { name: 'Preview SQL' }).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText('Statement 3 of 3')
    await expect(dialog).toContainText(
      'These statements run one after another; MySQL commits each one and cannot undo earlier ones.',
    )
    await dialog.getByLabel('Type customer to confirm').fill('customer')

    // The table disappears between preview and run, so statement 2 fails.
    const other = await scratch.second()
    await other.query(`DROP TABLE \`${scratch.name}\`.customer`)

    await dialog.getByRole('button', { name: 'Drop', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'A statement failed' })).toBeVisible()
    await expect(dialog).toContainText(
      'Statements before the failed one were applied and are not undone. Later statements did not run.',
    )
    const steps = dialog.getByRole('listitem')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toContainText('Ran')
    await expect(steps.nth(0)).toContainText('SET SESSION foreign_key_checks=0')
    await expect(steps.nth(1)).toContainText('Failed')
    await expect(steps.nth(1)).toContainText('DROP TABLE')
    await expect(steps.nth(1).getByRole('alert')).toContainText('Error 1051.')
    await expect(steps.nth(1).getByRole('alert')).toContainText('customer')
    await expect(steps.nth(2)).toContainText('Not run')
    await expect(steps.nth(2)).toContainText('SET SESSION foreign_key_checks=1')
    expect(await tableNames(scratch)).toEqual([])
  })
})
