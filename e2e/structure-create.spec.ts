import {
  addColumn,
  columnRow,
  countServerCalls,
  databaseAction,
  expandDatabase,
  expect,
  fillColumn,
  formDialog,
  openNewTable,
  previewDialog,
  randomName,
  sidebar,
  signIn,
  test,
} from './fixtures/scratch-db'

type Col = { name: string; type: string; nullable: string; extra: string; key: string }

test.describe('SCN-012 create a table', () => {
  test('designer, preview, execute, sidebar and empty grid', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await signIn(page, address)
    await expandDatabase(page, scratch.name)
    await expect(sidebar(page).getByText('No tables')).toBeVisible()
    await openNewTable(page, scratch.name)

    // The designer starts with one id row: BIGINT UNSIGNED, auto-increment, primary key.
    const id = columnRow(page, 0)
    await expect(id.getByRole('combobox', { name: /^Type, column/ })).toHaveValue('bigint')
    await expect(id.getByRole('checkbox', { name: /^Unsigned/ })).toBeChecked()
    await expect(id.getByRole('checkbox', { name: /^Auto-increment/ })).toBeChecked()
    await expect(id.getByRole('checkbox', { name: /^Primary key/ })).toBeChecked()

    await page.getByLabel('Table name').fill('customer')
    await addColumn(page).click()
    await fillColumn(columnRow(page, 1), {
      name: 'name',
      type: 'varchar',
      length: 100,
      nullable: false,
    })
    await addColumn(page).click()
    await fillColumn(columnRow(page, 2), {
      name: 'created_at',
      type: 'timestamp',
      nullable: false,
      defaultKind: 'currentTimestamp',
    })

    await page.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await expect(dialog.getByRole('heading', { name: 'Preview of the SQL' })).toBeVisible()
    await expect(dialog).toContainText(`CREATE TABLE \`${scratch.name}\`.\`customer\``)
    await expect(dialog).toContainText('`id` bigint unsigned NOT NULL AUTO_INCREMENT')
    await expect(dialog).toContainText('`name` varchar(100) NOT NULL')
    await expect(dialog).toContainText('`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP')
    await expect(dialog).toContainText('PRIMARY KEY')
    // FR-TGT-243: engine, character set and the server's default collation are spelled out.
    await expect(dialog).toContainText(
      product === 'mysql'
        ? 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
        : 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',
    )
    await expect(dialog).toContainText('Statement 1 of 1')
    await expect(dialog).toContainText('cannot be rolled back')

    // Nothing ran before the button was pressed.
    expect(
      await scratch.q('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [
        scratch.name,
      ]),
    ).toHaveLength(0)

    await dialog.getByRole('button', { name: 'Create table' }).click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    await expect(dialog).toContainText(`CREATE TABLE \`${scratch.name}\`.\`customer\``)

    // The real catalog, not only the UI.
    const cols = await scratch.q<Col>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, EXTRA AS extra,
              COLUMN_KEY AS \`key\`
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer'
        ORDER BY ORDINAL_POSITION`,
      [scratch.name],
    )
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'created_at'])
    expect(cols[0]).toMatchObject({ key: 'PRI', nullable: 'NO' })
    expect(cols[0]?.type).toMatch(/^bigint(\(20\))? unsigned$/)
    expect(cols[0]?.extra).toContain('auto_increment')
    expect(cols[1]).toMatchObject({ nullable: 'NO', type: 'varchar(100)' })
    expect(cols[2]?.type).toBe('timestamp')
    const [{ collation }] = (await scratch.q<{ collation: string }>(
      `SELECT TABLE_COLLATION AS collation FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer'`,
      [scratch.name],
    )) as [{ collation: string }]
    expect(collation).toMatch(/^utf8mb4_/)

    // The sidebar lists the table without a reload; the grid opens empty.
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
    await expect(sidebar(page).getByRole('button', { name: 'customer', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'customer (design)' })).toBeVisible()
    await sidebar(page).getByRole('button', { name: 'customer', exact: true }).click()
    await expect(page.getByText('This table has no rows.')).toBeVisible()
  })

  test('an existing name shows the server error 1050 and changes nothing', async ({
    page,
    scratch,
    address,
  }) => {
    await scratch.q(`CREATE TABLE \`${scratch.name}\`.customer (id INT PRIMARY KEY)`)
    await signIn(page, address)
    await openNewTable(page, scratch.name)
    await page.getByLabel('Table name').fill('customer')
    await page.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await dialog.getByRole('button', { name: 'Create table' }).click()
    await expect(dialog.getByRole('heading', { name: 'A statement failed' })).toBeVisible()
    await expect(dialog.getByRole('alert')).toContainText('Error 1050.')
    await expect(dialog.getByRole('alert')).toContainText('already exists')
    await expect(dialog.getByRole('alert')).toContainText('A table with this name already exists.')
    const tables = await scratch.q<{ n: string }>(
      'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [scratch.name],
    )
    expect(tables.map((r) => r.n)).toEqual(['customer'])
  })

  test('a 65 character name is refused in the form before any request', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openNewTable(page, scratch.name)
    const calls = countServerCalls(page)
    await page.getByLabel('Table name').fill('x'.repeat(65))
    await expect(page.getByText('At most 64 characters')).toBeVisible()
    const before = calls()
    await page.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(page.getByText('1 problems to fix before the preview')).toBeVisible()
    await expect(previewDialog(page)).toBeHidden()
    expect(calls()).toBe(before)
  })
})

test.describe('column comment with emoji', () => {
  test('an inline warning appears for characters above U+FFFF and goes away again', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openNewTable(page, scratch.name)
    const row = columnRow(page, 0)
    const comment = row.getByRole('textbox', { name: /^Comment, column/ })
    await comment.fill('plain ü €')
    await expect(row.getByText('outside the basic plane')).toHaveCount(0)
    await comment.fill('party \u{1F389}')
    await expect(row.getByText('outside the basic plane')).toBeVisible()
    await expect(row.getByText('saved as ?')).toBeVisible()
    await comment.fill('party')
    await expect(row.getByText('outside the basic plane')).toHaveCount(0)
  })
})

test.describe('SCN-017 create and drop a database', () => {
  test('collation list from the server, SQL shown, sidebar, drop with typed name', async ({
    page,
    scratch,
    address,
  }) => {
    const name = randomName('e2e_struct_new_')
    scratch.trackDatabase(name)
    await signIn(page, address)
    await sidebar(page).getByRole('button', { name: 'New database' }).click()
    const form = formDialog(page)
    await expect(form.getByRole('heading', { name: 'New database' })).toBeVisible()

    // Empty name: refused in the form, no request.
    const calls = countServerCalls(page)
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(form.getByText('Required')).toBeVisible()
    const before = calls()
    expect(before).toBeGreaterThanOrEqual(0)

    await form.getByLabel('Database name').fill(name)
    await form.getByLabel('Character set').selectOption('utf8mb4')
    await form.getByLabel('Collation').selectOption('utf8mb4_unicode_ci')
    await form.getByRole('button', { name: 'Preview SQL' }).click()

    const preview = previewDialog(page)
    await expect(preview).toContainText(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
    expect(
      await scratch.q('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]),
    ).toHaveLength(0)
    await preview.getByRole('button', { name: 'Create database' }).click()
    await expect(preview.getByRole('heading', { name: 'Done' })).toBeVisible()
    await expect(preview).toContainText(`CREATE DATABASE \`${name}\``)
    const [schema] = await scratch.q<{ cs: string; coll: string }>(
      `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS coll
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [name],
    )
    expect(schema).toEqual({ cs: 'utf8mb4', coll: 'utf8mb4_unicode_ci' })

    // A link opens it in the sidebar.
    await preview.getByRole('button', { name: 'Show in the sidebar' }).click()
    await expect(sidebar(page).getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    // The same name again: the server's error 1007, no navigation.
    await sidebar(page).getByRole('button', { name: 'New database' }).click()
    const again = formDialog(page)
    await again.getByLabel('Database name').fill(name)
    await again.getByRole('button', { name: 'Preview SQL' }).click()
    const second = previewDialog(page)
    await second.getByRole('button', { name: 'Create database' }).click()
    await expect(second.getByRole('alert')).toContainText('Error 1007.')
    await second.getByRole('button', { name: 'Close' }).click()
    await page.keyboard.press('Escape')

    // System schemas have no actions at all.
    await expect(
      sidebar(page).getByRole('button', { name: 'Actions for database mysql' }),
    ).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'New table in mysql' })).toHaveCount(0)

    // Drop: typed name and the hard confirmation.
    await databaseAction(page, name, 'Drop database')
    const drop = formDialog(page)
    await expect(drop.getByRole('heading', { name: `Drop database ${name}` })).toBeVisible()
    await drop.getByRole('button', { name: 'Preview SQL' }).click()
    const confirm = previewDialog(page)
    await expect(confirm).toContainText(`DROP DATABASE \`${name}\``)
    await expect(confirm).toContainText('This deletes data permanently.')
    const run = confirm.getByRole('button', { name: 'Drop database' })
    await expect(run).toBeDisabled()
    await confirm.getByLabel(`Type ${name} to confirm`).fill(`${name}x`)
    await expect(confirm.getByText('The name does not match.')).toBeVisible()
    await expect(run).toBeDisabled()
    await confirm.getByLabel(`Type ${name} to confirm`).fill(name)
    await expect(run).toBeEnabled()
    await run.click()
    await expect(confirm.getByRole('heading', { name: 'Done' })).toBeVisible()
    expect(
      await scratch.q('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]),
    ).toHaveLength(0)
    await confirm.getByRole('button', { name: 'Close' }).click()
    await expect(sidebar(page).getByRole('button', { name, exact: true })).toHaveCount(0)
  })
})
