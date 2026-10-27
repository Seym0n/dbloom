import { expect, signIn, test } from './fixtures/scratch-db'
import type { Page } from '@playwright/test'
import { fixture, openImport, pickFile, seedIoCustomer, upload } from './fixtures/io-fixtures'

/** SCN-059 (CSV into an existing table) and SCN-060 (CSV and JSON into a new table) of SPEC/25. */

const dialog = (page: Page) => page.getByRole('dialog')
const finished = (page: Page) => page.getByRole('status').getByRole('heading').first()

async function startImport(page: Page) {
  await page.getByRole('button', { name: 'Import…', exact: true }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Import this file?' })).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Import', exact: true }).click()
}

const csvFile = () => ({
  name: 'customers.csv',
  mimeType: 'text/csv',
  buffer: fixture('customers-semicolon.csv'),
})

test.describe('SCN-059 CSV import into an existing table', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await seedIoCustomer(scratch, 0)
    await signIn(page, address)
    await openImport(page, scratch.name, 'customer')
    await pickFile(page, csvFile())
    // The default comma cannot read the quoted cells of this file: the analysis says so and keeps the options open.
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByLabel('Separator').selectOption(';')
    await expect(page.getByRole('region', { name: 'Sample rows' })).toBeVisible()
  })

  test('all or nothing: rolls back, names row and column of the bad row, state failed', async ({
    page,
    scratch,
  }) => {
    await page.getByLabel('Separator').selectOption(';')
    await page.getByLabel('First row has column names').check()
    await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
    await startImport(page)
    await expect(finished(page)).toHaveText('Failed')
    const result = page.getByRole('status')
    await expect(result).toContainText(/row 3|Row 3|4 fields|field/i)
    const [n] = await scratch.q<{ n: number }>(
      'SELECT COUNT(*) AS n FROM `' + scratch.name + '`.customer',
    )
    expect(Number(n?.n)).toBe(0)
  })

  test('keep going: good rows in, rejected row listed, never plain success', async ({
    page,
    scratch,
  }) => {
    await page.getByLabel('Separator').selectOption(';')
    await page.getByLabel('First row has column names').check()
    await page.getByRole('radio', { name: 'Keep going and list rejected rows' }).check()
    await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
    await startImport(page)
    await expect(finished(page)).toHaveText('Finished, some rows were rejected')
    const result = page.getByRole('status')
    await expect(result).toContainText('Done, with rejected rows')
    await expect(result).toContainText('Rejected rows (1)')
    await expect(result.getByText('Rows', { exact: true }).locator('..')).toContainText('3')
    const rows = await scratch.q<{ name: string; note: string; amount: string }>(
      'SELECT name, note, amount FROM `' + scratch.name + '`.customer ORDER BY id',
    )
    expect(rows.map((r) => r.name)).toEqual(['alice', 'bob', 'dave'])
    expect(rows[0]?.note).toBe('line one\nline two')
    // The hostile cell is data; the table still exists.
    expect(rows[1]?.note).toBe("'); DROP TABLE customer; --")
  })
})

test('SCN-059 a wrong separator is detected in the preview (merged columns)', async ({
  page,
  scratch,
  address,
}) => {
  await seedIoCustomer(scratch, 0)
  await signIn(page, address)
  await openImport(page, scratch.name, 'customer')
  await pickFile(page, upload('plain.csv', 'name;amount\nann;1\nbo;2\n', 'text/csv'))
  await expect(page.getByText('All values are in one column')).toBeVisible()
  await page.getByLabel('Separator').selectOption(';')
  await expect(page.getByText('All values are in one column')).toHaveCount(0)
})

test.describe('SCN-059 conflict modes', () => {
  const csv = 'id;name\n1;new one\n3;new three\n'
  for (const mode of ['ignore', 'replace', 'error'] as const) {
    test(`conflict ${mode}`, async ({ page, scratch, address }) => {
      await seedIoCustomer(scratch, 0)
      await scratch.q(
        'INSERT INTO `' +
          scratch.name +
          "`.customer (id, name) VALUES (1, 'old one'), (2, 'old two')",
      )
      await signIn(page, address)
      await openImport(page, scratch.name, 'customer')
      await pickFile(page, upload('c.csv', csv, 'text/csv'))
      await page.getByLabel('Separator').selectOption(';')
      await page.getByLabel('First row has column names').check()
      await page.getByLabel('When a row already exists').selectOption(mode)
      await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
      await startImport(page)
      const names = async () =>
        (
          await scratch.q<{ id: number; name: string }>(
            'SELECT id, name FROM `' + scratch.name + '`.customer ORDER BY id',
          )
        ).map((r) => `${r.id}:${r.name}`)
      if (mode === 'error') {
        await expect(finished(page)).toHaveText('Failed')
        expect(await names()).toEqual(['1:old one', '2:old two'])
      } else {
        await expect(finished(page)).toHaveText('Import finished')
        expect(await names()).toEqual(
          mode === 'ignore'
            ? ['1:old one', '2:old two', '3:new three']
            : ['1:new one', '2:old two', '3:new three'],
        )
      }
    })
  }
})

test.describe('SCN-060 CSV and JSON into a new table', () => {
  test('CSV: proposed types, an edited type, builder SQL, reserved word column, then the rows', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await pickFile(page, { name: 'typed.csv', mimeType: 'text/csv', buffer: fixture('typed.csv') })
    await page.getByLabel('First row has column names').check()
    await page.getByRole('radio', { name: 'A new table' }).check()
    await expect(page.getByLabel('Table name')).toHaveValue('imported')
    const col = (i: number) =>
      page
        .getByRole('listitem')
        .filter({ has: page.getByLabel('Column', { exact: true }) })
        .nth(i)
    void col
    const type = (name: string) =>
      page
        .getByRole('listitem')
        .filter({ has: page.locator(`input[value="${name}"]`) })
        .getByLabel('Type')
    await expect(type('id')).toHaveValue('bigint')
    await expect(type('price')).toHaveValue('decimal')
    await expect(type('seen')).toHaveValue('datetime')
    await expect(type('bio')).toHaveValue('text')
    await expect(type('select')).toHaveValue('varchar')
    // The CREATE TABLE comes from the structure builder and quotes `select`.
    const sql = page.getByRole('heading', { name: 'SQL that will create the table' }).locator('..')
    await expect(sql).toContainText('CREATE TABLE')
    await expect(sql).toContainText('`select`')
    await expect(sql).toContainText('`imported`')
    // Edit one type: the SQL follows.
    await type('price').selectOption('varchar')
    await expect(sql).toContainText('`price` varchar')
    await type('price').selectOption('decimal')
    await startImport(page)
    await expect(finished(page)).toHaveText('Import finished')
    const rows = await scratch.q<Record<string, string | number>>(
      'SELECT id, price, `select` AS s FROM `' + scratch.name + '`.imported ORDER BY id',
    )
    expect(rows.map((r) => [String(r.id), String(r.s)])).toEqual([
      ['1', 'a'],
      ['2', 'b'],
      ['3000000000', 'c'],
    ])
    await expect(page.getByRole('button', { name: 'Open imported' })).toBeVisible()
  })

  test('JSON: a 20-digit number is kept exactly', async ({ page, scratch, address }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await pickFile(page, {
      name: 'numbers.json',
      mimeType: 'application/json',
      buffer: fixture('numbers.json'),
    })
    await page.getByRole('radio', { name: 'A new table' }).check()
    await expect(page.getByRole('region', { name: 'Columns of the new table' })).toBeVisible()
    await startImport(page)
    await expect(finished(page)).toHaveText('Import finished')
    const rows = await scratch.q<{ id: string; name: string }>(
      'SELECT CAST(id AS CHAR) AS id, name FROM `' + scratch.name + '`.imported ORDER BY name',
    )
    expect(rows.map((r) => r.id)).toContain('12345678901234567890')
  })

  test('a failed import offers to drop the new table (a normal confirmed drop)', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    // Two columns, the second row has a text in a column proposed as integer by the sample of row 1.
    await pickFile(page, upload('bad.csv', 'n,v\n1,2\n2,xyz\n', 'text/csv'))
    await page.getByLabel('First row has column names').check()
    await page.getByRole('radio', { name: 'A new table' }).check()
    const type = page
      .getByRole('listitem')
      .filter({ has: page.locator('input[value="v"]') })
      .getByLabel('Type')
    await type.selectOption('int')
    await startImport(page)
    await expect(finished(page)).toHaveText('Failed')
    await page.getByRole('button', { name: 'Drop the new table imported' }).click()
    await expect(dialog(page)).toBeVisible()
  })
})
