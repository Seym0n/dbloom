import { expect, openSql, runAndWait, signIn, test } from './fixtures/sql-fixtures'
import { seedIoCustomer, customMode, dropPrefWrites, runExport } from './fixtures/io-fixtures'
import { openTable } from './fixtures/rows-fixtures'

/** SCN-052/055 entry points: the rows toolbar, the SQL result panel and a read-only session. */

test.describe('export entries', () => {
  test.beforeEach(async ({ page }) => {
    await dropPrefWrites(page)
  })

  test('rows toolbar: Export opens the export page of this table', async ({
    page,
    scratch,
    address,
  }) => {
    await seedIoCustomer(scratch, 30)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Export ${scratch.name}.customer`,
    )
    await expect(page.getByRole('tab', { name: 'Export customer' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const out = await runExport(page)
    expect(out.name).toBe(`customer_${scratch.name}.sql`)
    expect(out.body.toString('utf8')).toContain('CREATE TABLE `customer`')
    // A second click focuses the open tab instead of opening another one.
    await page.getByRole('tab', { name: /^customer$/ }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Export customer' })).toHaveCount(1)
  })

  test('SQL result: Export this result writes exactly that statement', async ({
    page,
    scratch,
    address,
  }) => {
    await seedIoCustomer(scratch, 50)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(
      page,
      'SELECT id, name FROM customer WHERE id <= 5 ORDER BY id DESC;\nSELECT DISTINCT amount FROM customer WHERE id <= 4 ORDER BY amount',
    )
    // Two statements: the export belongs to the selected result tab.
    await page.getByRole('tab', { name: 'Statement 2', exact: true }).click()
    await page.getByRole('button', { name: 'Export this result' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Export query result')
    await customMode(page)
    await page.getByLabel('Format', { exact: true }).selectOption('csv')
    const out = await runExport(page)
    expect(out.name).toBe('export.csv')
    expect(out.body.toString('utf8').trim().split(/\r?\n/)).toEqual([
      'amount',
      '1.25',
      '2.50',
      '3.75',
      '5.00',
    ])
  })

  test('SQL result: first statement, SQL format keeps the column types', async ({
    page,
    scratch,
    address,
  }) => {
    await seedIoCustomer(scratch, 50)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SELECT id, name, big FROM customer WHERE id <= 3 ORDER BY id')
    await page.getByRole('button', { name: 'Export this result' }).click()
    await customMode(page)
    const out = await runExport(page)
    const sql = out.body.toString('utf8')
    expect(sql).toContain('(1,')
    expect(sql).toContain('9007199254740993')
    expect(sql).toContain("'customer 3'")
  })

  test('cancel stops a long result export; no file is offered', async ({
    page,
    scratch,
    address,
  }) => {
    await seedIoCustomer(scratch, 300)
    await scratch.q(`CREATE TABLE \`${scratch.name}\`.slowflag (x INT)`)
    await signIn(page, address)
    await openSql(page, scratch.name)
    // Fast while slowflag is empty; the export of the same statement is slow once it has a row.
    await runAndWait(
      page,
      'SELECT a.id, b.id AS b, c.id AS c FROM customer a, customer b, customer c WHERE a.id <= IF((SELECT COUNT(*) FROM slowflag) = 0, 1, 1000000)',
    )
    await scratch.q(`INSERT INTO \`${scratch.name}\`.slowflag VALUES (1)`)
    await page.getByRole('button', { name: 'Export this result' }).click()
    let downloaded = false
    page.on('download', () => (downloaded = true))
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Cancelled' }).first()).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('link', { name: 'Download again' })).toHaveCount(0)
    expect(downloaded).toBe(false)
    // The dedicated connection is gone.
    await expect
      .poll(
        async () =>
          (
            await scratch.q<{ n: number }>(
              `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%slowflag%' AND INFO NOT LIKE '%PROCESSLIST%'`,
            )
          )[0]?.n,
        { timeout: 10_000 },
      )
      .toBe(0)
  })
})

test.describe('SCN-052 read-only session', () => {
  test.use({ baseURL: 'http://localhost:3101' })

  test('export still works', async ({ page, scratch, address }) => {
    await dropPrefWrites(page)
    await seedIoCustomer(scratch, 30)
    await signIn(page, address)
    await page.getByRole('navigation', { name: 'Databases' }).waitFor()
    const { openExport } = await import('./fixtures/io-fixtures')
    await openExport(page, scratch.name, 'customer')
    const out = await runExport(page)
    expect(out.body.toString('utf8')).toContain('INSERT INTO `customer`')
  })
})
