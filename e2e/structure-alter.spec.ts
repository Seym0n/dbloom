import type { Page } from '@playwright/test'
import {
  addColumn,
  columnNames,
  columnNamed,
  columnRow,
  countServerCalls,
  expandDatabase,
  expect,
  fillColumn,
  formDialog,
  openDesigner,
  openNewTable,
  previewDialog,
  seedCustomer,
  sidebar,
  signIn,
  tableAction,
  tableNames,
  test,
} from './fixtures/scratch-db'

const preview = (page: Page) => page.getByRole('button', { name: 'Preview SQL' })
const indexesOf = (page: Page) => page.getByRole('region', { name: 'Indexes' })
const lastIndex = (page: Page) => indexesOf(page).getByRole('listitem').last()

/** Closes the result dialog; the designer then reloads the definition from the server. */
async function closeResult(page: Page) {
  const dialog = previewDialog(page)
  await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
}

test.describe('SCN-013 add a column', () => {
  test('one ALTER, no token, position 3 with comment, 1000 rows stay', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 1000 })
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')

    await addColumn(page).click()
    await fillColumn(columnRow(page, 3), { name: 'email', nullable: true, comment: 'login mail' })
    await page.getByRole('button', { name: 'Move email up' }).click()
    await expect(columnRow(page, 2).getByRole('textbox', { name: /^Name, column/ })).toHaveValue(
      'email',
    )
    await preview(page).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText('Statement 1 of 1')
    await expect(dialog).toContainText(`ALTER TABLE \`${scratch.name}\`.\`customer\``)
    await expect(dialog).toContainText('ADD COLUMN `email` varchar(255) NULL')
    await expect(dialog).toContainText("COMMENT 'login mail'")
    await expect(dialog).toContainText('AFTER `name`')
    await expect(dialog).toContainText('No data loss')
    // Not destructive: no confirmation field, the button is enabled at once.
    await expect(dialog).not.toContainText('This deletes data permanently.')
    expect(await columnNames(scratch, 'customer')).toEqual(['id', 'name', 'created_at'])
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)

    expect(await columnNames(scratch, 'customer')).toEqual(['id', 'name', 'email', 'created_at'])
    const [col] = await scratch.q<{ pos: number; comment: string }>(
      `SELECT ORDINAL_POSITION AS pos, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer' AND COLUMN_NAME = 'email'`,
      [scratch.name],
    )
    expect(col).toMatchObject({ pos: 3, comment: 'login mail' })
    const [count] = await scratch.q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${scratch.name}\`.customer`,
    )
    expect(Number(count?.n)).toBe(1000)
  })

  test('a second column and an index in one session merge into one ALTER', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { email: true })
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')

    await addColumn(page).click()
    await fillColumn(columnRow(page, 4), { name: 'phone', length: 30 })
    await page.getByRole('button', { name: 'Add index' }).click()
    const index = lastIndex(page)
    await index.getByLabel('Index name').fill('idx_phone')
    await index.getByLabel('Column 1 of the index').selectOption('phone')
    await preview(page).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText('Statement 1 of 1')
    await expect(dialog).toContainText('ADD COLUMN `phone`')
    await expect(dialog).toContainText('idx_phone')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)

    expect(await columnNames(scratch, 'customer')).toContain('phone')
    const idx = await scratch.q<{ c: string }>(
      `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer' AND INDEX_NAME = 'idx_phone'`,
      [scratch.name],
    )
    expect(idx.map((r) => r.c)).toEqual(['phone'])
  })
})

test.describe('SCN-014 drop a column with confirmation', () => {
  test.beforeEach(async ({ scratch }) => {
    await seedCustomer(scratch, { rows: 5, email: true })
  })

  test('hard class: acknowledgement needed, then the column is gone', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')
    await page.getByRole('button', { name: 'Remove column email' }).click()
    await preview(page).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText('DROP COLUMN `email`')
    await expect(dialog).toContainText('Can delete data')
    await expect(dialog).toContainText('This deletes data permanently.')
    const run = dialog.getByRole('button', { name: 'Apply changes' })
    await expect(run).toBeDisabled()
    await dialog.getByLabel('I understand that this deletes data permanently.').check()
    await expect(run).toBeEnabled()
    expect(await columnNames(scratch, 'customer')).toContain('email')
    await run.click()
    await closeResult(page)
    expect(await columnNames(scratch, 'customer')).toEqual(['id', 'name', 'created_at'])
  })

  test('a tampered confirmation token is refused by the server', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')
    await page.getByRole('button', { name: 'Remove column email' }).click()
    await preview(page).click()
    const dialog = previewDialog(page)
    await dialog.getByLabel('I understand that this deletes data permanently.').check()

    // Flip one character of the token in the execute call only.
    let tampered = false
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData()
      // Wire format of the execute call: {"k":["planId","confirmToken"],"v":[{..."s":plan},{..."s":token}]}
      const match = body?.match(
        /"k":\["planId","confirmToken"\],"v":\[\{"t":1,"s":"[^"]*"\},\{"t":1,"s":"([^"]+)"\}/,
      )
      if (body && match && !tampered) {
        tampered = true
        const token = match[1] as string
        // Not the last character: its low bits are base64 padding and would decode to the same bytes.
        const at = token.length - 10
        const flipped = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1)
        await route.continue({ postData: body.replace(token, flipped) })
      } else await route.continue()
    })
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(tampered).toBe(true)
    expect(await columnNames(scratch, 'customer')).toContain('email')
  })

  test('a table changed after the preview is refused as stale; nothing changes', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')
    await page.getByRole('button', { name: 'Remove column email' }).click()
    await preview(page).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText('DROP COLUMN `email`')

    // A second connection changes the table after the preview.
    const other = await scratch.second()
    await other.query(`ALTER TABLE \`${scratch.name}\`.customer ADD COLUMN zz INT NULL`)

    await dialog.getByLabel('I understand that this deletes data permanently.').check()
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await expect(dialog.getByRole('alert')).toContainText('The table changed since the preview')
    await expect(dialog.getByRole('alert')).not.toContainText('stale_plan')
    expect(await columnNames(scratch, 'customer')).toEqual([
      'id',
      'name',
      'email',
      'created_at',
      'zz',
    ])
    // FR-STR-012: a fresh preview is offered; it closes the dialog and reloads the table.
    await dialog.getByRole('button', { name: 'New preview from current state' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('input[value="zz"]')).toBeVisible()
  })
})

test.describe('SCN-015 indexes', () => {
  test('unique and prefix index, PRIMARY name refused, duplicate notice, fulltext, drop', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 3, email: true })
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')

    await page.getByRole('button', { name: 'Add index' }).click()
    let index = lastIndex(page)
    await index.getByLabel('Index name').fill('uq_email')
    await index.getByLabel('Type', { exact: true }).selectOption('unique')
    await index.getByLabel('Column 1 of the index').selectOption('email')
    await page.getByRole('button', { name: 'Add index' }).click()
    index = lastIndex(page)
    await index.getByLabel('Index name').fill('idx_name')
    await index.getByLabel('Column 1 of the index').selectOption('name')
    await index.getByLabel('Prefix length of column 1').fill('20')
    await preview(page).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText('Statement 1 of 1')
    await expect(dialog).toContainText('uq_email')
    await expect(dialog).toContainText('idx_name')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)

    const stats = (name: string) =>
      scratch.q<{ unique: number; sub: number | null; col: string; type: string }>(
        `SELECT NON_UNIQUE AS \`unique\`, SUB_PART AS sub, COLUMN_NAME AS col, INDEX_TYPE AS type
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer' AND INDEX_NAME = ?`,
        [scratch.name, name],
      )
    const [uq] = await stats('uq_email')
    expect(uq).toMatchObject({ unique: 0, col: 'email' })
    const [ix] = await stats('idx_name')
    expect(ix).toMatchObject({ unique: 1, col: 'name' })
    expect(Number(ix?.sub)).toBe(20)

    // A new index named PRIMARY is refused in the form; nothing is sent.
    await page.getByRole('button', { name: 'Add index' }).click()
    index = lastIndex(page)
    await index.getByLabel('Index name').fill('PRIMARY')
    await index.getByLabel('Column 1 of the index').selectOption('name')
    const calls = countServerCalls(page)
    await preview(page).click()
    await expect(page.getByText('Only the primary key is named PRIMARY')).toBeVisible()
    await expect(dialog).toBeHidden()
    expect(calls()).toBe(0)

    // The same columns as idx_name: allowed, with a duplicate notice before it runs.
    await index.getByLabel('Index name').fill('idx_dup')
    await index.getByLabel('Prefix length of column 1').fill('20')
    await expect(index.getByText('Another index already covers these columns.')).toBeVisible()
    await preview(page).click()
    await expect(dialog).toContainText('idx_dup')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)
    expect(await stats('idx_dup')).toHaveLength(1)

    // FULLTEXT on a VARCHAR column works on both products.
    await page.getByRole('button', { name: 'Add index' }).click()
    index = lastIndex(page)
    await index.getByLabel('Index name').fill('ft_name')
    await index.getByLabel('Type', { exact: true }).selectOption('fulltext')
    await index.getByLabel('Column 1 of the index').selectOption('name')
    await preview(page).click()
    await expect(dialog).toContainText('FULLTEXT')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)
    expect((await stats('ft_name'))[0]?.type).toBe('FULLTEXT')

    // Dropping an index is soft class: no acknowledgement, no typed name.
    await page.getByRole('button', { name: /^Remove idx_dup/ }).click()
    await preview(page).click()
    await expect(dialog).toContainText('DROP INDEX `idx_dup`')
    await expect(dialog).toContainText('Changes structure')
    await expect(dialog).not.toContainText('This deletes data permanently.')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)
    expect(await stats('idx_dup')).toHaveLength(0)
    expect(await stats('idx_name')).toHaveLength(1)
  })
})

test.describe('SCN-018 rename a table and a column', () => {
  test('table rename: same and empty name refused, existing name 1050, then renamed', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 3, nameIndex: true })
    await scratch.q(`CREATE TABLE \`${scratch.name}\`.taken (id INT PRIMARY KEY)`)
    await signIn(page, address)
    await expandDatabase(page, scratch.name)
    await tableAction(page, 'customer', 'Rename')

    const form = formDialog(page)
    await expect(
      form.getByRole('heading', { name: `Rename ${scratch.name}.customer` }),
    ).toBeVisible()
    const calls = countServerCalls(page)
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(form.getByText('Enter a different name')).toBeVisible()
    await form.getByLabel('New name').fill('')
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(form.getByText('Required')).toBeVisible()
    expect(calls()).toBe(0)

    await form.getByLabel('New name').fill('taken')
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText(
      `RENAME TABLE \`${scratch.name}\`.\`customer\` TO \`${scratch.name}\`.\`taken\``,
    )
    await dialog.getByRole('button', { name: 'Rename table' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Error 1050.')
    await dialog.getByRole('button', { name: 'Close' }).click()
    expect(await tableNames(scratch)).toEqual(['customer', 'taken'])

    await form.getByLabel('New name').fill('client')
    await form.getByRole('button', { name: 'Preview SQL' }).click()
    await expect(dialog).toContainText(
      `RENAME TABLE \`${scratch.name}\`.\`customer\` TO \`${scratch.name}\`.\`client\``,
    )
    await expect(dialog).toContainText('Changes structure')
    await expect(dialog).not.toContainText('This deletes data permanently.')
    await dialog.getByRole('button', { name: 'Rename table' }).click()
    await expect(dialog.getByRole('heading', { name: 'Done' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    expect(await tableNames(scratch)).toEqual(['client', 'taken'])
    await expect(sidebar(page).getByRole('button', { name: 'client', exact: true })).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'customer', exact: true })).toHaveCount(
      0,
    )
  })

  test('column rename keeps its index', async ({ page, scratch, address }) => {
    await seedCustomer(scratch, { rows: 3, nameIndex: true })
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'customer')
    await columnNamed(page, 'name')
      .getByRole('textbox', { name: /^Name, column/ })
      .fill('full_name')
    await preview(page).click()

    const dialog = previewDialog(page)
    await expect(dialog).toContainText('Statement 1 of 1')
    await expect(dialog).toContainText(/RENAME COLUMN `name` TO `full_name`|CHANGE COLUMN `name`/)
    await expect(dialog).not.toContainText('This deletes data permanently.')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)

    expect(await columnNames(scratch, 'customer')).toEqual(['id', 'full_name', 'created_at'])
    const idx = await scratch.q<{ c: string }>(
      `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customer' AND INDEX_NAME = 'idx_name'`,
      [scratch.name],
    )
    expect(idx.map((r) => r.c)).toEqual(['full_name'])
  })
})

test.describe('SCN-022 version differences (run once per product)', () => {
  test.beforeEach(async ({ scratch }) => {
    await scratch.q(
      `CREATE TABLE \`${scratch.name}\`.product (
         id INT NOT NULL, price DECIMAL(10,2) NOT NULL, PRIMARY KEY (id), KEY idx_price (price))`,
    )
  })

  test('the designer names the connected product and version', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'product')
    const [{ v }] = (await scratch.q<{ v: string }>('SELECT VERSION() AS v')) as [{ v: string }]
    await expect(page.getByText(product === 'mysql' ? 'MySQL 8.4' : 'MariaDB 10.11')).toBeVisible()
    expect(v).toContain(product === 'mysql' ? '8.4' : '10.11')
    // System versioning and sequences are deferred: neither is offered (item 5).
    await expect(
      page.locator('button, h1, h2, label').filter({ hasText: /system.versioning|sequence/i }),
    ).toHaveCount(0)
  })

  test('CHECK: add, enforced, violation errno, drop', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'product')
    await page.getByRole('button', { name: 'Add CHECK constraint' }).click()
    await page.getByLabel('Constraint name').fill('chk_price')
    await page.getByLabel('Expression').fill('price >= 0')
    await preview(page).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText('chk_price')
    await expect(dialog).toContainText('CHECK')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)

    const checks = () =>
      scratch.q<{ n: string }>(
        `SELECT CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = 'chk_price'`,
        [scratch.name],
      )
    expect(await checks()).toHaveLength(1)
    await expect(
      scratch.q(`INSERT INTO \`${scratch.name}\`.product (id, price) VALUES (1, -1)`),
    ).rejects.toMatchObject({ errno: product === 'mysql' ? 3819 : 4025 })

    // The enforcement toggle is offered only where the server supports it.
    const enforced = page.getByRole('checkbox', { name: 'Enforced' })
    if (product === 'mysql') await expect(enforced).toBeEnabled()
    else {
      await expect(enforced).toBeDisabled()
      await expect(page.getByText('Not supported by this server version').first()).toBeVisible()
    }

    await page.getByRole('button', { name: /^Remove chk_price/ }).click()
    await preview(page).click()
    await expect(dialog).toContainText(/DROP (CHECK|CONSTRAINT) `chk_price`/)
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)
    expect(await checks()).toHaveLength(0)
  })

  test('hidden index: INVISIBLE on MySQL, IGNORED on MariaDB; PRIMARY offers neither', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'product')
    const hide = 'Invisible to the optimizer'
    const row = indexesOf(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: /^Remove idx_price/ }) })
    const primary = indexesOf(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: /^Remove Primary key/ }) })
    await expect(primary.getByLabel(hide)).toBeDisabled()
    await row.getByLabel(hide).check()
    await preview(page).click()
    const dialog = previewDialog(page)
    await expect(dialog).toContainText(product === 'mysql' ? 'INVISIBLE' : 'IGNORED')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)

    if (product === 'mysql') {
      const [r] = await scratch.q<{ v: string }>(
        `SELECT IS_VISIBLE AS v FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product' AND INDEX_NAME = 'idx_price'`,
        [scratch.name],
      )
      expect(r?.v).toBe('NO')
    } else {
      const [r] = await scratch.q<{ v: string }>(
        `SELECT IGNORED AS v FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product' AND INDEX_NAME = 'idx_price'`,
        [scratch.name],
      )
      expect(r?.v).toBe('YES')
    }
    // The label does not change with the product (spec: "Make invisible" / "Ignore index").
    if (product === 'mariadb') {
      test.info().annotations.push({
        type: 'deviation',
        description: 'Index hide control reads "Invisible to the optimizer" on MariaDB as well',
      })
    }
  })

  test('generated column: keywords, no default or auto-increment, hostile expression refused', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openDesigner(page, scratch.name, 'product')
    await addColumn(page).click()
    const row = columnRow(page, 2)
    await fillColumn(row, { name: 'total', type: 'double' })
    await row.getByRole('combobox', { name: /^Generated, column/ }).selectOption('virtual')
    await expect(row.getByRole('combobox', { name: /^Default, column/ })).toBeDisabled()
    await expect(row.getByRole('checkbox', { name: /^Auto-increment, column/ })).toBeDisabled()

    const expression = row.getByRole('textbox', { name: /^Generated expression, column/ })
    await expression.fill('price * 2; DROP TABLE product')
    await preview(page).click()
    const dialog = previewDialog(page)
    await expect(dialog.getByRole('alert')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await columnNames(scratch, 'product')).toEqual(['id', 'price'])

    await expression.fill('price * 2')
    await preview(page).click()
    await expect(dialog).toContainText(/GENERATED ALWAYS AS \(.*price.*\)|AS \(.*price.*\)/)
    await expect(dialog).toContainText('VIRTUAL')
    await dialog.getByRole('button', { name: 'Apply changes' }).click()
    await closeResult(page)
    const [col] = await scratch.q<{ extra: string }>(
      `SELECT EXTRA AS extra FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product' AND COLUMN_NAME = 'total'`,
      [scratch.name],
    )
    expect(col?.extra).toMatch(/VIRTUAL/)
  })

  test('types and default collation come from the server', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await signIn(page, address)
    await openNewTable(page, scratch.name)
    const type = columnRow(page, 0).getByRole('combobox', { name: /^Type, column/ })
    const option = (value: string) => type.locator(`option[value="${value}"]`)
    await expect(option('json')).toBeEnabled()
    for (const value of ['uuid', 'inet6']) {
      if (product === 'mariadb') await expect(option(value)).toBeEnabled()
      else {
        await expect(option(value)).toBeDisabled()
        await expect(option(value)).toContainText('Not supported by this server version')
      }
    }

    await page.getByLabel('Character set').selectOption('utf8mb4')
    const [cs] = await scratch.q<{ c: string }>(
      `SELECT DEFAULT_COLLATE_NAME AS c FROM information_schema.CHARACTER_SETS
        WHERE CHARACTER_SET_NAME = 'utf8mb4'`,
    )
    expect(cs?.c).toBe(product === 'mysql' ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_general_ci')
    await expect(page.getByText(`Default for this character set: ${cs?.c}`)).toBeVisible()
  })
})
