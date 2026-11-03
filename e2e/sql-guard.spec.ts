import type { Page } from '@playwright/test'
import {
  type Captured,
  capture,
  dropProperty,
  editInput,
  forge,
  replaceString,
  succeeded,
  LIMITS_ROW_CAP,
  LIMITS_TIMEOUT_S,
  LIMITS_URL,
  READ_ONLY_URL,
  confirmDialog,
  confirmHard,
  countRows,
  expect,
  gridOf,
  gridRowCount,
  openSql,
  quote,
  resultsOf,
  run,
  runAndWait,
  runButton,
  seedRows,
  setRunOption,
  setSql,
  signIn,
  threadsRunning,
  test,
} from './fixtures/sql-fixtures'
import { tableNames } from './fixtures/scratch-db'

test.describe('SCN-026 destructive statements need the server-side confirmation', () => {
  test('DELETE without WHERE, constant-true UPDATE and DROP ask first; a real WHERE does not', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'customer', 1000)
    await signIn(page, address)
    await openSql(page, scratch.name)
    const dialog = confirmDialog(page)

    // 1. DELETE without WHERE: dialog with reason and estimate; Cancel runs nothing.
    await run(page, 'DELETE FROM customer')
    await expect(dialog).toContainText('Can delete data')
    await expect(dialog).toContainText('No WHERE condition, so every row is affected.')
    await expect(dialog).toContainText('DELETE FROM customer')
    const estimate = dialog.getByText(/^about [\d,]+ rows$/)
    await expect(estimate).toBeVisible()
    const guessed = Number((await estimate.innerText()).replace(/\D/g, ''))
    expect(guessed).toBeGreaterThanOrEqual(500)
    expect(guessed).toBeLessThanOrEqual(2000)
    // The button stays disabled until the acknowledgement is ticked.
    await expect(dialog.getByRole('button', { name: 'Run anyway' })).toBeDisabled()
    expect(await countRows(scratch, 'customer')).toBe(1000)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(resultsOf(page)).toHaveCount(0)
    expect(await countRows(scratch, 'customer')).toBe(1000)

    // 2. A real WHERE runs without a dialog.
    await runAndWait(page, 'DELETE FROM customer WHERE id = 5')
    await expect(dialog).toHaveCount(0)
    await expect(resultsOf(page).getByText('1 rows affected')).toBeVisible()
    expect(await countRows(scratch, 'customer')).toBe(999)

    // 4. A constant-true WHERE is as bad as none.
    await run(page, "UPDATE customer SET name = 'x' WHERE 1 = 1")
    await expect(dialog).toContainText('The condition is always true, so every row is affected.')
    await expect(dialog.getByText(/^about [\d,]+ rows$/)).toBeVisible()
    expect(
      await scratch.q(`SELECT 1 FROM ${quote(scratch.name)}.customer WHERE name = 'x' LIMIT 1`),
    ).toHaveLength(0)
    await confirmHard(page)
    await expect(resultsOf(page).getByText('999 rows affected')).toBeVisible()
    const [changed] = await scratch.q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${quote(scratch.name)}.customer WHERE name = 'x'`,
    )
    expect(Number(changed?.n)).toBe(999)

    // 3. DROP TABLE.
    await run(page, 'DROP TABLE customer')
    await expect(dialog).toContainText('Removes an object.')
    expect(await tableNames(scratch)).toEqual(['customer'])
    await confirmHard(page)
    await expect(resultsOf(page)).toContainText('1 statements')
    expect(await tableNames(scratch)).toEqual([])
  })

  test('TRUNCATE asks; a batch with a DROP waits as a whole', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'customer', 5)
    await signIn(page, address)
    await openSql(page, scratch.name)
    const dialog = confirmDialog(page)
    await run(page, 'TRUNCATE TABLE customer')
    await expect(dialog).toContainText('Empties a table.')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await countRows(scratch, 'customer')).toBe(5)

    await run(page, "SELECT 'batch-marker' AS m; DROP TABLE customer")
    await expect(dialog).toContainText('DROP TABLE customer')
    await expect(resultsOf(page)).toHaveCount(0) // not even the SELECT ran
    expect(await tableNames(scratch)).toEqual(['customer'])
    await confirmHard(page)
    await expect(resultsOf(page)).toContainText('2 statements')
    expect(await tableNames(scratch)).toEqual([])
  })

  test('the soft dialog appears only when the option is on', async ({ page, scratch, address }) => {
    await seedRows(scratch, 'customer', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await setRunOption(page, 'Also confirm statements that change data', true)
    await run(page, "REPLACE INTO customer VALUES (1, 'again')")
    const dialog = confirmDialog(page)
    await expect(dialog).toContainText('Run these statements?')
    await expect(dialog).toContainText('Changes data')
    expect(
      await scratch.q(`SELECT name FROM ${quote(scratch.name)}.customer WHERE id = 1`),
    ).toEqual([{ name: 'row 1' }])
    await confirmHard(page) // soft: "Run", no acknowledgement
    await expect(resultsOf(page).getByText('2 rows affected')).toBeVisible()
    expect(
      await scratch.q(`SELECT name FROM ${quote(scratch.name)}.customer WHERE id = 1`),
    ).toEqual([{ name: 'again' }])

    await setRunOption(page, 'Also confirm statements that change data', false)
    await runAndWait(page, "REPLACE INTO customer VALUES (1, 'third')")
    await expect(dialog).toHaveCount(0)
    expect(
      await scratch.q(`SELECT name FROM ${quote(scratch.name)}.customer WHERE id = 1`),
    ).toEqual([{ name: 'third' }])
  })

  test('a missing, tampered, replayed or foreign token is refused and nothing runs', async ({
    page,
    browser,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'customer', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    const dialog = confirmDialog(page)
    const confirms = capture(page, ['planId', 'confirmToken'])

    // Missing token: the confirm request without confirmToken.
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('"confirmToken"') && body.includes('"planId"')) {
        await route.continue({ postData: dropProperty(body, 'confirmToken') })
      } else await route.continue()
    })
    await run(page, 'DELETE FROM customer')
    await confirmHardAttempt(page)
    await expect(dialog.getByText(/confirmation is missing or not valid/i)).toBeVisible()
    expect(await countRows(scratch, 'customer')).toBe(3)
    await page.unroute('**/_serverFn/**')

    // Tampered token: one character of the signature changed.
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('"confirmToken"') && body.includes('"planId"')) {
        await route.continue({
          postData: editInput(body, 'confirmToken', (o, at) => {
            const node = o.v[at] as unknown as { s: string }
            const last = node.s.slice(-1)
            node.s = node.s.slice(0, -1) + (last === 'A' ? 'B' : 'A')
          }),
        })
      } else await route.continue()
    })
    await dialog.getByRole('button', { name: 'Run anyway' }).click()
    await expect(dialog.getByText(/confirmation is missing or not valid/i)).toBeVisible()
    expect(await countRows(scratch, 'customer')).toBe(3)
    await page.unroute('**/_serverFn/**')

    // The real token still works once: the plan was not consumed by the refusals.
    await dialog.getByRole('button', { name: 'Run anyway' }).click()
    await expect(dialog).toBeHidden()
    await expect(resultsOf(page).getByText('3 rows affected')).toBeVisible()
    expect(await countRows(scratch, 'customer')).toBe(0)

    // Replay of that request: the plan is used up, so nothing runs even though the rows are back.
    await seedRowsAgain(scratch)
    const good = confirms.at(-1)
    expect(good).toBeDefined()
    const replay = await forge(page, good as Captured, (good as Captured).body)
    expect(await succeeded(replay)).toBe(false)
    expect(await countRows(scratch, 'customer')).toBe(3)

    // Other session: a second login cannot use the plan of the first.
    await run(page, 'DELETE FROM customer')
    await expect(dialog).toBeVisible()
    const planRequest = confirms.length
    await page.route('**/_serverFn/**', async (route) => {
      // Hold the real confirm back: this test only needs the plan id and token of the dialog.
      const body = route.request().postData() ?? ''
      if (body.includes('"confirmToken"') && body.includes('"planId"')) await route.abort()
      else await route.continue()
    })
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Run anyway' }).click()
    await expect.poll(() => confirms.length).toBeGreaterThan(planRequest)
    await page.unroute('**/_serverFn/**')
    const mine = confirms.at(-1) as Captured

    const other = await browser.newContext({ baseURL: new URL(page.url()).origin })
    const page2 = await other.newPage()
    const second = capture(page2, ['runId'])
    await signIn(page2, address)
    await openSql(page2, scratch.name)
    await run(page2, 'SELECT 1')
    await expect.poll(() => second.length).toBeGreaterThan(0)
    const csrf = (second[0] as Captured).headers['x-dbloom-csrf'] as string
    const foreignHeaders: Record<string, string> = { ...mine.headers, 'x-dbloom-csrf': csrf }
    delete foreignHeaders['content-length']
    delete foreignHeaders['host']
    foreignHeaders.origin = new URL(mine.url).origin
    const foreign = await other.request.post(mine.url, { headers: foreignHeaders, data: mine.body })
    expect(await succeeded(foreign)).toBe(false)
    expect(await countRows(scratch, 'customer')).toBe(3)
    await other.close()
  })

  async function confirmHardAttempt(page: Page) {
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Run anyway' }).click()
  }

  async function seedRowsAgain(scratch: Parameters<typeof countRows>[0]) {
    await scratch.q(
      `INSERT INTO ${quote(scratch.name)}.customer VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
    )
  }
})

test.describe('SCN-027 read-only connection', () => {
  // Second web server (port 3101) started with DBLOOM_READ_ONLY=true, see playwright.config.ts.
  test.use({ baseURL: READ_ONLY_URL })

  test('reads run; every write is refused with the reason and changes nothing', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'customer', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await expect(page.getByText('Read-only connection', { exact: true }).first()).toBeVisible()

    // Reads.
    await runAndWait(page, 'SELECT COUNT(*) AS n FROM customer')
    await expect(
      gridOf(resultsOf(page)).getByRole('gridcell', { name: '3', exact: true }),
    ).toBeVisible()
    await expect(runButton(page)).not.toHaveAttribute('aria-disabled', 'true')
    for (const read of [
      'SHOW TABLES',
      'DESCRIBE customer',
      'EXPLAIN SELECT * FROM customer',
      `USE ${quote(scratch.name)}`,
    ]) {
      await runAndWait(page, read)
      await expect(resultsOf(page)).toContainText('1 statements')
      await expect(resultsOf(page)).not.toContainText('failed')
    }

    // Writes: Run is disabled and says why; clicking runs nothing.
    const writes = [
      "INSERT INTO customer VALUES (9, 'z')",
      'CREATE TABLE made (id INT)',
      'CALL p()',
      'LOCK TABLES customer WRITE',
      "SELECT * FROM customer INTO OUTFILE '/tmp/dbloom-e2e.txt'",
      "LOAD DATA INFILE '/tmp/x' INTO TABLE customer",
      'SET SESSION TRANSACTION READ WRITE',
      'START TRANSACTION READ WRITE',
      'SET @@session.tx_read_only = 0',
      'SET SESSION transaction_read_only = OFF',
      'SELECT 1; DROP TABLE customer',
      'FLUSH TABLES',
    ]
    for (const sql of writes) {
      await setSql(page, sql)
      await expect(runButton(page), sql).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByText('Read-only connection: only reads can run here.')).toBeVisible()
      await runButton(page).click({ force: true })
    }
    expect(await tableNames(scratch)).toEqual(['customer'])
    expect(await countRows(scratch, 'customer')).toBe(3)
  })

  test('the server refuses forged writes before opening a connection', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'customer', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    const sent = capture(page, ['runId', 'text'])
    await runAndWait(page, 'SELECT 1')
    const original = sent.at(-1) as Captured

    for (const sql of [
      "INSERT INTO customer VALUES (9, 'z')",
      'SELECT 1; DROP TABLE customer',
      'SET SESSION TRANSACTION READ WRITE',
      'DELETE FROM customer',
    ]) {
      const res = await forge(page, original, replaceString(original.body, 'text', sql))
      const text = await res.text()
      expect(text, sql).toContain('read-only')
      expect(text, sql).not.toContain('"s":"done"')
    }
    expect(await tableNames(scratch)).toEqual(['customer'])
    expect(await countRows(scratch, 'customer')).toBe(3)
  })

  test('a SELECT of a function that writes fails with 1792 because the transaction is read-only', async ({
    page,
    scratch,
    address,
  }) => {
    const db = quote(scratch.name)
    await scratch.q(`CREATE TABLE ${db}.audit_log (n INT)`)
    await scratch.q(
      `CREATE FUNCTION ${db}.writer() RETURNS INT DETERMINISTIC MODIFIES SQL DATA
       BEGIN INSERT INTO audit_log VALUES (1); RETURN 1; END`,
    )
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SELECT writer() AS w')
    await expect(resultsOf(page).getByRole('alert')).toContainText('Error 1792')
    expect(await countRows(scratch, 'audit_log')).toBe(0)
  })
})

test.describe('SCN-028 statement timeout', () => {
  // Fourth server (port 3102): DBLOOM_STATEMENT_TIMEOUT_SECONDS=2, see playwright.config.ts.
  test.use({ baseURL: LIMITS_URL })

  test('SELECT SLEEP, a slow UPDATE and the second of two statements stop after the limit', async ({
    page,
    scratch,
    address,
  }) => {
    test.setTimeout(90_000)
    await seedRows(scratch, 'items', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await expect(page.getByText(`Time limit ${LIMITS_TIMEOUT_S} s per statement`)).toBeVisible()
    const results = resultsOf(page)
    const message = new RegExp(`stopped after ${LIMITS_TIMEOUT_S} s \\(time limit\\)`, 'i')

    const started = Date.now()
    await runAndWait(page, 'SELECT SLEEP(20) AS slept')
    expect(Date.now() - started).toBeLessThan(10_000)
    await expect(results.getByRole('alert')).toContainText(message)
    await expect(results.getByRole('alert')).not.toContainText('Cancelled')
    await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(20)')).length).toBe(0)

    // A statement that changes data is stopped by the watchdog.
    await runAndWait(page, 'UPDATE items SET name = name WHERE id > 0 AND SLEEP(20) = 0')
    await expect(results.getByRole('alert')).toContainText(message)
    await expect
      .poll(async () => (await threadsRunning(scratch, 'UPDATE items SET name')).length)
      .toBe(0)

    // Two statements: the first keeps its result, the second times out.
    await runAndWait(page, 'SELECT 7 AS seven; SELECT SLEEP(20) AS slept')
    await expect(results).toContainText('2 statements · 1 failed')
    await results.getByRole('tab', { name: 'Statement 1', exact: true }).click()
    await expect(gridOf(results).getByRole('gridcell', { name: '7', exact: true })).toBeVisible()
    await results.getByRole('tab', { name: 'Statement 2', exact: true }).click()
    await expect(results.getByRole('alert')).toContainText(message)

    // The next run works at once.
    await runAndWait(page, 'SELECT 1 AS one')
    await expect(gridOf(results).getByRole('gridcell', { name: '1', exact: true })).toBeVisible()
  })
})

test.describe('SCN-029 result size cap and truncation message', () => {
  test.describe('row cap lowered to 1 000 (port 3102)', () => {
    test.use({ baseURL: LIMITS_URL })

    test('exactly 1 000 rows, the notice without a total, and the server thread is gone', async ({
      page,
      scratch,
      address,
    }) => {
      await seedRows(scratch, 'seq', LIMITS_ROW_CAP * 5)
      await signIn(page, address)
      await openSql(page, scratch.name)
      await runAndWait(page, 'SELECT * FROM seq')
      const results = resultsOf(page)
      await expect(results.getByText('First 1,000 rows', { exact: true })).toBeVisible()
      await expect(
        results.getByText(
          'Showing the first 1,000 rows. The statement returned more; add LIMIT, or raise the limit (up to 1,000).',
        ),
      ).toBeVisible()
      expect(await gridRowCount(gridOf(results))).toBe(LIMITS_ROW_CAP)
      await expect(results).not.toContainText('5,000')
      await expect.poll(async () => (await threadsRunning(scratch, 'FROM seq')).length).toBe(0)

      // A result at the limit exactly is not cut.
      await runAndWait(page, 'SELECT * FROM seq WHERE id <= 1000')
      await expect(results.getByText('1,000 rows', { exact: true })).toBeVisible()
      await expect(results.getByText(/Showing the first/)).toHaveCount(0)
    })
  })

  test('default cap of 10 000 rows with a 10 050 row table', async ({ page, scratch, address }) => {
    await seedRows(scratch, 'seq', 10_050)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SELECT * FROM seq')
    const results = resultsOf(page)
    await expect(results.getByText('First 10,000 rows', { exact: true })).toBeVisible()
    await expect(
      results.getByText(/Showing the first 10,000 rows\. The statement returned more/),
    ).toBeVisible()
    expect(await gridRowCount(gridOf(results))).toBe(10_000)
    await expect.poll(async () => (await threadsRunning(scratch, 'FROM seq')).length).toBe(0)
  })

  test('a cell above the cell limit is shown cut with its length', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, "SELECT REPEAT('a', 100000) AS big, 'small' AS s")
    const cells = gridOf(resultsOf(page)).getByRole('gridcell')
    await expect(cells.first()).toContainText('(100,000 chars)')
    await expect(cells.nth(1)).toHaveText('small')
    await expect(resultsOf(page).getByText(/Showing the first/)).toHaveCount(0)
  })
})
