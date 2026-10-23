import {
  addColumn,
  columnNames,
  columnRow,
  databaseAction,
  expandDatabase,
  expect,
  fillColumn,
  formDialog,
  openDesigner,
  previewDialog,
  seedCustomer,
  sidebar,
  signIn,
  tableNames,
  test,
} from './fixtures/scratch-db'

const READ_ONLY = 'Read-only connection'
const READ_ONLY_REASON = 'Read-only connection: the SQL can be previewed but not run.'
const PRIVILEGE_HINT = 'Your account lacks a privilege for this action.'

test.describe('SCN-020 read-only connection', () => {
  // Second web server (port 3101) started with DBLOOM_READ_ONLY=true, see playwright.config.ts.
  test.use({ baseURL: 'http://localhost:3101' })

  test('actions are disabled with the reason; preview works; nothing changes', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 3 })
    await signIn(page, address)
    const nav = sidebar(page)

    // New database: disabled, with the reason, and a click opens nothing.
    const newDatabase = nav.getByRole('button', { name: 'New database' })
    await expect(newDatabase).toHaveAttribute('aria-disabled', 'true')
    await expect(newDatabase).toHaveAttribute('title', READ_ONLY)
    await expect(nav.getByText(READ_ONLY, { exact: true }).first()).toBeVisible()
    await newDatabase.click({ force: true }) // aria-disabled: a plain click would wait
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // New table in a database: the same.
    const newTable = nav.getByRole('button', { name: `New table in ${scratch.name}`, exact: true })
    await expect(newTable).toHaveAttribute('aria-disabled', 'true')
    await newTable.click({ force: true })
    await expect(page.getByRole('tab', { name: 'New table' })).toHaveCount(0)

    // Database menu and table menu entries are disabled and say why.
    await nav
      .getByRole('button', { name: `Actions for database ${scratch.name}`, exact: true })
      .click()
    for (const item of ['New table', 'Drop database']) {
      const entry = page.getByRole('menuitem', { name: new RegExp(`^${item}`) })
      await expect(entry).toHaveAttribute('aria-disabled', 'true')
      await expect(entry).toContainText(READ_ONLY)
    }
    await page.keyboard.press('Escape')

    await expandDatabase(page, scratch.name)
    await nav.getByRole('button', { name: 'Actions for customer', exact: true }).click()
    for (const item of ['Rename', 'Empty table', 'Drop table']) {
      const entry = page.getByRole('menuitem', { name: new RegExp(`^${item}`) })
      await expect(entry).toHaveAttribute('aria-disabled', 'true')
      await expect(entry).toContainText(READ_ONLY)
    }
    await page.getByRole('menuitem', { name: /^Drop table/ }).click({ force: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Design table' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await page.keyboard.press('Escape')

    // The designer shows the badge; the preview works, running is disabled with the reason.
    await openDesigner(page, scratch.name, 'customer')
    await expect(page.getByText('Read-only connection: you can preview, not run')).toBeVisible()
    await addColumn(page).click()
    await fillColumn(columnRow(page, 3), { name: 'email' })
    await page.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText('ADD COLUMN `email`')
    const run = dialog.getByRole('button', { name: 'Apply changes' })
    await expect(run).toBeDisabled()
    await expect(dialog.getByText(READ_ONLY_REASON).first()).toBeVisible()
    await expect(run).toHaveAccessibleDescription(READ_ONLY_REASON)

    // No change on the server.
    expect(await columnNames(scratch, 'customer')).toEqual(['id', 'name', 'created_at'])
    expect(await tableNames(scratch)).toEqual(['customer'])
  })
})

test.describe('SCN-021 privilege denied', () => {
  test('create table: error 1142 with the hint; drop database: 1044; no password shown', async ({
    page,
    scratch,
    address,
  }) => {
    const { user, password } = await scratch.createLimitedUser()
    await signIn(page, address, user, password)
    await expandDatabase(page, scratch.name)

    // The actions are shown; running the create ends with the server's message.
    await sidebar(page)
      .getByRole('button', { name: `New table in ${scratch.name}`, exact: true })
      .click()
    await page.getByLabel('Table name').fill('customer')
    await page.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText(`CREATE TABLE \`${scratch.name}\`.\`customer\``)
    await dialog.getByRole('button', { name: 'Create table' }).click()
    await expect(dialog.getByRole('heading', { name: 'A statement failed' })).toBeVisible()
    const alert = dialog.getByRole('alert')
    await expect(alert).toContainText('Error 1142.')
    await expect(alert).toContainText('CREATE command denied')
    await expect(alert).toContainText(PRIVILEGE_HINT)
    await expect(page.locator('body')).not.toContainText(password)
    expect(await tableNames(scratch)).toEqual([])
    await dialog.getByRole('button', { name: 'Close' }).click()

    // Dropping the database: error 1044, the database stays.
    await databaseAction(page, scratch.name, 'Drop database')
    await formDialog(page).getByRole('button', { name: 'Preview SQL' }).click()
    await dialog.getByLabel(`Type ${scratch.name} to confirm`).fill(scratch.name)
    await dialog.getByRole('button', { name: 'Drop database' }).click()
    const dropAlert = dialog.getByRole('alert')
    await expect(dropAlert).toContainText('Error 1044.')
    await expect(dropAlert).toContainText(PRIVILEGE_HINT)
    await expect(page.locator('body')).not.toContainText(password)
    expect(
      await scratch.q('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [
        scratch.name,
      ]),
    ).toHaveLength(1)
  })

  test('an alter is refused too and the table is unchanged', async ({ page, scratch, address }) => {
    await seedCustomer(scratch, { rows: 2 })
    const { user, password } = await scratch.createLimitedUser()
    await signIn(page, address, user, password)
    await openDesigner(page, scratch.name, 'customer')
    await addColumn(page).click()
    await fillColumn(columnRow(page, 3), { name: 'email' })
    await page.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/Error (1142|1143)\./)
    await expect(dialog.getByRole('alert')).toContainText(PRIVILEGE_HINT)
    expect(await columnNames(scratch, 'customer')).toEqual(['id', 'name', 'created_at'])
  })
})
