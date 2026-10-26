import { expect, signIn, test, type Scratch } from './fixtures/scratch-db'
import { startDbloom } from './fixtures/sql-fixtures'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/**
 * SCN-049 (large tables) and SCN-051 steps 3 and 4 of SPEC/24 that rows-paging and rows-prefs leave open.
 * Slowness is made deterministic with `LOCK TABLES ... WRITE` on the test's own connection (reads of other
 * connections wait on the metadata lock until cancelled or killed by the watchdog), not with data volume.
 */

/** Second server of playwright.config.ts: DBLOOM_STATEMENT_TIMEOUT_SECONDS=2, DBLOOM_SQL_ROW_CAP=1000. */
const LIMITS_URL = 'http://localhost:3102'

const DIGITS = `(SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
                 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9)`

/** `table` (id INT PK, v INT) with ids 1..rows, analysed so the catalog estimate is close. */
async function seedSequence(scratch: Scratch, table: string, rows: number) {
  const db = `\`${scratch.name}\``
  await scratch.q(`CREATE TABLE ${db}.\`${table}\` (id INT NOT NULL PRIMARY KEY, v INT NOT NULL)`)
  await scratch.q(
    `INSERT INTO ${db}.\`${table}\`
       SELECT x.id, x.id % 1000
         FROM (SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n + 10000 * e.n + 100000 * f.n + 1 AS id
                 FROM ${DIGITS} a, ${DIGITS} b, ${DIGITS} c, ${DIGITS} d, ${DIGITS} e, ${DIGITS} f) x
        WHERE x.id <= ?`,
    [rows],
  )
  await scratch.q(`ANALYZE TABLE ${db}.\`${table}\``)
}

const range = (page: import('@playwright/test').Page, text: string | RegExp) =>
  page.getByText(text).first()

test.describe('SCN-049 large tables', () => {
  test('Count can be cancelled; the estimate stays and Count is offered again', async ({
    page,
    scratch,
    address,
  }) => {
    test.setTimeout(120_000)
    await seedSequence(scratch, 'big', 200_000)
    await signIn(page, address)
    await openTable(page, scratch.name, 'big')
    await expect(page.getByText(/about [\d,.\s ]+ rows/)).toBeVisible()

    // Hold a write lock so the count waits; the cancel then has something to cancel.
    await scratch.q(`LOCK TABLES \`${scratch.name}\`.big WRITE`)
    try {
      await page.getByRole('button', { name: 'Count' }).click()
      await expect(page.getByText('Counting rows…')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByText('Count cancelled.')).toBeVisible()
      await expect(page.getByText('Counting rows…')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Count' })).toBeVisible()
      await expect(page.getByText(/about [\d,.\s ]+ rows/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Last page' })).toBeDisabled()
    } finally {
      await scratch.q('UNLOCK TABLES')
    }

    // After the lock is gone a new Count works.
    await page.getByRole('button', { name: 'Count' }).click()
    await expect(page.getByText(/200[,.\s ]?000 rows/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Last page' })).toBeEnabled()
  })

  test('a view over a large table shows a lower bound; page and count times are shown separately', async ({
    page,
    scratch,
    address,
  }) => {
    test.setTimeout(120_000)
    const db = `\`${scratch.name}\``
    await seedSequence(scratch, 'base', 20_000)
    await scratch.q(`CREATE VIEW ${db}.vw AS SELECT id, v FROM ${db}.base`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'vw')

    await expect(page.getByText(/10[,.\s ]?000\+ rows/)).toBeVisible()
    await expect(page.getByText(/Loaded in [\d.]+ (ms|s)/)).toBeVisible()
    await page.getByRole('button', { name: 'Count' }).click()
    await expect(page.getByText(/counted in [\d.]+ (ms|s)/)).toBeVisible()
    // The count is capped, so it stays a lower bound and does not enable the last page.
    await expect(page.getByText(/10[,.\s ]?000\+ rows/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Last page' })).toBeDisabled()
    await expect(page.getByText(/Loaded in [\d.]+ (ms|s)/)).toBeVisible()
  })

  test('an offset above 100 000 shows the filter or SQL tab hint', async ({
    page,
    scratch,
    address,
  }) => {
    test.setTimeout(120_000)
    await seedSequence(scratch, 'big', 120_500)
    await signIn(page, address)
    await openTable(page, scratch.name, 'big')
    await expect(page.getByText(/about [\d,.\s ]+ rows/)).toBeVisible()
    await expect(page.getByRole('note')).toHaveCount(0)

    await page.getByLabel('Rows per page').selectOption('25')
    await expect(range(page, 'Rows 1–25')).toBeVisible()
    await page.getByRole('button', { name: 'Count' }).click()
    await expect(page.getByText(/120[,.\s ]?500 rows/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Last page' }).click()
    // 120 500 rows at 25 per page: the last page is 4 821, its first row 120 476.
    await expect(range(page, /Rows 120[,.\s ]?476/)).toBeVisible()
    await expect(
      page.getByText(
        'This is deep into the table and slow to reach. Filter the rows or use the SQL tab.',
      ),
    ).toBeVisible()

    await page.getByRole('button', { name: 'First page' }).click()
    await expect(range(page, 'Rows 1–25')).toBeVisible()
    await expect(page.getByText('This is deep into the table', { exact: false })).toHaveCount(0)
  })

  test('deleting the only row of the last page lands on the previous page', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 51)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await expect(range(page, 'Rows 1–50')).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(range(page, 'Rows 51–51')).toBeVisible()
    await expect(gridRow(page, 'customer 51')).toHaveCount(1)

    await gridRow(page, 'customer 51').getByRole('button', { name: 'Delete row' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/DELETE FROM/).first()).toBeVisible()
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()

    await expect(range(page, 'Rows 1–50')).toBeVisible()
    await expect(gridRow(page, 'customer 50')).toHaveCount(1)
    await expect(gridRow(page, 'customer 51')).toHaveCount(0)
    expect(
      await scratch.q(`SELECT id FROM \`${scratch.name}\`.customer WHERE name = 'customer 51'`),
    ).toHaveLength(0)
  })

  test('Shift+click sorts by two columns and the header shows the order', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 8)
    await scratch.q(`UPDATE \`${scratch.name}\`.customer SET flag = id % 2`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')

    const header = (name: string) =>
      page.getByRole('columnheader', { name: new RegExp(`^${name}`) })
    await header('flag').getByRole('button').click()
    await expect(header('flag')).toHaveAttribute('aria-sort', 'ascending')
    await header('name')
      .getByRole('button')
      .click({ modifiers: ['Shift'] })
    await expect(header('name')).toHaveAttribute('aria-sort', 'ascending')
    await expect(header('flag').getByLabel('sort position 1')).toBeVisible()
    await expect(header('name').getByLabel('sort position 2')).toBeVisible()
    await expect(page.locator('code').first()).toContainText('ORDER BY `flag`')
    await expect(page.locator('code').first()).toContainText('`name`')

    // Flag 0 first (ids 2, 4, 6, 8), each group by name.
    const firstRow = page.getByRole('grid').getByRole('row').nth(1)
    await expect(firstRow).toContainText('customer 2')
  })
})

test.describe('SCN-049 statement timeout', () => {
  // Third web server (port 3102): DBLOOM_STATEMENT_TIMEOUT_SECONDS=2, see playwright.config.ts.
  test.use({ baseURL: LIMITS_URL })

  test('a sort that cannot finish within the limit ends with the time-limit message and the page still renders', async ({
    page,
    scratch,
    address,
  }) => {
    test.setTimeout(120_000)
    await seedSequence(scratch, 'big', 5_000)
    await signIn(page, address)
    await openTable(page, scratch.name, 'big')
    await expect(page.getByRole('grid').getByRole('row').nth(1)).toBeVisible()

    // The sort statement waits on the table lock for longer than the 2 s limit; the watchdog kills it.
    await scratch.q(`LOCK TABLES \`${scratch.name}\`.big WRITE`)
    try {
      await page.getByRole('button', { name: 'v', exact: true }).click()
      await expect(page.getByText(/exceeded the time limit/i).first()).toBeVisible({
        timeout: 45_000,
      })
      // The table's own message and a Retry replace the rows; the toolbar and the pager stay.
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Pages' })).toBeVisible()
    } finally {
      await scratch.q('UNLOCK TABLES')
    }

    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByText(/exceeded the time limit/i)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByRole('columnheader', { name: /^v/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })
})

test.describe('SCN-051 display options', () => {
  test('size-only binary, partial text at 40 characters, full text, and the page size persist', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.blobby (id INT NOT NULL PRIMARY KEY, b VARBINARY(64) NULL, t TEXT NULL)`,
    )
    const text = `${'a'.repeat(39)}b${'c'.repeat(260)}END`
    await scratch.q(`INSERT INTO ${db}.blobby VALUES (1, ?, ?)`, [
      Buffer.from('deadbeef', 'hex'),
      text,
    ])
    await signIn(page, address)
    await openTable(page, scratch.name, 'blobby')

    try {
      const cellWith = (re: RegExp) => page.getByRole('gridcell').filter({ hasText: re })
      // Defaults: hex preview with the size, text cut at 100 characters.
      await expect(cellWith(/^0xDEADBEEF/i)).toHaveCount(1)
      await expect(cellWith(/^a{39}bc{60}…/)).toHaveCount(1)

      await page.getByRole('button', { name: 'Columns' }).click()
      const menu = page.getByRole('dialog', { name: 'Columns' })
      await menu.getByLabel('Binary values').selectOption({ label: 'Size only' })
      await menu.getByRole('spinbutton', { name: 'Characters shown per cell' }).fill('40')
      await page.keyboard.press('Escape')

      await expect(cellWith(/0xDEADBEEF/i)).toHaveCount(0)
      await expect(
        page.getByRole('gridcell').filter({ hasText: /\(4 B\)|\(4 bytes\)/ }),
      ).toHaveCount(1)
      const cut = cellWith(/^a{39}b/)
      await expect(cut).toHaveCount(1)
      await expect(cut).not.toContainText('cc')
      await expect(cut).toContainText('…')
      // A way to open the full value.
      await cut.hover()
      await expect(page.getByRole('button', { name: 'Open the full value of t' })).toBeVisible()

      // Full text: the whole value is in the cell and the length field is disabled.
      await page.getByRole('button', { name: 'Columns' }).click()
      await menu.getByRole('checkbox', { name: 'Show full text' }).check()
      await expect(
        menu.getByRole('spinbutton', { name: 'Characters shown per cell' }),
      ).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(cellWith(/^a{39}bc{260}END$/)).toHaveCount(1)
    } finally {
      // These display options are global and saved on the server: put them back for the specs that follow.
      await page.getByRole('button', { name: 'Columns' }).click()
      const menu = page.getByRole('dialog', { name: 'Columns' })
      await menu.getByRole('checkbox', { name: 'Show full text' }).uncheck()
      await menu.getByLabel('Binary values').selectOption({ label: 'Hex preview and size' })
      await menu.getByRole('spinbutton', { name: 'Characters shown per cell' }).fill('100')
      await page.keyboard.press('Escape')
    }
  })

  test('page size 100 survives closing and reopening the table', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 130)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await expect(range(page, 'Rows 1–50')).toBeVisible()
    await page.getByLabel('Rows per page').selectOption('100')
    await expect(range(page, 'Rows 1–100')).toBeVisible()

    await page.getByRole('button', { name: 'Close customer' }).click()
    await expect(page.getByRole('tab')).toHaveCount(0)
    await openTable(page, scratch.name, 'customer')
    await expect(page.getByLabel('Rows per page')).toHaveValue('100')
    await expect(range(page, 'Rows 1–100')).toBeVisible()
  })

  test('stateless mode keeps layout and page size for the session and writes no row value to browser storage', async ({
    browser,
    scratch,
    address,
  }) => {
    test.setTimeout(120_000)
    await seedRowsCustomer(scratch, 130)
    // The Playwright config has no stateless server; start one from the built output (DBLOOM_STORE=none).
    const server = await startDbloom(3117, { env: { DBLOOM_STORE: 'none' } })
    try {
      const context = await browser.newContext({ baseURL: server.url })
      const page = await context.newPage()
      await signIn(page, address)
      await openTable(page, scratch.name, 'customer')

      await page.getByLabel('Rows per page').selectOption('100')
      await expect(range(page, 'Rows 1–100')).toBeVisible()
      await page.getByRole('button', { name: 'Columns' }).click()
      await page
        .getByRole('dialog', { name: 'Columns' })
        .getByRole('checkbox', { name: /^note / })
        .uncheck()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'name', exact: true }).click()
      await expect(page.getByRole('columnheader', { name: 'name' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      )

      await page.getByRole('button', { name: 'Close customer' }).click()
      await expect(page.getByRole('tab')).toHaveCount(0)
      await openTable(page, scratch.name, 'customer')
      await expect(page.getByLabel('Rows per page')).toHaveValue('100')
      await expect(page.getByRole('columnheader', { name: 'name' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      )
      await expect(page.getByRole('columnheader', { name: 'note' })).toHaveCount(0)

      const stored = await page.evaluate(async () => {
        const dump: string[] = []
        for (const s of [localStorage, sessionStorage])
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i) as string
            dump.push(`${k}=${s.getItem(k)}`)
          }
        const dbs = (await indexedDB.databases?.()) ?? []
        dump.push(...dbs.map((d) => `idb:${d.name}`))
        return dump.join('\n')
      })
      expect(stored).not.toContain('customer 1')
      expect(stored).not.toContain('example.test')
      await context.close()
    } finally {
      await server.stop()
    }
  })
})
