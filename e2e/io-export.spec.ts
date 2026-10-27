import { expect, signIn, test } from './fixtures/scratch-db'
import {
  customMode,
  dropPrefWrites,
  gunzipText,
  openExport,
  runExport,
  seedIoCustomer,
} from './fixtures/io-fixtures'

/** SCN-052 and SCN-054 of SPEC/25: quick export of a table, CSV and JSON specifics. */

test.describe('SCN-052 quick export of a table', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await dropPrefWrites(page)
    await seedIoCustomer(scratch, 1000)
    await signIn(page, address)
    await openExport(page, scratch.name, 'customer')
  })

  test('summary, download headers, SQL content, text view with Copy', async ({ page, scratch }) => {
    await expect(page.getByTestId('quick-summary')).toHaveText(
      `SQL, structure and data, no compression, customer_${scratch.name}.sql`,
    )
    const out = await runExport(page)
    expect(out.status).toBe(200)
    expect(out.name).toBe(`customer_${scratch.name}.sql`)
    expect(out.headers['content-type']).toContain('application/sql')
    expect(out.headers['content-disposition']).toMatch(/^attachment; filename="customer_/)
    expect(out.headers['cache-control']).toContain('no-store')
    expect(out.headers['x-content-type-options']).toBe('nosniff')
    const sql = out.body.toString('utf8')
    expect(sql).toContain('CREATE TABLE')
    expect(sql).toContain('SET NAMES utf8mb4')
    expect(sql).toContain('foreign_key_checks')
    // 1 000 rows in extended inserts: every row is a tuple, and there are far fewer INSERT statements.
    expect((sql.match(/^INSERT INTO/gm) ?? []).length).toBeLessThan(50)
    expect((sql.match(/\(\d+,'/g) ?? []).length).toBe(1000)
    expect(sql).toContain('日本語 😀 Ünï')
    // The result view names the file and offers it again.
    await expect(page.getByRole('heading', { name: 'Export finished' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Download again' })).toBeVisible()
  })

  test('text view shows the same text and a working Copy button', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await customMode(page)
    await page.getByRole('radio', { name: 'Show as text' }).check()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const text = page.getByRole('textbox', { name: 'Export as text' })
    await expect(text).toBeVisible()
    const shown = await text.inputValue().catch(async () => (await text.textContent()) ?? '')
    expect(shown).toContain('CREATE TABLE')
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByText('Copied')).toBeVisible()
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toContain('CREATE TABLE')
    expect(clip.length).toBeGreaterThan(1000)
    // Refresh re-runs the same request.
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Export as text' })).toBeVisible()
  })
})

test.describe('SCN-054 CSV and JSON specifics', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await dropPrefWrites(page)
    await seedIoCustomer(scratch, 20)
    await signIn(page, address)
    await openExport(page, scratch.name, 'customer')
    await customMode(page)
  })

  test('Excel preset with BOM: one BOM, semicolon, CRLF, NULL as NULL', async ({ page }) => {
    await page.getByLabel('Format', { exact: true }).selectOption('csv')
    await page.getByLabel('Preset').selectOption('excel')
    await page.getByLabel('Write a UTF-8 byte order mark').check()
    const out = await runExport(page)
    expect(out.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(out.name).toMatch(/\.csv$/)
    const bytes = out.body
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.toString('utf8')
    expect(text.indexOf('﻿', 1)).toBe(-1)
    const lines = text.slice(1).split('\r\n')
    expect(lines[0]).toBe('id;name;note;big;bin;amount')
    // Row 3 has a NULL note.
    expect(lines.find((l) => l.startsWith('3;'))).toContain('NULL')
    expect(text).not.toMatch(/[^\r]\n/)
  })

  test('formula cell is neutralised by default and exported unchanged on opt-out', async ({
    page,
  }) => {
    await page.getByLabel('Format', { exact: true }).selectOption('csv')
    const first = await runExport(page)
    const text = first.body.toString('utf8')
    expect(text).toContain(`'=cmd|' /C calc'!A1`)
    expect(text).not.toMatch(/(^|,)"?=cmd/m)
    await page.getByRole('button', { name: 'Back to options' }).click()
    await customMode(page).catch(() => undefined)
    await page.getByLabel('Format', { exact: true }).selectOption('csv')
    await page.getByLabel('Neutralise formulas').uncheck()
    const second = await runExport(page)
    expect(second.body.toString('utf8')).toMatch(/(^|,)"?=cmd/m)
  })

  test('JSON: header object, BIGINT above 2^53 as string, binary as 0x text', async ({ page }) => {
    await page.getByLabel('Format', { exact: true }).selectOption('json')
    const out = await runExport(page)
    expect(out.headers['content-type']).toContain('application/json')
    expect(out.name).toMatch(/\.json$/)
    const doc = JSON.parse(out.body.toString('utf8')) as Record<string, unknown>[]
    expect(doc[0]).toMatchObject({ type: 'header', generator: 'DBLoom' })
    const table = doc.find((d) => d.type === 'table') as { data: Record<string, unknown>[] }
    expect(table.data).toHaveLength(20)
    expect(table.data[0]).toMatchObject({
      big: '9007199254740993',
      bin: '0xdeadbeef',
      note: 'note 1',
    })
    expect(table.data[2]?.note).toBeNull()
    // Pretty printing is on by default.
    expect(out.body.toString('utf8')).toContain('\n  ')
  })

  test('gzip output decompresses to the SQL text', async ({ page }) => {
    await page.getByLabel('Compression').selectOption('gzip')
    const out = await runExport(page)
    expect(out.name).toMatch(/\.sql\.gz$/)
    expect(out.headers['content-type']).toContain('application/gzip')
    expect(gunzipText(out.body)).toContain('CREATE TABLE')
  })
})
