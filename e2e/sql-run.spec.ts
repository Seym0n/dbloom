import {
  browserStorageDump,
  confirmDialog,
  confirmHard,
  countRows,
  dbSelect,
  editorOf,
  expect,
  gridOf,
  gridRowCount,
  openSql,
  quote,
  resultsOf,
  run,
  runAndWait,
  runButton,
  runConfirmed,
  setRunOption,
  setSql,
  sidebar,
  signIn,
  test,
  seedRows,
} from './fixtures/sql-fixtures'
import { randomName, seedCustomer, tableNames } from './fixtures/scratch-db'

const statementTab = (page: import('@playwright/test').Page, n: number) =>
  resultsOf(page).getByRole('tab', { name: `Statement ${n}`, exact: true })
const SQL_ERROR_MARK = '.cm-sql-error'

test.describe('SCN-024 run a SELECT', () => {
  test('grid with 1 000 rows is virtualised, sorts in the browser and keeps the text', async ({
    page,
    scratch,
    address,
  }) => {
    await seedCustomer(scratch, { rows: 1000 })
    await signIn(page, address)
    await openSql(page, scratch.name)
    await expect(page.getByText(/^Press (Ctrl|⌘)\+Enter to run$/)).toBeVisible()

    const text = 'SELECT id, name FROM customer ORDER BY id'
    await setSql(page, text)
    await page.keyboard.press('ControlOrMeta+Enter')

    const results = resultsOf(page)
    await expect(results.getByText('1,000 rows', { exact: true })).toBeVisible()
    await expect(results.getByText(/^\d+ ms$|^\d+\.\d+ s$/).first()).toBeVisible()
    const grid = gridOf(results)
    await expect(grid.getByRole('columnheader')).toHaveText(['id', 'name'])
    expect(await gridRowCount(grid)).toBe(1000)
    // Virtualised: far fewer rows in the DOM than in the result, and the first ones are there.
    await expect(grid.getByRole('gridcell', { name: 'customer 1', exact: true })).toBeVisible()
    const rendered = await grid.getByRole('row').count()
    expect(rendered).toBeGreaterThan(5)
    expect(rendered).toBeLessThan(120)
    // Scrolling brings the last rows in.
    await grid.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await expect(grid.getByRole('gridcell', { name: 'customer 1000', exact: true })).toBeVisible()
    await grid.evaluate((el) => (el.scrollTop = 0))

    // No confirmation was asked, and the strip shows the typed statement.
    await expect(confirmDialog(page)).toHaveCount(0)
    const strip = results.getByLabel('Statement text')
    await expect(strip).toContainText(text)

    // Sorting in the grid sends nothing to the server and does not change the text.
    let calls = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/_serverFn/')) calls++
    })
    await grid.getByRole('button', { name: 'name' }).click()
    await expect(grid.getByRole('columnheader', { name: 'name' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    await grid.getByRole('button', { name: 'id' }).click()
    await grid.getByRole('button', { name: 'id' }).click()
    await expect(grid.getByRole('columnheader', { name: 'id' })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    await expect(grid.getByRole('gridcell', { name: 'customer 1000', exact: true })).toBeVisible()
    await expect(strip).toContainText(text)
    expect(calls).toBe(0)
  })

  test('NULL and binary cells, the expression text as header, hostile values as text', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(
      page,
      `SELECT NULL AS n, X'DEADBEEF' AS b, '<img src=x onerror="window.__pwned=1">' AS html, (SELECT 41 + 1)`,
    )
    const grid = gridOf(resultsOf(page))
    await expect(grid.getByRole('columnheader')).toHaveCount(4)
    await expect(grid.getByRole('columnheader').nth(3)).toContainText('(SELECT 41 + 1)')
    await expect(grid.getByRole('gridcell').nth(0)).toHaveText('NULL')
    await expect(grid.getByRole('gridcell').nth(1)).toContainText('0xDEADBEEF')
    await expect(grid.getByRole('gridcell').nth(1)).toContainText('(4 B)')
    await expect(grid.getByRole('gridcell').nth(2)).toHaveText(
      '<img src=x onerror="window.__pwned=1">',
    )
    await expect(grid.getByRole('gridcell').nth(3)).toHaveText('42')
    await expect(grid.locator('img')).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined()
  })

  test('the server receives the exact text, one query, no LIMIT; SELECT 1 -- foobar is stable', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    void product
    const marker = randomName('mk_')
    const previous = await scratch.q<{ log_output: string; general_log: number }>(
      'SELECT @@global.log_output AS log_output, @@global.general_log AS general_log',
    )
    await signIn(page, address)
    await openSql(page, scratch.name)
    const sent = `SELECT 1 AS \`${marker}\` -- foobar`
    try {
      await scratch.q("SET GLOBAL log_output = 'TABLE'")
      await scratch.q('SET GLOBAL general_log = 1')
      const outputs: string[] = []
      for (let i = 0; i < 3; i++) {
        await runAndWait(page, `  ${sent}`)
        outputs.push(await resultsOf(page).innerText())
        await expect(resultsOf(page).getByLabel('Statement text')).toContainText(sent)
      }
      expect(new Set(outputs.map((o) => o.replace(/\d+ ms|\d+\.\d+ s/g, ''))).size).toBe(1)
      const logged = await scratch.q<{ a: string }>(
        `SELECT CONVERT(argument USING utf8mb4) AS a FROM mysql.general_log
          WHERE command_type = 'Query' AND argument LIKE ? AND argument NOT LIKE '%general_log%'`,
        [`%${marker}%`],
      )
      expect(logged).toHaveLength(3)
      for (const row of logged) {
        // Exactly the slice from the first non-blank character; comment kept, nothing appended.
        expect(row.a.trim()).toBe(sent)
        expect(row.a).not.toMatch(/limit/i)
      }
    } finally {
      await scratch.q('SET GLOBAL general_log = ?', [previous[0]?.general_log ?? 0])
      await scratch.q('SET GLOBAL log_output = ?', [previous[0]?.log_output ?? 'FILE'])
    }
  })

  test('an empty result says so; a statement without rows shows rows affected and time', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'items', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SELECT * FROM items WHERE id > 100')
    await expect(resultsOf(page).getByText('The statement returned no rows.')).toBeVisible()
    await runAndWait(page, "UPDATE items SET name = 'changed' WHERE id = 2")
    await expect(confirmDialog(page)).toHaveCount(0)
    await expect(resultsOf(page).getByText('1 rows affected')).toBeVisible()
    const [row] = await scratch.q<{ name: string }>(
      `SELECT name FROM ${quote(scratch.name)}.items WHERE id = 2`,
    )
    expect(row?.name).toBe('changed')
  })
})

test.describe('SCN-025 several statements, one fails in the middle', () => {
  const three = (db: string) =>
    ['CREATE TABLE t1 (id INT);', 'INSERT INTO nope VALUES (1);', 'SELECT 1'].join('\n') +
    `\n-- ${db}`

  test('executed, failed, not run; the first stays; the position is marked', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await run(page, three(scratch.name))
    const results = resultsOf(page)
    await expect(results).toContainText('3 statements · 1 failed · 1 not run')
    // The failed statement is selected and shows only the error (FR-ISS-135).
    const alert = results.getByRole('alert')
    await expect(alert).toContainText('Error 1146')
    await expect(alert).toContainText('nope')
    await expect(alert).toContainText('The table does not exist.')
    await expect(gridOf(results)).toHaveCount(0)
    await expect(results.getByText(/rows affected/)).toHaveCount(0)
    // Position marked in the editor on statement 2.
    await expect(editorOf(page).locator(SQL_ERROR_MARK)).toContainText('INSERT INTO nope')
    // Statement 1 done, statement 3 not run.
    await statementTab(page, 1).click()
    await expect(results.getByText('0 rows affected')).toBeVisible()
    await statementTab(page, 3).click()
    await expect(results.getByText('Not run', { exact: true })).toBeVisible()
    // No rollback: DDL committed.
    expect(await tableNames(scratch)).toEqual(['t1'])

    // One history entry for the whole run.
    await page.getByRole('button', { name: 'History' }).click()
    const drawer = page.getByRole('complementary', { name: 'History and bookmarks' })
    await expect(drawer.getByText('Failed at statement 2, 1 executed')).toBeVisible()
    await expect(drawer.getByRole('listitem')).toHaveCount(1)
  })

  test('continue on error runs the third statement', async ({ page, scratch, address }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await setRunOption(page, 'Continue after an error', true)
    await run(page, three(scratch.name))
    const results = resultsOf(page)
    await expect(results).toContainText('3 statements · 1 failed')
    await expect(results).not.toContainText('not run')
    await statementTab(page, 3).click()
    await expect(gridOf(results).getByRole('gridcell', { name: '1', exact: true })).toBeVisible()
    expect(await tableNames(scratch)).toEqual(['t1'])
  })

  test('a syntax error gets 1064 with the position inside its statement', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    // The failing statement starts on line 3 of the text.
    await run(page, 'SELECT 1;\nSELECT 2;\nSELEC 1 FROM dual')
    await confirmHard(page) // the parser cannot read it, so it asks first (FR-SQL-006)
    const results = resultsOf(page)
    await expect(results.getByRole('alert')).toContainText('Error 1064')
    await expect(results.getByRole('alert')).toContainText(/near 'SELEC 1 FROM dual'/)
    await expect(editorOf(page).locator(SQL_ERROR_MARK)).toHaveText('SELEC')
  })

  test('an unterminated string is reported before anything runs', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await run(page, "CREATE TABLE t9 (id INT);\nSELECT 'abc")
    await expect(page.getByText('A string is not closed. Nothing ran.')).toBeVisible()
    await expect(confirmDialog(page)).toHaveCount(0)
    await expect(runButton(page)).toBeVisible()
    expect(await tableNames(scratch)).toEqual([])
  })
})

test.describe('SCN-034 dialect statements, delimiter, parser fallback', () => {
  test('modern reads run without a dialog: CTE, window function, JSON_TABLE, SHA2, SHOW', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRows(scratch, 'items', 5)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await run(
      page,
      [
        'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4) SELECT SUM(i) AS total FROM n;',
        'SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn FROM items;',
        `SELECT jt.a FROM JSON_TABLE('[{"a":7},{"a":8}]', '$[*]' COLUMNS (a INT PATH '$.a')) AS jt;`,
        "SELECT SHA2('a', 256) AS h;",
        'SHOW FULL PROCESSLIST',
      ].join('\n'),
    )
    const results = resultsOf(page)
    await expect(results).toContainText('5 statements')
    await expect(confirmDialog(page)).toHaveCount(0)
    await expect(results).not.toContainText('failed')
    await expect(gridOf(results).getByRole('gridcell', { name: '10', exact: true })).toBeVisible()
    await statementTab(page, 3).click()
    await expect(gridOf(results).getByRole('gridcell', { name: '8', exact: true })).toBeVisible()
    await statementTab(page, 4).click()
    await expect(
      gridOf(results).getByRole('gridcell', {
        name: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      }),
    ).toBeVisible()
  })

  test('semicolons inside strings and comments do not split; executable comments pass unchanged', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    const exec = 'SELECT /*! STRAIGHT_JOIN */ 1 AS one /*M! , 2 AS two */'
    await runAndWait(page, `SELECT 'a;b' AS s; -- c;d\n${exec}`)
    const results = resultsOf(page)
    await expect(results).toContainText('2 statements')
    await expect(gridOf(results).getByRole('gridcell', { name: 'a;b' })).toBeVisible()
    await statementTab(page, 2).click()
    await expect(results.getByLabel('Statement text')).toContainText(exec)
    // MariaDB runs /*M! ... */, MySQL treats it as a comment.
    await expect(gridOf(results).getByRole('columnheader')).toHaveCount(
      product === 'mariadb' ? 2 : 1,
    )
  })

  test('SET @a := 1; SELECT @a runs although the parser rejects the first; user variables work in one run', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SET @a := 1; SELECT @a')
    await expect(confirmDialog(page)).toHaveCount(0)
    await statementTab(page, 2).click()
    await expect(
      gridOf(resultsOf(page)).getByRole('gridcell', { name: '1', exact: true }),
    ).toBeVisible()
  })

  test('PARTITION, LOCK TABLES with UNLOCK show no editor marker', async ({
    page,
    scratch,
    address,
  }) => {
    await scratch.q(
      `CREATE TABLE ${quote(scratch.name)}.part (id INT) PARTITION BY HASH(id) PARTITIONS 2`,
    )
    await scratch.q(`INSERT INTO ${quote(scratch.name)}.part VALUES (1), (2), (3)`)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await run(page, 'SELECT * FROM part PARTITION (p0);')
    await expect(resultsOf(page)).toContainText('1 statements')
    await expect(editorOf(page).locator(SQL_ERROR_MARK)).toHaveCount(0)
    await setSql(page, 'LOCK TABLES part READ;\nSELECT COUNT(*) FROM part;\nUNLOCK TABLES')
    await expect(editorOf(page).locator(SQL_ERROR_MARK)).toHaveCount(0)
    await runButton(page).click()
    await expect(resultsOf(page)).toContainText('3 statements')
    await expect(resultsOf(page)).not.toContainText('failed')
    await expect(editorOf(page).locator(SQL_ERROR_MARK)).toHaveCount(0)
  })

  test('FOR UPDATE SKIP LOCKED and INVISIBLE index (MySQL) run', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    test.skip(product !== 'mysql', 'INVISIBLE indexes are MySQL syntax (MariaDB uses IGNORED)')
    await seedRows(scratch, 'items', 3)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await run(
      page,
      'ALTER TABLE items ADD INDEX idx_name (name) INVISIBLE;\nSELECT * FROM items FOR UPDATE SKIP LOCKED',
    )
    // The parser rejects INVISIBLE, so the statement is unparsed and asks first (FR-SQL-006).
    await expect(confirmDialog(page)).toContainText('DBLoom could not analyse this statement')
    await confirmHard(page)
    await expect(resultsOf(page)).toContainText('2 statements')
    await expect(resultsOf(page)).not.toContainText('failed')
    const idx = await scratch.q<{ IS_VISIBLE: string }>(
      `SELECT IS_VISIBLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND INDEX_NAME = 'idx_name'`,
      [scratch.name],
    )
    expect(idx[0]?.IS_VISIBLE).toBe('NO')
  })

  test('RETURNING shows rows in a grid (MariaDB)', async ({ page, scratch, address, product }) => {
    test.skip(product !== 'mariadb', 'INSERT ... RETURNING exists on MariaDB 10.5+ only')
    await seedRows(scratch, 'items', 0)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await run(
      page,
      "INSERT INTO items VALUES (1, 'a') RETURNING id, name;\nDELETE FROM items WHERE id = 1 RETURNING *",
    )
    const results = resultsOf(page)
    await expect(results).toContainText('2 statements')
    await expect(gridOf(results).getByRole('gridcell', { name: 'a', exact: true })).toBeVisible()
    await statementTab(page, 2).click()
    await expect(gridOf(results).getByRole('gridcell', { name: 'a', exact: true })).toBeVisible()
    expect(await countRows(scratch, 'items')).toBe(0)
  })

  test('DELIMITER with a procedure body, CALL with two result sets, and the 1064 hint without DELIMITER', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    const body = 'CREATE PROCEDURE p() BEGIN SELECT 1 AS first_set; SELECT 2 AS second_set; END'
    await run(page, `DELIMITER $$\n${body} $$\nDELIMITER ;\nCALL p();`)
    // An unparsed CREATE PROCEDURE and the CALL ask first.
    await expect(confirmDialog(page)).toContainText('CREATE PROCEDURE p()')
    await confirmHard(page)
    const results = resultsOf(page)
    await expect(results).toContainText('2 statements')
    await expect(results).not.toContainText('failed')
    const routines = await scratch.q<{ ROUTINE_NAME: string }>(
      'SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?',
      [scratch.name],
    )
    expect(routines.map((r) => r.ROUTINE_NAME)).toEqual(['p'])
    // The CALL gives one statement panel with two grids.
    await statementTab(page, 2).click()
    await expect(gridOf(results)).toHaveCount(2)
    await expect(gridOf(results).first().getByRole('columnheader')).toHaveText(['first_set'])
    await expect(gridOf(results).last().getByRole('columnheader')).toHaveText(['second_set'])

    // Without DELIMITER the same body is split at its inner semicolons and the server rejects it.
    await scratch.q(`DROP PROCEDURE ${quote(scratch.name)}.p`)
    await run(page, body)
    await confirmHard(page)
    await expect(results.getByRole('alert')).toContainText('Error 1064')
    await expect(results.getByRole('alert')).toContainText('DELIMITER')
  })
})

test.describe('SCN-036 session state, FK checks and transactions', () => {
  test('SET and user variables end with the run', async ({ page, scratch, address }) => {
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(
      page,
      "SET SESSION sql_mode = 'ANSI'; SET @x := 7; SELECT @@sql_mode AS mode, @x AS x",
    )
    const results = resultsOf(page)
    await expect(results).toContainText('3 statements')
    await statementTab(page, 3).click()
    await expect(gridOf(results).getByRole('gridcell').first()).toContainText('ANSI')
    await expect(gridOf(results).getByRole('gridcell', { name: '7', exact: true })).toBeVisible()
    await runAndWait(page, 'SELECT @x AS x, @@sql_mode AS mode')
    const cells = gridOf(results).getByRole('gridcell')
    await expect(cells.first()).toHaveText('NULL')
    await expect(cells.nth(1)).not.toContainText('ANSI')
    await expect(cells.nth(1)).toContainText('STRICT_TRANS_TABLES')
    // The options panel says so.
    await page.getByRole('button', { name: 'Options' }).click()
    await expect(
      page.getByText(/Session settings such as SET and user variables end with each run/),
    ).toBeVisible()
  })

  test('run in one transaction: rollback after an error; DDL commits what came before', async ({
    page,
    scratch,
    address,
  }) => {
    await scratch.q(`CREATE TABLE ${quote(scratch.name)}.tx (id INT PRIMARY KEY) ENGINE=InnoDB`)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await setRunOption(page, 'Run in one transaction', true)

    // Batch 1: the second insert fails, so nothing stays.
    await run(
      page,
      'INSERT INTO tx VALUES (1);\nINSERT INTO tx VALUES (1);\nINSERT INTO tx VALUES (3)',
    )
    const results = resultsOf(page)
    await expect(results.getByRole('alert')).toContainText('Error 1062')
    await expect(results).toContainText('The transaction was rolled back.')
    expect(await countRows(scratch, 'tx')).toBe(0)

    // Batch 2: an ALTER in the middle ends the transaction; the first insert stays.
    await setSql(
      page,
      'INSERT INTO tx VALUES (10);\nALTER TABLE tx ADD COLUMN c INT NULL;\nINSERT INTO nope VALUES (10)',
    )
    await expect(
      page.getByText(
        'Some statements here end the transaction by themselves; earlier changes stay.',
      ),
    ).toBeVisible()
    await runButton(page).click()
    await expect(results.getByRole('alert')).toContainText('Error 1146')
    expect(await countRows(scratch, 'tx')).toBe(1)
    const cols = await scratch.q<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tx'`,
      [scratch.name],
    )
    expect(cols.map((c) => c.COLUMN_NAME).sort()).toEqual(['c', 'id'])

    // A hard statement in this mode says that it is committed or rolled back with the run; Cancel runs nothing.
    await run(page, 'DELETE FROM tx')
    await expect(confirmDialog(page)).toContainText(
      'Runs in one transaction: committed if every statement succeeds, rolled back at the first error.',
    )
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(confirmDialog(page)).toBeHidden()
    expect(await countRows(scratch, 'tx')).toBe(1)
  })

  test('a transaction left open by the text is rolled back and the result says so', async ({
    page,
    scratch,
    address,
  }) => {
    await scratch.q(`CREATE TABLE ${quote(scratch.name)}.tx (id INT PRIMARY KEY) ENGINE=InnoDB`)
    await signIn(page, address)
    await openSql(page, scratch.name)
    await runAndWait(page, 'START TRANSACTION;\nINSERT INTO tx VALUES (50)')
    await expect(resultsOf(page)).toContainText('2 statements')
    await expect(resultsOf(page)).toContainText(
      'A transaction was left open by the text; it was rolled back when the connection closed.',
    )
    expect(await countRows(scratch, 'tx')).toBe(0)
  })

  test('foreign key: 1451 with its hint; the per-run option lets the delete run and does not leak', async ({
    page,
    scratch,
    address,
  }) => {
    const db = quote(scratch.name)
    await scratch.q(`CREATE TABLE ${db}.parent (id INT PRIMARY KEY) ENGINE=InnoDB`)
    await scratch.q(
      `CREATE TABLE ${db}.child (id INT PRIMARY KEY, pid INT NOT NULL, FOREIGN KEY (pid) REFERENCES parent (id)) ENGINE=InnoDB`,
    )
    await scratch.q(`INSERT INTO ${db}.parent VALUES (1), (2)`)
    await scratch.q(`INSERT INTO ${db}.child VALUES (1, 1)`)
    await signIn(page, address)
    await openSql(page, scratch.name)

    await runConfirmed(page, 'DELETE FROM parent')
    const results = resultsOf(page)
    await expect(results.getByRole('alert')).toContainText('Error 1451')
    await expect(results.getByRole('alert')).toContainText(
      'Other rows still reference this table or row through a foreign key.',
    )
    expect(await countRows(scratch, 'parent')).toBe(2)

    await setRunOption(page, 'Disable foreign key checks for this run', true)
    await run(page, 'DELETE FROM parent')
    await expect(confirmDialog(page)).toContainText('Foreign key checks are off for this run')
    await confirmHard(page)
    await expect(results).toContainText('Foreign key checks were off for this run.')
    await expect(results.getByText('2 rows affected')).toBeVisible()
    expect(await countRows(scratch, 'parent')).toBe(0)

    // The option is per run: the next run sees the default.
    await setRunOption(page, 'Disable foreign key checks for this run', false)
    await runAndWait(page, 'SELECT @@foreign_key_checks AS fk')
    await expect(gridOf(results).getByRole('gridcell', { name: '1', exact: true })).toBeVisible()
  })
})

test.describe('database selection and sidebar refresh', () => {
  test('USE changes the shown database; DDL in the tab refreshes the sidebar', async ({
    page,
    scratch,
    address,
  }) => {
    const other = randomName('e2e_struct_')
    scratch.trackDatabase(other)
    await scratch.q(`CREATE DATABASE ${quote(other)}`)
    await signIn(page, address)
    await openSql(page, scratch.name)

    await runAndWait(page, `USE ${quote(other)}`)
    await expect(dbSelect(page)).toHaveValue(other)

    await runAndWait(page, `USE ${quote(scratch.name)}`)
    await expect(dbSelect(page)).toHaveValue(scratch.name)

    // CREATE shows up in the tree without reload, DROP removes it.
    await runAndWait(page, 'CREATE TABLE made_here (id INT)')
    await expect(
      sidebar(page).getByRole('button', { name: 'made_here', exact: true }),
    ).toBeVisible()
    await runConfirmed(page, 'DROP TABLE made_here')
    await expect(sidebar(page).getByRole('button', { name: 'made_here', exact: true })).toBeHidden()
    expect(await tableNames(scratch)).toEqual([])
  })
})

test.describe('no SQL in browser storage', () => {
  test('after runs, a failure, a history view and a bookmark nothing of the text is stored', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    const marker = randomName('secretmarker_')
    const bookmark = randomName('bmname_')
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await runAndWait(page, `SELECT '${marker}' AS ${marker}_col`)
    await run(page, `SELECT * FROM ${marker}_missing`)
    await expect(resultsOf(page).getByRole('alert')).toContainText('1146')
    await setSql(page, `SELECT '${marker}_draft'`)
    await page.getByRole('button', { name: 'Save as bookmark' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill(bookmark)
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.getByRole('complementary', { name: 'History and bookmarks' })).toContainText(
      marker,
    )
    await page.getByRole('tab', { name: 'Bookmarks' }).click()
    await expect(page.getByText(bookmark, { exact: true })).toBeVisible()

    const dump = await browserStorageDump(page)
    expect(dump).not.toContain(marker)
    expect(dump).not.toContain(bookmark)
    expect(dump).not.toMatch(/SELECT/i)
  })
})
