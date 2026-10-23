import type { Page } from '@playwright/test'
import {
  browserStorageDump,
  confirmDialog,
  confirmHard,
  expect,
  gridOf,
  openSql,
  quote,
  resultsOf,
  run,
  runAndWait,
  runButton,
  setSql,
  signIn,
  sqlText,
  startDbloom,
  test,
} from './fixtures/sql-fixtures'
import { SERVERS, randomName } from './fixtures/scratch-db'

const drawerOf = (page: Page) => page.getByRole('complementary', { name: 'History and bookmarks' })
const openHistory = async (page: Page) => {
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(drawerOf(page)).toBeVisible()
  await drawerOf(page).getByRole('tab', { name: 'History' }).click()
}
const openBookmarks = async (page: Page) => {
  const drawer = drawerOf(page)
  if (!(await drawer.isVisible())) {
    await page.getByRole('button', { name: 'Bookmarks', exact: true }).click()
  }
  await expect(drawer).toBeVisible()
  await drawer.getByRole('tab', { name: 'Bookmarks' }).click()
}
const entries = (page: Page) => drawerOf(page).getByRole('listitem')
const entryWith = (page: Page, text: string | RegExp) => entries(page).filter({ hasText: text })

async function saveBookmark(page: Page, name: string) {
  await page.getByRole('button', { name: 'Save as bookmark' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
}

test.describe('SCN-030 history and bookmarks per target', () => {
  test('history is fetched only when it opens, lists newest first with time, database, outcome and duration', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    const calls: string[] = []
    page.on('request', (r) => {
      const body = r.postData() ?? ''
      if (r.method() === 'POST' && body.includes('"limit"') && body.includes('"source"')) {
        calls.push(body)
      }
    })
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SELECT 1 AS first_one')
    await runAndWait(page, 'SELECT 2 AS second_one')
    await runAndWait(page, 'SELECT 3 AS third_one')
    expect(calls).toHaveLength(0) // not at page load, not after a run

    await openHistory(page)
    await expect(entries(page)).toHaveCount(3)
    expect(calls.length).toBeGreaterThan(0)
    await expect(entries(page).nth(0)).toContainText('third_one')
    await expect(entries(page).nth(1)).toContainText('second_one')
    await expect(entries(page).nth(2)).toContainText('first_one')
    const newest = entries(page).first()
    await expect(newest.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/)
    await expect(newest).toContainText('Done')
    await expect(newest).toContainText(scratch.name)
    await expect(newest).toContainText(/\d+ ms|\d+\.\d+ s/)
    await expect(newest).toContainText('1 statements')
  })

  test('literals of password statements are redacted in history and in a bookmark', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner(['CREATE USER ON *.*'])
    const created = randomName('e2e_pw_')
    const secret = randomName('s3cr3t_')
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    try {
      await run(page, `CREATE USER '${created}'@'localhost' IDENTIFIED BY '${secret}'`)
      await confirmHard(page)
      await expect(resultsOf(page)).toContainText('1 statements')
      await openHistory(page)
      const entry = entries(page).first()
      await entry.getByRole('button', { expanded: false }).first().click()
      await expect(entry).toContainText("IDENTIFIED BY '***'")
      await expect(drawerOf(page)).not.toContainText(secret)

      // Bookmarking an entry stores the same redacted text.
      await entry.getByRole('button', { name: 'Bookmark', exact: true }).click()
      await page.getByRole('dialog').getByLabel('Name').fill('create user')
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
      await openBookmarks(page)
      await expect(drawerOf(page)).toContainText("IDENTIFIED BY '***'")
      await expect(drawerOf(page)).not.toContainText(secret)

      // Saving from the editor redacts too.
      await setSql(page, `ALTER USER '${created}'@'localhost' IDENTIFIED BY '${secret}'`)
      await saveBookmark(page, 'alter user')
      await expect(drawerOf(page).getByText('alter user', { exact: true })).toBeVisible()
      await expect(drawerOf(page)).not.toContainText(secret)
    } finally {
      await scratch.q('DROP USER IF EXISTS ?@?', [created, 'localhost'])
    }
  })

  test('a text above 64 KiB runs but is stored without text and marked', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await runAndWait(page, `SELECT LENGTH('${'x'.repeat(70 * 1024)}') AS len`)
    await expect(
      gridOf(resultsOf(page)).getByRole('gridcell', { name: String(70 * 1024) }),
    ).toBeVisible()
    await openHistory(page)
    await expect(entries(page)).toHaveCount(1)
    await expect(entries(page).first()).toContainText('The text was too long to keep.')
    await expect(entries(page).first().getByRole('button', { name: 'Run again' })).toBeDisabled()
  })

  test('re-run, edit, delete one entry and clear all', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await runAndWait(page, 'SELECT 11 AS eleven')
    await runAndWait(page, 'SELECT 22 AS twenty_two')
    await openHistory(page)
    await expect(entries(page)).toHaveCount(2)

    // Edit loads the text into the editor without running it.
    await entryWith(page, 'eleven').getByRole('button', { name: 'Edit' }).click()
    await expect.poll(() => sqlText(page)).toBe('SELECT 11 AS eleven')
    await expect(resultsOf(page)).toContainText('1 statements')
    await expect(gridOf(resultsOf(page)).getByRole('columnheader')).toHaveText(['twenty_two'])

    // Run again executes it and adds an entry.
    await entryWith(page, 'eleven').getByRole('button', { name: 'Run again' }).click()
    await expect(gridOf(resultsOf(page)).getByRole('columnheader')).toHaveText(['eleven'])
    await expect(entries(page)).toHaveCount(3)

    // Delete asks once more; blur cancels.
    const victim = entryWith(page, 'twenty_two')
    await victim.getByRole('button', { name: 'Delete', exact: true }).click()
    await victim.getByRole('button', { name: 'Delete now' }).click()
    await expect(entries(page)).toHaveCount(2)
    await expect(drawerOf(page)).not.toContainText('twenty_two')

    // Clear all.
    await drawerOf(page).getByRole('button', { name: 'Clear history' }).click()
    await drawerOf(page).getByRole('button', { name: 'Clear all entries' }).click()
    await expect(drawerOf(page).getByText('Nothing has run on this server yet.')).toBeVisible()
  })

  test('bookmarks: save, a duplicate name is refused, rename, re-run, delete', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await setSql(page, 'SELECT 5 AS five')
    await saveBookmark(page, 'customers by name')
    await openBookmarks(page)
    const row = drawerOf(page).getByRole('listitem').first() // the only bookmark
    await expect(row).toContainText('customers by name')
    await expect(row).toContainText(scratch.name)

    // The same name again: a clear error, the dialog stays.
    await page.getByRole('button', { name: 'Save as bookmark' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill('customers by name')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
      'A bookmark with this name already exists.',
    )
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

    // Rename.
    await row.getByRole('button', { name: 'Rename' }).click()
    await row.getByLabel('Name').fill('count by name')
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    const renamed = drawerOf(page).getByRole('listitem').first()
    await expect(renamed).toContainText('count by name')
    await expect(drawerOf(page).getByText('customers by name', { exact: true })).toHaveCount(0)

    // Re-run from the bookmark.
    await setSql(page, 'SELECT 0 AS other')
    await renamed.getByRole('button', { name: 'Run again' }).click()
    await expect(gridOf(resultsOf(page)).getByRole('columnheader')).toHaveText(['five'])
    await expect.poll(() => sqlText(page)).toBe('SELECT 5 AS five')

    // Delete.
    await renamed.getByRole('button', { name: 'Delete', exact: true }).click()
    await renamed.getByRole('button', { name: 'Delete now' }).click()
    await expect(drawerOf(page).getByText('No bookmarks for this server yet.')).toBeVisible()
  })

  test('every user sees only their own history and bookmarks', async ({
    browser,
    scratch,
    address,
    newOwner,
    baseURL,
  }) => {
    const [a, b] = [await newOwner(), await newOwner()]
    const pageOf = async (owner: { user: string; password: string }) => {
      const context = await browser.newContext({ baseURL })
      const page = await context.newPage()
      await signIn(page, address, owner.user, owner.password)
      await openSql(page, scratch.name)
      return { page, context }
    }
    const one = await pageOf(a)
    const two = await pageOf(b)
    await runAndWait(one.page, 'SELECT 1 AS only_for_a')
    await setSql(one.page, 'SELECT 1 AS bookmark_of_a')
    await saveBookmark(one.page, 'a private bookmark')

    await runAndWait(two.page, 'SELECT 2 AS only_for_b')
    await openHistory(two.page)
    await expect(entries(two.page)).toHaveCount(1)
    await expect(drawerOf(two.page)).toContainText('only_for_b')
    await expect(drawerOf(two.page)).not.toContainText('only_for_a')
    await openBookmarks(two.page)
    await expect(drawerOf(two.page).getByText('No bookmarks for this server yet.')).toBeVisible()

    await openHistory(one.page)
    await expect(entries(one.page)).toHaveCount(1)
    await expect(drawerOf(one.page)).not.toContainText('only_for_b')
    await one.context.close()
    await two.context.close()
  })

  test('another target has its own lists: an entry made on MariaDB is not seen on MySQL', async ({
    browser,
    baseURL,
    product,
    scratch,
  }) => {
    test.skip(product !== 'mysql', 'uses both targets in one test; runs once, in the mysql project')
    const marker = randomName('mark_')
    const maria = await (
      await import('mysql2/promise')
    ).createConnection({
      host: SERVERS.mariadb.host,
      port: SERVERS.mariadb.port,
      user: 'root',
      password: 'root',
    })
    await maria.query(`CREATE DATABASE IF NOT EXISTS ${quote(scratch.name)}`)
    try {
      const contexts = await Promise.all(
        (['mysql', 'mariadb'] as const).map(async (target) => {
          const context = await browser.newContext({ baseURL })
          const page = await context.newPage()
          await signIn(page, `${SERVERS[target].host}:${SERVERS[target].port}`)
          await openSql(page, scratch.name)
          return { context, page }
        }),
      )
      const [onMysql, onMaria] = contexts as [(typeof contexts)[0], (typeof contexts)[0]]
      await runAndWait(onMaria.page, `SELECT 1 AS ${marker}`)
      await setSql(onMaria.page, `SELECT 2 AS ${marker}_bm`)
      await saveBookmark(onMaria.page, `${marker} bookmark`)
      await openHistory(onMaria.page)
      await expect(entryWith(onMaria.page, marker).first()).toBeVisible()

      await openHistory(onMysql.page)
      // Wait for the list to load (entries of this user from other tests, or the empty text).
      await expect(
        entries(onMysql.page)
          .first()
          .or(drawerOf(onMysql.page).getByText('Nothing has run on this server yet.')),
      ).toBeVisible()
      await expect(drawerOf(onMysql.page)).not.toContainText(marker)
      await openBookmarks(onMysql.page)
      await expect(drawerOf(onMysql.page)).not.toContainText(marker)
      for (const { context } of contexts) await context.close()
    } finally {
      await maria.query(`DROP DATABASE IF EXISTS ${quote(scratch.name)}`)
      await maria.end()
    }
  })

  test('history and bookmarks survive a restart of DBLoom', async ({
    browser,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    let server = await startDbloom(3103)
    const dataDir = server.dataDir
    try {
      const context = await browser.newContext({ baseURL: server.url })
      const page = await context.newPage()
      await signIn(page, address, owner.user, owner.password)
      await openSql(page, scratch.name)
      await runAndWait(page, 'SELECT 1 AS before_restart')
      await setSql(page, 'SELECT 2 AS bookmarked_before')
      await saveBookmark(page, 'kept bookmark')
      await context.close()

      await server.stop()
      server = await startDbloom(3103, { dataDir })

      const again = await browser.newContext({ baseURL: server.url })
      const page2 = await again.newPage()
      await signIn(page2, address, owner.user, owner.password)
      await openSql(page2, scratch.name)
      await openHistory(page2)
      await expect(drawerOf(page2)).toContainText('before_restart')
      await openBookmarks(page2)
      await expect(drawerOf(page2)).toContainText('kept bookmark')
      await again.close()
    } finally {
      await server.stop()
    }
  })
})

test.describe('SCN-031 stateless mode and nothing in the browser', () => {
  test('session-only notice, lists gone after a new login, no SQL in browser storage, unsaved text asks', async ({
    browser,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    const server = await startDbloom(3104, { env: { DBLOOM_STORE: 'none' } })
    const marker = randomName('statelessmark_')
    try {
      const context = await browser.newContext({ baseURL: server.url })
      const page = await context.newPage()
      await signIn(page, address, owner.user, owner.password)
      await openSql(page, scratch.name)
      await runAndWait(page, `SELECT '${marker}' AS ${marker}`)

      await openHistory(page)
      await expect(
        drawerOf(page).getByText(
          'Kept for this session only. It is gone when you log out or the server restarts.',
        ),
      ).toBeVisible()
      await expect(entryWith(page, marker)).toHaveCount(1)
      await setSql(page, `SELECT 2 AS ${marker}_bm`)
      await saveBookmark(page, `${marker} bookmark`)
      await openBookmarks(page)
      await expect(drawerOf(page)).toContainText('Kept for this session only.')
      await expect(drawerOf(page)).toContainText(`${marker} bookmark`)

      // Nothing of the text, the results or the bookmark name is in browser storage.
      const dump = await browserStorageDump(page)
      expect(dump).not.toContain(marker)
      expect(dump).not.toMatch(/SELECT/i)

      // Typed, not yet run text: closing the tab asks first; keeping it leaves the text.
      await setSql(page, 'SELECT 99 AS unsaved')
      await page.getByRole('button', { name: /^Close SQL/ }).click()
      const ask = confirmDialog(page)
      await expect(ask).toContainText('Close this SQL tab?')
      await ask.getByRole('button', { name: 'Keep editing' }).click()
      await expect(ask).toBeHidden()
      await expect.poll(() => sqlText(page)).toBe('SELECT 99 AS unsaved')

      // Log out and in again: both lists are empty.
      await page.getByRole('button', { name: 'Log out' }).click()
      await signIn(page, address, owner.user, owner.password)
      await openSql(page, scratch.name)
      await openHistory(page)
      await expect(drawerOf(page).getByText('Nothing has run on this server yet.')).toBeVisible()
      await openBookmarks(page)
      await expect(drawerOf(page).getByText('No bookmarks for this server yet.')).toBeVisible()
      await context.close()
    } finally {
      await server.stop()
    }
  })

  test('the stateful server writes nothing of the SQL text to browser storage', async ({
    page,
    scratch,
    address,
    newOwner,
  }) => {
    const owner = await newOwner()
    await signIn(page, address, owner.user, owner.password)
    await openSql(page, scratch.name)
    await runAndWait(page, "SELECT 'plain_marker_text' AS plain_marker_col")
    await expect(runButton(page)).toBeVisible()
    const dump = await browserStorageDump(page)
    expect(dump).not.toContain('plain_marker')
  })
})
