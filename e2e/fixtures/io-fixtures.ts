import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { expect, type Locator, type Page } from '@playwright/test'
import { zipSync } from 'fflate'
import { expandDatabase, sidebar, type Scratch } from './scratch-db'

/** Absolute path of a file in `e2e/fixtures/io/` (Playwright runs from the repository root). */
export const fixturePath = (name: string) => resolve('e2e/fixtures/io', name)

/** Content of a fixture file. */
export const fixture = (name: string) => readFileSync(fixturePath(name))

/** An in-memory upload for `setInputFiles`. */
export const upload = (
  name: string,
  body: string | Buffer,
  mimeType = 'application/octet-stream',
) => ({
  name,
  mimeType,
  buffer: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
})
export const gz = (body: string | Buffer) =>
  gzipSync(typeof body === 'string' ? Buffer.from(body) : body)
export const zip1 = (entry: string, body: string | Buffer) =>
  Buffer.from(zipSync({ [entry]: typeof body === 'string' ? Buffer.from(body) : body }))

/**
 * `customer` of SPEC 25 (SCN-052 ff.): `rows` rows, a BIGINT above 2^53 and a binary value in row 1, a spreadsheet
 * formula in row 2, a NULL note in row 3, CJK and emoji in row 4.
 */
export async function seedIoCustomer(scratch: Scratch, rows = 1000) {
  const db = `\`${scratch.name}\``
  await scratch.q(
    `CREATE TABLE ${db}.customer (
       id INT NOT NULL AUTO_INCREMENT,
       name VARCHAR(100) NOT NULL,
       note TEXT NULL,
       big BIGINT UNSIGNED NULL,
       bin VARBINARY(16) NULL,
       amount DECIMAL(10,2) NOT NULL DEFAULT 0,
       PRIMARY KEY (id)
     ) CHARACTER SET utf8mb4`,
  )
  const values: unknown[][] = []
  for (let i = 1; i <= rows; i++) {
    values.push([
      i,
      i === 4 ? '日本語 😀 Ünï' : `customer ${i}`,
      i === 2 ? `=cmd|' /C calc'!A1` : i === 3 ? null : `note ${i}`,
      i === 1 ? '9007199254740993' : null,
      i === 1 ? Buffer.from('deadbeef', 'hex') : null,
      (i * 1.25).toFixed(2),
    ])
  }
  for (let at = 0; at < values.length; at += 500) {
    await scratch.q(`INSERT INTO ${db}.customer (id, name, note, big, bin, amount) VALUES ?`, [
      values.slice(at, at + 500),
    ])
  }
}

/** Three small tables, a view, and one heavy table of about 3 MiB for the "skip large tables" option (SCN-053). */
export async function seedIoDatabase(scratch: Scratch) {
  const db = `\`${scratch.name}\``
  await scratch.q(
    `CREATE TABLE ${db}.alpha (id INT PRIMARY KEY, label VARCHAR(20)) CHARACTER SET utf8mb4`,
  )
  await scratch.q(
    `CREATE TABLE ${db}.beta (id INT PRIMARY KEY, alpha_id INT, KEY (alpha_id)) CHARACTER SET utf8mb4`,
  )
  await scratch.q(`INSERT INTO ${db}.alpha VALUES (1,'one'),(2,'two'),(3,NULL)`)
  await scratch.q(`INSERT INTO ${db}.beta VALUES (1,1),(2,2)`)
  await scratch.q(`CREATE VIEW ${db}.alpha_view AS SELECT id, label FROM ${db}.alpha WHERE id < 3`)
  await scratch.q(
    `CREATE TABLE ${db}.heavy (id INT PRIMARY KEY AUTO_INCREMENT, filler TEXT) CHARACTER SET utf8mb4`,
  )
  const filler = 'x'.repeat(1000)
  const rows = Array.from({ length: 500 }, () => [filler])
  for (let i = 0; i < 6; i++) {
    await scratch.q(`INSERT INTO ${db}.heavy (filler) VALUES ?`, [rows])
  }
  await scratch.q(`ANALYZE TABLE ${db}.heavy`)
}

/** Opens the export page of a table or a database from the sidebar menu. */
export async function openExport(page: Page, db: string, table?: string) {
  await expandDatabase(page, db)
  if (table) {
    await sidebar(page)
      .getByRole('button', { name: `Actions for ${table}`, exact: true })
      .click()
  } else {
    await sidebar(page)
      .getByRole('button', { name: `Actions for database ${db}`, exact: true })
      .click()
  }
  await page.getByRole('menuitem', { name: 'Export…' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Export')
}

export async function openImport(page: Page, db: string, table?: string) {
  await expandDatabase(page, db)
  if (table) {
    await sidebar(page)
      .getByRole('button', { name: `Actions for ${table}`, exact: true })
      .click()
  } else {
    await sidebar(page)
      .getByRole('button', { name: `Actions for database ${db}`, exact: true })
      .click()
  }
  await page.getByRole('menuitem', { name: 'Import…' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Import into')
}

export const customMode = async (page: Page) => {
  await page.getByRole('button', { name: 'Custom', exact: true }).click()
}

/**
 * Clicks the Export button and returns the downloaded file and the headers of the download route. Chromium does not
 * report the response of a download to the page, so the headers come from a second GET of "Download again".
 */
export async function runExport(
  page: Page,
  button: Locator = page.getByRole('button', { name: 'Export', exact: true }),
) {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  const path = await download.path()
  const link = page.getByRole('link', { name: 'Download again' })
  await expect(link).toBeVisible()
  const response = await page.request.get((await link.getAttribute('href')) as string)
  return {
    headers: response.headers(),
    status: response.status(),
    name: download.suggestedFilename(),
    body: readFileSync(path),
  }
}

export const gunzipText = (b: Buffer) => gunzipSync(b).toString('utf8')

/** Chooses a file in the import page's picker. */
export async function pickFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await page.getByLabel('Choose a file', { exact: true }).setInputFiles(file)
}

export const importButton = (page: Page) =>
  page.getByRole('button', { name: 'Import…', exact: true })

/**
 * The export page remembers format, compression and file name per user in the shared test store. A test that does not
 * test that memory drops the writes (the page ignores a failed save), so no other spec sees its choices.
 */
export async function dropPrefWrites(page: Page) {
  await page.route('**/_serverFn/**', async (route) => {
    const body = route.request().postData() ?? ''
    if (route.request().method() === 'POST' && body.includes('exportCompression')) {
      return route.abort()
    }
    return route.continue()
  })
}
