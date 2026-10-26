import type { Page } from '@playwright/test'
import { countServerCalls, expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/**
 * Remaining coverage of SCN-038 (inline edit rules), SCN-039 (dirty tracking, timestamp, BIT, long key),
 * SCN-043 (generated invisible primary key, MySQL) and SCN-044 (two real browser contexts).
 */

const cellOf = (page: Page, rowText: string, cellText: string | RegExp) =>
  gridRow(page, rowText).getByRole('gridcell').filter({ hasText: cellText }).first()

const editorOpen = (page: Page) => page.getByLabel(/^Editing /)

async function openEditForm(page: Page, rowText: string) {
  await gridRow(page, rowText).getByRole('button', { name: 'Edit row' }).click()
  await expect(page.getByRole('dialog').getByRole('textbox').first()).toBeVisible()
}

test.describe('SCN-038 inline edit rules', () => {
  test('Tab saves and moves to the next editable cell', async ({ page, scratch, address }) => {
    const t = `\`${scratch.name}\`.tabbed`
    await scratch.q(
      `CREATE TABLE ${t} (id INT NOT NULL PRIMARY KEY, a VARCHAR(20) NOT NULL, b VARCHAR(20) NOT NULL)`,
    )
    await scratch.q(`INSERT INTO ${t} VALUES (1, 'alpha', 'beta')`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'tabbed')

    await cellOf(page, 'alpha', 'alpha').dblclick()
    await expect(page.getByLabel('Editing a')).toBeVisible()
    await page.getByLabel('Editing a').fill('alpha2')
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Editing b')).toBeVisible()
    await expect(page.getByLabel('Editing b')).toHaveValue('beta')
    await expect(async () => {
      const [row] = await scratch.q<{ a: string; b: string }>(`SELECT a, b FROM ${t}`)
      expect(row).toEqual({ a: 'alpha2', b: 'beta' })
    }).toPass({ timeout: 8000 })
    await page.keyboard.press('Escape')
    await expect(editorOpen(page)).toHaveCount(0)
  })

  test('a trigger changes another column: the whole row refreshes', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 2)
    const t = `\`${scratch.name}\`.customer`
    await scratch.q(
      `CREATE TRIGGER \`${scratch.name}\`.trg_flag BEFORE UPDATE ON ${t}
         FOR EACH ROW SET NEW.note = CONCAT('trigger saw flag ', NEW.flag)`,
    )
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    await cellOf(page, 'customer 1', /^0$/).dblclick()
    await expect(page.getByLabel('Editing flag')).toBeVisible()
    await page.getByLabel('Editing flag').fill('1')
    await page.keyboard.press('Enter')
    await expect(gridRow(page, 'customer 1')).toContainText('trigger saw flag 1')
    const [row] = await scratch.q<{ note: string }>(`SELECT note FROM ${t} WHERE id = 1`)
    expect(row?.note).toBe('trigger saw flag 1')
  })

  test('a generated column is not editable; a normal cell of the same row is', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.gen`
    await scratch.q(
      `CREATE TABLE ${t} (id INT NOT NULL PRIMARY KEY, a INT NOT NULL,
         dbl INT GENERATED ALWAYS AS (a * 2) STORED)`,
    )
    await scratch.q(`INSERT INTO ${t} (id, a) VALUES (1, 7)`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'gen')

    const generated = cellOf(page, '14', /^14$/)
    await generated.dblclick()
    await expect(editorOpen(page)).toHaveCount(0)
    await generated.focus()
    await page.keyboard.press('F2')
    await expect(editorOpen(page)).toHaveCount(0)

    await cellOf(page, '14', /^7$/).dblclick()
    await expect(page.getByLabel('Editing a')).toBeVisible()
  })

  test('the cells of a view are not editable', async ({ page, scratch, address }) => {
    const base = `\`${scratch.name}\`.base`
    await scratch.q(`CREATE TABLE ${base} (id INT NOT NULL PRIMARY KEY, a INT NOT NULL)`)
    await scratch.q(`INSERT INTO ${base} VALUES (1, 77)`)
    await scratch.q(`CREATE VIEW \`${scratch.name}\`.v_base AS SELECT id, a FROM ${base}`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'v_base')

    const cell = cellOf(page, '77', /^77$/)
    await cell.dblclick()
    await expect(editorOpen(page)).toHaveCount(0)
    await cell.focus()
    await page.keyboard.press('F2')
    await expect(editorOpen(page)).toHaveCount(0)
  })

  test('with "Edit cells in the grid" off nothing starts editing', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 2)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    await page.getByRole('button', { name: 'Columns' }).click()
    const toggle = page.getByRole('checkbox', { name: 'Edit cells in the grid' })
    await expect(toggle).toBeChecked()
    await toggle.uncheck()
    await page.keyboard.press('Escape')

    try {
      const cell = cellOf(page, 'customer 1', 'customer 1')
      await cell.dblclick()
      await expect(editorOpen(page)).toHaveCount(0)
      await cell.focus()
      await page.keyboard.press('F2')
      await expect(editorOpen(page)).toHaveCount(0)
    } finally {
      // The preference is global and saved on the server: put it back, or later specs cannot edit in place.
      await page.getByRole('button', { name: 'Columns' }).click()
      await page.getByRole('checkbox', { name: 'Edit cells in the grid' }).check()
      await page.keyboard.press('Escape')
    }
  })

  test('a cut cell carries the hint with the length and the start of the value', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.longtext`
    await scratch.q(`CREATE TABLE ${t} (id INT NOT NULL PRIMARY KEY, v VARCHAR(600) NOT NULL)`)
    await scratch.q(`INSERT INTO ${t} VALUES (1, ?)`, [`start-${'x'.repeat(494)}`])
    await signIn(page, address)
    await openTable(page, scratch.name, 'longtext')

    const cell = gridRow(page, 'start-').getByRole('gridcell').filter({ hasText: 'start-' }).first()
    await expect(cell).toHaveAttribute('title', /500 characters\. Starts with: start-/)
  })
})

test.describe('SCN-039 form dirty tracking and displayed values', () => {
  test('a field edited back to its original value is not dirty', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.dirty`
    await scratch.q(
      `CREATE TABLE ${t} (id INT NOT NULL PRIMARY KEY, name VARCHAR(50) NOT NULL, txt TEXT NULL)`,
    )
    await scratch.q(`INSERT INTO ${t} VALUES (1, 'row one', 'original text')`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'dirty')
    await openEditForm(page, 'row one')
    const dialog = page.getByRole('dialog')
    const field = dialog.getByRole('textbox', { name: 'txt', exact: true })
    await expect(field).toHaveValue('original text')

    const posts = countServerCalls(page)
    await field.fill('changed')
    await field.fill('original text')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('No changes. Nothing was sent.')).toBeVisible()
    expect(posts()).toBe(0)
    const [row] = await scratch.q<{ txt: string }>(`SELECT txt FROM ${t}`)
    expect(row?.txt).toBe('original text')
  })

  test('a TIMESTAMP field has no preselected function and shows the time zone; BIT matches grid and form', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.stamps`
    await scratch.q(
      `CREATE TABLE ${t} (id INT NOT NULL PRIMARY KEY, name VARCHAR(50) NOT NULL,
         ts TIMESTAMP NULL, bt BIT(12) NULL)`,
    )
    await scratch.q(
      `INSERT INTO ${t} VALUES (1, 'stamp row', '2024-03-05 12:34:56', b'000000000101')`,
    )
    await signIn(page, address)
    await openTable(page, scratch.name, 'stamps')

    await expect(gridRow(page, 'stamp row')).toContainText("b'000000000101'")
    await openEditForm(page, 'stamp row')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('textbox', { name: 'bt', exact: true })).toHaveValue(
      "b'000000000101'",
    )
    await expect(dialog.getByRole('textbox', { name: 'ts', exact: true })).toHaveValue(
      /2024-03-05 12:34:56/,
    )
    await expect(dialog.getByText(/time zone/i).first()).toBeVisible()
    // No function select is shown for the timestamp: the value mode is active, not NOW() and friends.
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.getByText('NOW()')).toHaveCount(0)

    const posts = countServerCalls(page)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('No changes. Nothing was sent.')).toBeVisible()
    expect(posts()).toBe(0)
  })

  test('the form pre-fills from a row with a 5 000 character value and saves nothing untouched', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.longval`
    await scratch.q(
      `CREATE TABLE ${t} (id INT NOT NULL PRIMARY KEY, name VARCHAR(50) NOT NULL, k VARCHAR(5000) NOT NULL)`,
    )
    const long = Array.from({ length: 500 }, (_, i) => `k${String(i).padStart(9, '0')}`).join('')
    expect(long).toHaveLength(5000)
    await scratch.q(`INSERT INTO ${t} VALUES (1, 'long row', ?)`, [long])
    const checksum = async () =>
      (await scratch.q<{ Checksum: string }>(`CHECKSUM TABLE ${t}`))[0]?.Checksum
    const before = await checksum()
    await signIn(page, address)
    await openTable(page, scratch.name, 'longval')
    await openEditForm(page, 'long row')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('long row')

    const posts = countServerCalls(page)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('No changes. Nothing was sent.')).toBeVisible()
    expect(posts()).toBe(0)
    expect(await checksum()).toBe(before)
  })
})

test.describe('SCN-043 generated invisible primary key', () => {
  test('my_row_id is the identity: hidden, edit works, never written', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    test.skip(product === 'mariadb', 'sql_generate_invisible_primary_key exists on MySQL only')
    const t = `\`${scratch.name}\`.inv`
    await scratch.q('SET SESSION sql_generate_invisible_primary_key = ON')
    await scratch.q(`CREATE TABLE ${t} (name VARCHAR(50) NOT NULL)`)
    await scratch.q('SET SESSION sql_generate_invisible_primary_key = OFF')
    await scratch.q(`INSERT INTO ${t} (name) VALUES ('first'), ('second')`)
    const ids = () => scratch.q(`SELECT my_row_id, name FROM ${t} ORDER BY my_row_id`)
    const before = await ids()
    expect(before).toHaveLength(2)

    await signIn(page, address)
    await openTable(page, scratch.name, 'inv')
    await expect(page.getByRole('columnheader', { name: 'name' }).first()).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /my_row_id/ })).toHaveCount(0)

    await cellOf(page, 'first', 'first').dblclick()
    await expect(page.getByLabel('Editing name')).toBeVisible()
    await page.getByLabel('Editing name').fill('first edited')
    await page.keyboard.press('Enter')
    await expect(gridRow(page, 'first edited')).toBeVisible()

    const after = await ids()
    expect(after).toEqual([
      { my_row_id: (before[0] as { my_row_id: unknown }).my_row_id, name: 'first edited' },
      before[1],
    ])
  })
})

test.describe('SCN-044 two real browser contexts', () => {
  test('different column saves, same column conflicts, Overwrite works, deleted row is gone', async ({
    browser,
    baseURL,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    const table = `\`${scratch.name}\`.customer`
    const ctxA = await browser.newContext({ baseURL })
    const ctxB = await browser.newContext({ baseURL })
    try {
      const a = await ctxA.newPage()
      const b = await ctxB.newPage()
      for (const page of [a, b]) {
        await signIn(page, address)
        await openTable(page, scratch.name, 'customer')
      }
      const stored = async () =>
        (
          await scratch.q<{ name: string; email: string }>(
            `SELECT name, email FROM ${table} WHERE id = 1`,
          )
        )[0]
      const save = (page: Page) =>
        page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
      const nameField = (page: Page) =>
        page.getByRole('dialog').getByRole('textbox', { name: 'name', exact: true })

      // Both open the row.
      await openEditForm(a, 'customer 1')
      await openEditForm(b, 'customer 1')
      await expect(nameField(b)).toHaveValue('customer 1')

      // Step 1: A saves a new name.
      await nameField(a).fill('by A')
      await save(a)
      await expect.poll(async () => (await stored())?.name).toBe('by A')

      // Step 2: B, still on the old snapshot, saves a different column.
      await b
        .getByRole('dialog')
        .getByRole('textbox', { name: 'email', exact: true })
        .fill('b@example.test')
      await save(b)
      await expect.poll(async () => (await stored())?.email).toBe('b@example.test')
      expect((await stored())?.name).toBe('by A')
      await expect(b.getByRole('dialog')).toHaveCount(0)

      // Step 3: B opens the row (name `by A`), then A changes the name again; B's save of the name conflicts.
      await expect(gridRow(b, 'by A')).toBeVisible()
      await openEditForm(b, 'by A')
      await expect(nameField(b)).toHaveValue('by A')
      await expect(gridRow(a, 'by A')).toBeVisible()
      await openEditForm(a, 'by A')
      await nameField(a).fill('by A2')
      await save(a)
      await expect.poll(async () => (await stored())?.name).toBe('by A2')

      await nameField(b).fill('by B')
      await save(b)
      await expect(b.getByText(/changed by someone else/i).first()).toBeVisible()
      expect((await stored())?.name).toBe('by A2')

      // Step 5: Overwrite is a second explicit click and succeeds.
      await b.getByRole('button', { name: /Overwrite/ }).click()
      await expect.poll(async () => (await stored())?.name).toBe('by B')
      await expect(b.getByRole('dialog')).toHaveCount(0)

      // Step 4: A deletes the row; B's save reports that it is gone.
      await expect(gridRow(b, 'by B')).toBeVisible()
      await openEditForm(b, 'by B')
      // A's grid still shows `by A2`; refresh first, or the delete would (rightly) conflict with B's overwrite.
      await a.getByRole('button', { name: 'Refresh' }).click()
      await expect(gridRow(a, 'by B')).toBeVisible()
      await gridRow(a, 'by B').getByRole('button', { name: 'Delete row' }).click()
      await a
        .getByRole('dialog')
        .getByRole('button', { name: /^Delete/ })
        .last()
        .click()
      await expect
        .poll(async () => scratch.q(`SELECT id FROM ${table} WHERE id = 1`))
        .toHaveLength(0)

      await nameField(b).fill('too late')
      await save(b)
      await expect(b.getByText('This row no longer exists').first()).toBeVisible()
      expect(await scratch.q(`SELECT id FROM ${table} WHERE id = 1`)).toHaveLength(0)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
