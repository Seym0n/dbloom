import { expect, signIn, test } from './fixtures/scratch-db'
import type { Page } from '@playwright/test'
import { gz, openImport, pickFile, upload, zip1, dropPrefWrites } from './fixtures/io-fixtures'
import { openExport, runExport } from './fixtures/io-fixtures'
import { sidebar } from './fixtures/scratch-db'

/** SCN-056 (SQL dump with confirmation) and SCN-057 (errors, ignore, skip, rollback) of SPEC/25. */

const dialog = (page: Page) => page.getByRole('dialog')

/** Opens the confirm dialog, types the database name when asked, and starts the import. */
async function confirmImport(page: Page, typed?: string) {
  await page.getByRole('button', { name: 'Import…', exact: true }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Import this file?' })).toBeVisible()
  if (typed !== undefined) await dialog(page).getByRole('textbox').fill(typed)
  await dialog(page).getByRole('button', { name: 'Import', exact: true }).click()
}

const finished = (page: Page) => page.getByRole('status').getByRole('heading')

test.describe('SCN-056 import of an SQL dump with confirmation', () => {
  test('gzip dump: analysis, confirmation with typed name, result, sidebar shows the table', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    const dump = [
      'CREATE TABLE a (id INT PRIMARY KEY, v VARCHAR(10));',
      "INSERT INTO a VALUES (1,'x'),(2,'y');",
      'DROP TABLE IF EXISTS gone;',
      '',
    ].join('\n')
    await pickFile(page, upload('dump.sql.gz', gz(dump)))
    await expect(page.getByText('3 statements', { exact: true })).toBeVisible()
    await expect(page.getByText('Can delete data: 1 DROP TABLE')).toBeVisible()
    await expect(page.getByText('gzip', { exact: true })).toBeVisible()
    await expect(page.getByText(scratch.name).first()).toBeVisible()
    await expect(page.getByText(address).first()).toBeVisible()

    // The dialog names server, database and file and needs the typed name for a hard statement.
    await page.getByRole('button', { name: 'Import…', exact: true }).click()
    await expect(dialog(page).getByText('dump.sql.gz')).toBeVisible()
    await expect(dialog(page).getByText('1 statements can delete data:')).toBeVisible()
    await expect(dialog(page).getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(
      await scratch.q('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [
        scratch.name,
      ]),
    ).toEqual([])

    await confirmImport(page, scratch.name)
    await expect(finished(page).first()).toHaveText('Import finished')
    await expect(page.getByText('Statements run').locator('..')).toContainText('3')
    await expect(page.getByText('dump.sql.gz').first()).toBeVisible()
    // The server note is a note, not a failure.
    await expect(page.getByText('Notes from the server (1)')).toBeVisible()
    await expect(page.getByText('Failed').locator('..')).toContainText('0')
    expect(await scratch.q('SELECT COUNT(*) AS n FROM `' + scratch.name + '`.a')).toEqual([
      { n: 2 },
    ])
    // The sidebar lists the new table without a reload.
    await expect(sidebar(page).getByRole('button', { name: 'a', exact: true })).toBeVisible()
    // Foreign key checks of the pool are back to their old value.
    const [fk] = await scratch.q<{ v: number }>('SELECT @@GLOBAL.foreign_key_checks AS v')
    expect(Number(fk?.v)).toBe(1)
  })

  test('a start without the confirmation token is refused and nothing runs', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await pickFile(page, upload('d.sql', 'CREATE TABLE a (id INT);\nDROP TABLE IF EXISTS gone;\n'))
    await expect(page.getByText('2 statements', { exact: true })).toBeVisible()
    // The page sends a token; strip it from the request like a hand-made call would.
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('"confirmToken"')) {
        const stripped = body
          .replace('"confirmToken"', '"confirmTokenX"')
          .replace(/"confirmTokenX"/, '"skipRefusedX"')
        return route.continue({ postData: stripped })
      }
      return route.continue()
    })
    await confirmImport(page, scratch.name)
    await expect(dialog(page).getByRole('alert')).toBeVisible()
    expect(
      await scratch.q('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [
        scratch.name,
      ]),
    ).toEqual([])
  })

  test('a script without a database is refused in the analysis at server scope', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await page.getByRole('button', { name: 'Server export and import' }).click()
    await page.getByRole('menuitem', { name: 'Import…' }).click()
    await pickFile(
      page,
      upload('nodb.sql', 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n'),
    )
    await expect(page.getByText(/selects no database/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import…', exact: true })).toBeDisabled()
    void scratch
  })

  test('content decides, not the name; a truncated gzip is refused', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    // A text file named .png (the picker allows any name through the file input) is read as SQL by content.
    await pickFile(page, upload('picture.png', 'CREATE TABLE a (id INT);\n'))
    await expect(page.getByText('1 statements', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Choose another file' }).click()
    // A gzip cut off in the middle is damaged, whatever its name says.
    const damaged = gz('INSERT INTO a VALUES (1);\n'.repeat(2000)).subarray(0, 40)
    await pickFile(page, upload('cut.sql.gz', damaged))
    await expect(page.getByRole('alert')).toContainText(/truncated|damaged|not the archive/i)
  })

  test('zip dump is read by content', async ({ page, scratch, address }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await pickFile(
      page,
      upload(
        'dump.sql.zip',
        zip1('dump.sql', 'CREATE TABLE z (id INT);\nINSERT INTO z VALUES (7);\n'),
      ),
    )
    await expect(page.getByText('zip', { exact: true }).first()).toBeVisible()
    await confirmImport(page)
    await expect(finished(page).first()).toHaveText('Import finished')
    expect(await scratch.q('SELECT id FROM `' + scratch.name + '`.z')).toEqual([{ id: 7 }])
  })

  test('round trip: an exported table imports again into a fresh database', async ({
    page,
    scratch,
    address,
  }) => {
    await dropPrefWrites(page)
    const db = '`' + scratch.name + '`'
    await scratch.q(
      `CREATE TABLE ${db}.src (id INT PRIMARY KEY, t VARCHAR(40), b VARBINARY(8)) CHARACTER SET utf8mb4`,
    )
    await scratch.q(
      `INSERT INTO ${db}.src VALUES (1,'日本語 😀',0x00ff),(2,NULL,NULL),(3,'it''s \\\\ ok','')`,
    )
    await signIn(page, address)
    await openExport(page, scratch.name, 'src')
    const out = await runExport(page)
    const target = scratch.name + '_copy'
    scratch.trackDatabase(target)
    await scratch.q('CREATE DATABASE `' + target + '` CHARACTER SET utf8mb4')
    await page.reload()
    await openImport(page, target)
    await pickFile(page, { name: 'src.sql', mimeType: 'application/sql', buffer: out.body })
    await confirmImport(page)
    await expect(finished(page).first()).toHaveText('Import finished')
    const a = await scratch.q(`SELECT id, t, HEX(b) AS b FROM ${db}.src ORDER BY id`)
    const b = await scratch.q('SELECT id, t, HEX(b) AS b FROM `' + target + '`.src ORDER BY id')
    expect(b).toEqual(a)
  })
})

test.describe('SCN-057 import errors, ignore, skip, rollback', () => {
  const statements = (): string => {
    const out: string[] = []
    for (let i = 1; i <= 100; i++) {
      if (i === 50) out.push('INSERT INTO t VALUES (1050, 5);')
      else if (i === 80) out.push('INSERT INTO t VALUES (1, 2, 3);')
      else out.push(`INSERT INTO t VALUES (${i}, ${i});`)
    }
    return out.join('\n') + '\n'
  }
  const rowCount = async (scratch: { q: (s: string) => Promise<{ n: number }[]>; name: string }) =>
    Number((await scratch.q('SELECT COUNT(*) AS n FROM `' + scratch.name + '`.t'))[0]?.n)

  test.beforeEach(async ({ page, scratch, address }) => {
    await scratch.q(
      'CREATE TABLE `' + scratch.name + '`.t (id INT PRIMARY KEY, u INT UNIQUE) ENGINE=InnoDB',
    )
    await signIn(page, address)
    await openImport(page, scratch.name)
    await pickFile(page, upload('hundred.sql', statements()))
    await expect(page.getByText('100 statements', { exact: true })).toBeVisible()
  })

  test('default run stops at statement 50 with its details; 1 to 49 are applied', async ({
    page,
    scratch,
  }) => {
    await confirmImport(page)
    await expect(finished(page).first()).toHaveText('Failed')
    const result = page.getByRole('status')
    await expect(result).toContainText('Statement 50')
    await expect(result).toContainText('error 1062')
    await expect(result).toContainText('line 50')
    await expect(result).toContainText(/byte \d+/)
    await expect(result).toContainText('Duplicate entry')
    await expect(result).toContainText('INSERT INTO t VALUES (1050, 5)')
    expect(await rowCount(scratch)).toBe(49)
  })

  test('ignore errors: 98 run, 2 failed', async ({ page, scratch }) => {
    await page.getByLabel('Ignore errors and continue').check()
    await confirmImport(page)
    await expect(finished(page).first()).toBeVisible()
    const result = page.getByRole('status')
    await expect(result.getByText('Statements run').locator('..')).toContainText('98')
    await expect(result.getByText('Failed').locator('..')).toContainText('2')
    expect(await rowCount(scratch)).toBe(98)
  })

  test('skip the first 60 statements: the run starts at 61', async ({ page, scratch }) => {
    await page.getByLabel('Skip the first statements').fill('60')
    await page.getByLabel('Ignore errors and continue').check()
    await confirmImport(page)
    await expect(finished(page).first()).toBeVisible()
    const result = page.getByRole('status')
    await expect(result.getByText('Skipped', { exact: true }).locator('..')).toContainText('60')
    await expect(result.getByText('Statements run').locator('..')).toContainText('39')
    const ids = (
      await scratch.q<{ id: number }>('SELECT MIN(id) AS id FROM `' + scratch.name + '`.t')
    )[0]
    expect(Number(ids?.id)).toBe(61)
    expect(await rowCount(scratch)).toBe(39)
  })

  test('rollback leaves no row and says what is not rolled back', async ({ page, scratch }) => {
    await page.getByLabel('Roll back on error').check()
    await expect(
      page.getByText('Only helps for transactional tables', { exact: false }),
    ).toBeVisible()
    await confirmImport(page)
    await expect(finished(page).first()).toHaveText('Failed')
    expect(await rowCount(scratch)).toBe(0)
  })
})
