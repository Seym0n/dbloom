import type { Locator, Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures/scratch-db'
import { openTable, seedRowsCustomer } from './fixtures/rows-fixtures'
import { capture, editInput, forge } from './fixtures/sql-fixtures'

/**
 * Sets a string property of the filter condition in a serialised getRows request. Conditions sit inside
 * serialised arrays (`a`), which `editInput` does not walk, so this walks every object value.
 */
function setConditionProperty(body: string, key: 'column' | 'op', value: string): string {
  const root = JSON.parse(body) as unknown
  let changed = false
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    const node = n as { p?: { k: string[]; v: unknown[] } }
    if (node.p && node.p.k.includes('column') && node.p.k.includes('op')) {
      node.p.v[node.p.k.indexOf(key)] = { t: 1, s: value }
      changed = true
    }
    Object.values(n).forEach(walk)
  }
  walk(root)
  if (!changed) throw new Error('no filter condition found in the request')
  return JSON.stringify(root)
}

/** SCN-046 of SPEC/24, the parts rows-filter.spec.ts does not cover: nested filter, paging reset, operators, forgeries. */

const filterButton = (page: Page) => page.getByRole('button', { name: /^Filter/ }).first()

async function openFilter(page: Page) {
  await filterButton(page).click()
  return page.getByRole('dialog')
}

/** Sets condition `n` (column, operator label) in `scope`. */
async function setCondition(scope: Locator, n: number, column: string, operator: string) {
  await scope.getByRole('combobox', { name: `Column of condition ${n}` }).selectOption(column)
  await scope
    .getByRole('combobox', { name: `Operator of condition ${n}` })
    .selectOption({ label: operator })
}

async function applyFilter(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(dialog).toBeHidden()
}

/** Applies `name contains "customer"` as the only condition. */
async function applyContains(page: Page, text: string) {
  const dialog = await openFilter(page)
  await setCondition(dialog, 1, 'name', 'contains')
  await dialog.getByRole('textbox', { name: 'Value of condition 1', exact: true }).fill(text)
  await applyFilter(dialog)
}

const header = (page: Page, column: string) =>
  page
    .getByRole('grid')
    .getByRole('columnheader', { name: new RegExp(`^${column}`) })
    .first()

async function optionLabels(dialog: Locator, n: number) {
  const texts = await dialog
    .getByRole('combobox', { name: `Operator of condition ${n}` })
    .locator('option')
    .allTextContents()
  return texts.map((s) => s.trim())
}

const COMPARE = [
  'equals',
  'does not equal',
  'is less than',
  'is at most',
  'is greater than',
  'is at least',
  'is between',
  'is not between',
]
const NULLS = ['is NULL', 'is not NULL']
const TEXT_OPS = [
  'contains',
  'does not contain',
  'starts with',
  'ends with',
  'equals',
  'does not equal',
  'is an empty string',
  'is not an empty string',
  'matches LIKE pattern',
  'does not match LIKE pattern',
  'matches regular expression',
  'is one of',
  'is none of',
  ...NULLS,
]

test.describe('SCN-046 filter builder, more', () => {
  test('nested group: (name contains "ann" AND created between X AND Y) OR email is NULL matches SQL', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 0)
    const t = `\`${scratch.name}\`.customer`
    await scratch.q(`ALTER TABLE ${t} MODIFY email VARCHAR(100) NULL`)
    await scratch.q(`INSERT INTO ${t} (name, email, created) VALUES ?`, [
      [
        ['Ann Lee', 'a1@example.test', '2024-03-10 10:00:00'],
        ['Joanna Ray', 'a2@example.test', '2024-05-01 00:00:00'],
        ['Bob Stone', null, '2024-01-01 00:00:00'],
        ['Hannah Quinn', 'a4@example.test', '2024-03-20 12:00:00'],
        ['Carl Dee', 'a5@example.test', null],
        ['Ann Outside', null, null],
        ['Dora Fox', 'a7@example.test', '2024-03-15 00:00:00'],
      ],
    ])
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    const dialog = await openFilter(page)
    // Root: any of (or); condition 1 is `email is NULL`; then the nested AND group.
    await dialog
      .getByRole('combobox', { name: 'How the conditions combine' })
      .first()
      .selectOption({ label: 'any of these (or)' })
    await setCondition(dialog, 1, 'email', 'is NULL')
    await dialog.getByRole('button', { name: 'Add group' }).click()

    const nested = dialog.getByRole('group', { name: 'Nested group, level 2' })
    await expect(nested).toBeVisible()
    await nested
      .getByRole('combobox', { name: 'How the conditions combine' })
      .selectOption({ label: 'all of these (and)' })
    await nested.getByRole('button', { name: 'Add condition' }).click()
    await nested.getByRole('button', { name: 'Add condition' }).click()
    await setCondition(nested, 2, 'name', 'contains')
    await nested.getByRole('textbox', { name: 'Value of condition 2', exact: true }).fill('ann')
    await setCondition(nested, 3, 'created', 'is between')
    await nested
      .getByRole('textbox', { name: 'From value of condition 3' })
      .fill('2024-03-01 00:00:00')
    await nested
      .getByRole('textbox', { name: 'To value of condition 3' })
      .fill('2024-03-31 23:59:59')
    await applyFilter(dialog)

    const expected = await scratch.q<{ name: string }>(
      `SELECT name FROM ${t}
        WHERE (name LIKE '%ann%' AND created BETWEEN '2024-03-01 00:00:00' AND '2024-03-31 23:59:59')
           OR email IS NULL
        ORDER BY id`,
    )
    expect(expected.map((r) => r.name)).toEqual([
      'Ann Lee',
      'Bob Stone',
      'Hannah Quinn',
      'Ann Outside',
    ])
    const grid = page.getByRole('grid')
    await expect(grid.getByRole('row')).toHaveCount(expected.length + 1)
    for (const { name } of expected)
      await expect(grid.getByText(name, { exact: true })).toBeVisible()
    await expect(grid.getByText('Joanna Ray')).toHaveCount(0)
    await expect(grid.getByText('Carl Dee')).toHaveCount(0)
    await expect(grid.getByText('Dora Fox')).toHaveCount(0)
    await expect(page.locator('code')).toContainText('WHERE')
  })

  test('changing the filter resets to page 1; refresh keeps the filter, the page and the two-column sort', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 60)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    await header(page, 'name').getByRole('button').click()
    await header(page, 'email')
      .getByRole('button')
      .click({ modifiers: ['Shift'] })
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'ascending')
    await expect(header(page, 'email')).toHaveAttribute('aria-sort', 'ascending')
    await expect(header(page, 'name').getByLabel('sort position 1')).toBeVisible()
    await expect(header(page, 'email').getByLabel('sort position 2')).toBeVisible()
    await expect(page.locator('code')).toContainText(/ORDER BY `name`.*`email`/)

    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Rows 51–60')).toBeVisible()

    await applyContains(page, 'customer')
    await expect(page.getByText('Rows 1–50')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Active filter' })).toBeVisible()

    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Rows 51–60')).toBeVisible()
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.getByText('Rows 51–60')).toBeVisible()
    await expect(page.getByRole('group', { name: 'Active filter' })).toBeVisible()
    await expect(page.locator('code')).toContainText('WHERE')
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'ascending')
    await expect(header(page, 'email')).toHaveAttribute('aria-sort', 'ascending')

    // A different filter goes back to page 1 again.
    await applyContains(page, 'customer 1')
    await expect(page.getByText(/Rows 1–\d+/)).toBeVisible()
    await expect(page.getByText('Rows 51–60')).toHaveCount(0)
  })

  test('between shows two inputs; in keeps a list and ignores a duplicate value', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 8)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    const grid = page.getByRole('grid')

    const dialog = await openFilter(page)
    await setCondition(dialog, 1, 'id', 'is between')
    await expect(dialog.getByRole('textbox', { name: 'From value of condition 1' })).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'To value of condition 1' })).toBeVisible()
    await expect(
      dialog.getByRole('textbox', { name: 'Value of condition 1', exact: true }),
    ).toHaveCount(0)
    await dialog.getByRole('textbox', { name: 'From value of condition 1' }).fill('2')
    await dialog.getByRole('textbox', { name: 'To value of condition 1' }).fill('4')
    await applyFilter(dialog)
    await expect(grid.getByRole('row')).toHaveCount(3 + 1)
    for (const n of [2, 3, 4])
      await expect(grid.getByText(`customer ${n}`, { exact: true })).toBeVisible()

    const again = await openFilter(page)
    await setCondition(again, 1, 'name', 'is one of')
    const input = again.getByRole('textbox', { name: 'Value of condition 1', exact: true })
    await expect(again.getByRole('textbox', { name: 'From value of condition 1' })).toHaveCount(0)
    await input.fill('customer 5')
    await input.press('Enter')
    await input.fill('customer 5')
    await input.press('Enter')
    await input.fill('customer 7')
    await again.getByRole('button', { name: 'Add a value' }).click()
    await input.fill('customer 7')
    await input.press('Enter')
    const values = again.getByRole('list', { name: 'Values' }).getByRole('listitem')
    await expect(values).toHaveCount(2)
    await expect(values.nth(0)).toContainText('customer 5')
    await expect(values.nth(1)).toContainText('customer 7')
    await applyFilter(again)
    await expect(grid.getByRole('row')).toHaveCount(2 + 1)
    await expect(grid.getByText('customer 5', { exact: true })).toBeVisible()
    await expect(grid.getByText('customer 7', { exact: true })).toBeVisible()
  })

  test('operators offered depend on the column kind', async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 1)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    const dialog = await openFilter(page)

    await dialog.getByRole('combobox', { name: 'Column of condition 1' }).selectOption('id')
    const numeric = await optionLabels(dialog, 1)
    expect(numeric).toEqual([...COMPARE, 'is one of', 'is none of', ...NULLS])
    expect(numeric).not.toContain('contains')

    await dialog.getByRole('combobox', { name: 'Column of condition 1' }).selectOption('name')
    const text = await optionLabels(dialog, 1)
    expect(text).toEqual(TEXT_OPS)
    expect(text).not.toContain('is between')
    expect(text).not.toContain('is less than')

    await dialog.getByRole('combobox', { name: 'Column of condition 1' }).selectOption('note')
    expect(await optionLabels(dialog, 1)).toEqual(TEXT_OPS)

    await dialog.getByRole('combobox', { name: 'Column of condition 1' }).selectOption('created')
    const temporal = await optionLabels(dialog, 1)
    expect(temporal).toEqual([...COMPARE, ...NULLS])
    expect(temporal).not.toContain('contains')
    expect(temporal).not.toContain('is one of')
  })

  test('LIKE wildcards typed into "contains" match literally', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 0)
    const t = `\`${scratch.name}\`.customer`
    await scratch.q(`INSERT INTO ${t} (name, email) VALUES ?`, [
      [
        ['Cy 100% Real', 'w1@example.test'],
        ['Cy 100x Real', 'w2@example.test'],
        ['a_b', 'w3@example.test'],
        ['axb', 'w4@example.test'],
        ['plain', 'w5@example.test'],
      ],
    ])
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    const grid = page.getByRole('grid')

    await applyContains(page, '%')
    await expect(grid.getByRole('row')).toHaveCount(1 + 1)
    await expect(grid.getByText('Cy 100% Real')).toBeVisible()

    await applyContains(page, 'a_b')
    await expect(grid.getByRole('row')).toHaveCount(1 + 1)
    await expect(grid.getByText('a_b', { exact: true })).toBeVisible()
    await expect(grid.getByText('axb', { exact: true })).toHaveCount(0)

    await applyContains(page, '100%')
    await expect(grid.getByRole('row')).toHaveCount(1 + 1)
    await expect(grid.getByText('Cy 100x Real')).toHaveCount(0)
  })

  test.fixme('the default string operator setting turns "contains" into "starts with"', async () => {
    // rows.defaultStringOperator is read in rows-grid.tsx (preferredOperator) and validated in
    // src/server/rows/prefs.ts, but no component renders a control for it (grep finds no UI),
    // and a hand-made setPref call cannot be shaped reliably without running the app.
    // Enable when the settings dialog gets a "default string operator" control.
  })
})

test.describe('SCN-046 forged getRows requests', () => {
  test('a request with a "where" field is rejected', async ({ page, scratch, address }) => {
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    const seen = capture(page, ['pageSize', 'db', 'table'])
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    const real = seen.at(-1)!

    const control = await forge(page, real, real.body)
    expect(await control.text()).toContain('customer 1')

    // Add a `where` property to the input object itself (the object that carries `pageSize`).
    const withWhere = editInput(real.body, 'pageSize', (o) => {
      o.k.push('where')
      o.v.push({ t: 1, s: '1 = 1 OR 1 = 1' } as never)
    })
    const forged = await forge(page, real, withWhere)
    const text = await forged.text()
    expect(text).not.toContain('customer 1')
    expect(text).not.toContain('customer 3')
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM \`${scratch.name}\`.customer`)).toEqual([
      { n: 3 },
    ])
  })

  test('an unknown column name or an operator not allowed for the kind is rejected', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    const dialog = await openFilter(page)
    await setCondition(dialog, 1, 'id', 'equals')
    await dialog.getByRole('textbox', { name: 'Value of condition 1', exact: true }).fill('1')
    await applyFilter(dialog)
    await expect(page.getByRole('grid').getByRole('row')).toHaveCount(1 + 1)

    const seen = capture(page, ['filter', 'pageSize'])
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    const real = seen.at(-1)!

    const control = await forge(page, real, real.body)
    expect(await control.text()).toContain('customer 1')

    // Column that does not exist.
    const unknownColumn = await forge(page, real, setConditionProperty(real.body, 'column', 'nope'))
    const unknownText = await unknownColumn.text()
    expect(unknownText).not.toContain('customer 1')

    // `contains` on an INT column: not in the allow-list.
    const badOp = await forge(page, real, setConditionProperty(real.body, 'op', 'contains'))
    expect(await badOp.text()).not.toContain('customer 1')
  })
})
