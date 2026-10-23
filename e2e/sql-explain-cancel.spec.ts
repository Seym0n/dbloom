import type { Page } from '@playwright/test'
import {
  type Captured,
  READ_ONLY_URL,
  capture,
  cancelButton,
  confirmDialog,
  confirmHard,
  expect,
  forge,
  gridOf,
  openSql,
  quote,
  replaceString,
  resultsOf,
  run,
  runAndWait,
  seedRows,
  setSql,
  signIn,
  test,
  threadsRunning,
  type Scratch,
} from './fixtures/sql-fixtures'

const explainView = (page: Page) => page.getByRole('region', { name: 'Explain output' })
const clickExplain = (page: Page) =>
  page.getByRole('button', { name: 'Explain', exact: true }).click()
const clickAnalyse = (page: Page) =>
  page.getByRole('button', { name: 'Analyse', exact: true }).click()

/** Counts the explain requests (their input has `mode` and `format`). */
const explainCalls = (page: Page) => capture(page, ['mode', 'format'])

test.describe('SCN-032 explain and analyse', () => {
  test('explain shows the plan as a tree and the raw text; analyse runs the SELECT; refresh re-runs', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await seedRows(scratch, 'customer', 1000)
    await signIn(page, address)
    await openSql(page, scratch.name)
    const calls = explainCalls(page)
    const text = 'SELECT * FROM customer WHERE id = 5'
    await setSql(page, text)

    await clickExplain(page)
    const view = explainView(page)
    await expect(view.getByRole('heading', { name: 'Explain', exact: true })).toBeVisible()
    await expect(view).toContainText(text)
    // Tree built from the JSON form.
    await expect(view.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
    await expect(view.getByRole('list').first().getByRole('listitem').first()).toBeVisible()
    await expect(view).toContainText(/customer/)
    // The raw server text is always there.
    await view.getByRole('tab', { name: 'Raw output' }).click()
    await expect(view).toContainText('"query_block"')
    await expect(view).toContainText('"table_name": "customer"')

    // Refresh re-runs the same request.
    const before = calls.length
    await view.getByRole('button', { name: 'Refresh' }).click()
    await expect.poll(() => calls.length).toBeGreaterThan(before)

    // Other output formats.
    await view.getByRole('button', { name: 'Text' }).click()
    await view.getByRole('tab', { name: 'Raw output' }).click()
    await expect(view).toContainText('select_type')
    await view.getByRole('button', { name: 'JSON' }).click()

    // Analyse executes the SELECT and reports actual timings.
    await clickAnalyse(page)
    await expect(view.getByRole('heading', { name: 'Analyse', exact: true })).toBeVisible()
    await expect(view).toContainText('Analyse runs the statement to measure it.')
    await view.getByRole('tab', { name: 'Raw output' }).click()
    if (product === 'mysql') {
      // EXPLAIN ANALYZE is tree text on MySQL.
      await expect(view).toContainText(/actual time=/)
    } else {
      // ANALYZE FORMAT=JSON on MariaDB.
      await expect(view).toContainText(/"r_(total_time_ms|rows)"/)
    }
    await expect(confirmDialog(page)).toHaveCount(0) // a plain SELECT needs no confirmation
  })

  test('analyse of an UPDATE asks first, names the statement, and changes nothing before the token', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await seedRows(scratch, 'customer', 10)
    await signIn(page, address)
    await openSql(page, scratch.name)
    const text = "UPDATE customer SET name = 'y' WHERE id = 5"
    await setSql(page, text)
    const nameOf = async () =>
      (
        await scratch.q<{ name: string }>(
          `SELECT name FROM ${quote(scratch.name)}.customer WHERE id = 5`,
        )
      )[0]?.name

    await clickAnalyse(page)
    const dialog = confirmDialog(page)
    await expect(dialog).toContainText(text)
    await expect(dialog).toContainText('Can delete data')
    expect(await nameOf()).toBe('row 5')

    // Cancel: nothing ran.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await nameOf()).toBe('row 5')

    // Confirm: the statement runs. MariaDB ANALYZE UPDATE really changes the row.
    await clickAnalyse(page)
    await confirmHard(page)
    const view = explainView(page)
    await expect(view.getByRole('heading', { name: 'Analyse', exact: true })).toBeVisible()
    if (product === 'mariadb') {
      await view.getByRole('tab', { name: 'Raw output' }).click()
      await expect(view).toContainText('r_')
      expect(await nameOf()).toBe('y')
    } else {
      // MySQL 8.4 cannot EXPLAIN ANALYZE a single-table UPDATE: the server answers with a placeholder
      // and the row is not changed. The confirmation was still asked (DBLoom cannot know that in advance).
      await expect(view).toContainText('<not executable by iterator executor>')
      expect(await nameOf()).toBe('row 5')
    }
  })

  test('two statements are refused, an unexplainable statement shows the server message', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await setSql(page, 'SELECT 1; SELECT 2')
    await page.keyboard.press('ControlOrMeta+A')
    await clickExplain(page)
    await expect(explainView(page)).toContainText('Select one statement to explain.')

    await setSql(page, 'SHOW TABLES')
    await clickExplain(page)
    // The generic text, then the server's own message (rendered as text).
    const alert = explainView(page).getByRole('alert')
    await expect(alert).toContainText('This statement cannot be explained: ')
    await expect(alert).toContainText(/SQL syntax|syntax/)
  })

  test.describe('on a read-only server', () => {
    test.use({ baseURL: READ_ONLY_URL })

    test('explain works, analyse of an UPDATE is refused', async ({ page, scratch, address }) => {
      await seedRows(scratch, 'customer', 3)
      await signIn(page, address)
      await openSql(page, scratch.name)
      await setSql(page, 'SELECT * FROM customer WHERE id = 1')
      await clickExplain(page)
      await expect(explainView(page).getByRole('tab', { name: 'Plan' })).toBeVisible()
      await expect(explainView(page)).not.toContainText('Read-only connection')

      await setSql(page, "UPDATE customer SET name = 'y' WHERE id = 1")
      await clickAnalyse(page)
      await expect(explainView(page)).toContainText(
        'Read-only connection: only reads can run here.',
      )
      await expect(confirmDialog(page)).toHaveCount(0)
      expect(
        await scratch.q(`SELECT name FROM ${quote(scratch.name)}.customer WHERE id = 1`),
      ).toEqual([{ name: 'row 1' }])
    })
  })
})

/** Kills threads left by a failed test so no SLEEP outlives it. */
async function killSleepers(scratch: Scratch) {
  for (const t of await threadsRunning(scratch, 'SLEEP(30)')) {
    await scratch.q(`KILL ${Number(t.Id)}`).catch(() => undefined)
  }
}

test.describe('SCN-033 cancel a running statement', () => {
  test('Cancel ends SELECT SLEEP(30) within seconds: cancelled, not timeout; the thread is gone; the next run works', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    try {
      await signIn(page, address, owner.user, owner.password)
      await openSql(page, scratch.name)
      await run(page, 'SELECT SLEEP(30) AS slept; SELECT 2 AS two')
      await expect(cancelButton(page)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)

      const clicked = Date.now()
      await cancelButton(page).click()
      const results = resultsOf(page)
      await expect(results.getByRole('alert')).toContainText('Cancelled by you', { timeout: 5000 })
      expect(Date.now() - clicked).toBeLessThan(5000)
      await expect(results.getByRole('alert')).not.toContainText('time limit')
      await expect(results).toContainText('2 statements · 1 failed · 1 not run')
      await results.getByRole('tab', { name: 'Statement 2', exact: true }).click()
      await expect(results.getByText('Not run', { exact: true })).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(0)

      // A new run works at once.
      await runAndWait(page, 'SELECT 3 AS three')
      await expect(gridOf(results).getByRole('gridcell', { name: '3', exact: true })).toBeVisible()

      // History: outcome cancelled.
      await page.getByRole('button', { name: 'History', exact: true }).click()
      const drawer = page.getByRole('complementary', { name: 'History and bookmarks' })
      await expect(drawer.getByRole('listitem').filter({ hasText: 'SLEEP(30)' })).toContainText(
        'Cancelled',
      )
    } finally {
      await killSleepers(scratch)
    }
  })

  test('cancel releases LOCK TABLES: another connection can read the table at once', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'locked', 3)
    try {
      await signIn(page, address)
      await openSql(page, scratch.name)
      await run(page, 'LOCK TABLES locked WRITE; SELECT SLEEP(30)')
      await expect(cancelButton(page)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)

      const other = await scratch.second()
      await other.query('SET SESSION lock_wait_timeout = 2')
      // While the lock is held, the read waits and fails after the wait timeout.
      await expect(
        other.query(`SELECT COUNT(*) FROM ${quote(scratch.name)}.locked`),
      ).rejects.toThrow()

      await cancelButton(page).click()
      await expect(resultsOf(page).getByRole('alert')).toContainText('Cancelled by you')
      const [rows] = await other.query(`SELECT COUNT(*) AS n FROM ${quote(scratch.name)}.locked`)
      expect(Number((rows as { n: number }[])[0]?.n)).toBe(3)
    } finally {
      await killSleepers(scratch)
    }
  })

  test('a cancel from another session with the same run id has no effect', async ({
    page,
    browser,
    scratch,
    address,
    baseURL,
  }) => {
    try {
      await signIn(page, address)
      await openSql(page, scratch.name)
      const runs = capture(page, ['runId', 'text'])
      await run(page, 'SELECT SLEEP(30)')
      await expect(cancelButton(page)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)
      const runBody = (runs.at(-1) as Captured).body

      // The second session makes a real cancel request of its own; we send it with the first run id.
      const context = await browser.newContext({ baseURL })
      const page2 = await context.newPage()
      const cancels = capture(page2, ['runId'])
      await signIn(page2, address)
      await openSql(page2, scratch.name)
      await run(page2, 'SELECT SLEEP(30) AS second_session')
      await expect(cancelButton(page2)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(2)
      await cancelButton(page2).click()
      await expect(resultsOf(page2).getByRole('alert')).toContainText('Cancelled by you')
      const cancel = cancels.find((c) => !c.body.includes('"text"')) as Captured
      expect(cancel).toBeDefined()
      const firstRunId = /"runId"[\s\S]*?"s":"([^"]+)"/.exec(runBody)?.[1] as string
      expect(firstRunId).toBeTruthy()
      const res = await forge(page2, cancel, replaceString(cancel.body, 'runId', firstRunId))
      expect(res.ok()).toBe(true)

      // Still running in the first session.
      await expect(cancelButton(page)).toBeVisible()
      await page.waitForTimeout(1500) // negative check: give a wrong cancel time to act
      expect((await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)
      await cancelButton(page).click()
      await expect(resultsOf(page).getByRole('alert')).toContainText('Cancelled by you')
      await context.close()
    } finally {
      await killSleepers(scratch)
    }
  })

  test('closing the SQL tab ends the run on the server', async ({ page, scratch, address }) => {
    try {
      await signIn(page, address)
      await openSql(page, scratch.name)
      await run(page, 'SELECT SLEEP(30)')
      await expect(cancelButton(page)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)
      await page.getByRole('button', { name: /^Close SQL/ }).click()
      await confirmDialog(page).getByRole('button', { name: 'Discard and close' }).click()
      await expect
        .poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length, { timeout: 8000 })
        .toBe(0)
    } finally {
      await killSleepers(scratch)
    }
  })

  test('closing the browser page ends the run on the server', async ({
    browser,
    scratch,
    address,
    baseURL,
  }) => {
    try {
      const context = await browser.newContext({ baseURL })
      const page = await context.newPage()
      await signIn(page, address)
      await openSql(page, scratch.name)
      await run(page, 'SELECT SLEEP(30)')
      await expect(cancelButton(page)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)
      await context.close()
      await expect
        .poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length, { timeout: 15_000 })
        .toBe(0)
    } finally {
      await killSleepers(scratch)
    }
  })

  test('two runs go at once, the third is refused as busy, cancel still works', async ({
    page,
    scratch,
    address,
  }) => {
    try {
      await signIn(page, address)
      await openSql(page, scratch.name)
      await run(page, 'SELECT SLEEP(30) AS one')
      await expect(cancelButton(page)).toBeVisible()
      await openSql(page, scratch.name)
      await run(page, 'SELECT SLEEP(30) AS two')
      await expect(cancelButton(page)).toBeVisible()
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(2)

      await openSql(page, scratch.name)
      await run(page, 'SELECT 3 AS three')
      await expect(
        page.getByText('Two statements are already running. Wait for one to finish or cancel it.'),
      ).toBeVisible()

      // The reserved connection serves cancel and other work: cancel the second tab's run.
      await page.getByRole('tab', { name: /^SQL 2/ }).click()
      await cancelButton(page).click()
      await expect(resultsOf(page).getByRole('alert')).toContainText('Cancelled by you')
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(1)
      await page.getByRole('tab', { name: /^SQL 1/ }).click()
      await cancelButton(page).click()
      await expect(resultsOf(page).getByRole('alert')).toContainText('Cancelled by you')
      await expect.poll(async () => (await threadsRunning(scratch, 'SLEEP(30)')).length).toBe(0)
    } finally {
      await killSleepers(scratch)
    }
  })
})
