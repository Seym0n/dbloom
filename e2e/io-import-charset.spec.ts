import { expect, signIn, test } from './fixtures/scratch-db'
import type { Page } from '@playwright/test'
import { openImport, pickFile } from './fixtures/io-fixtures'

/** SCN-061 of SPEC/25: windows-1252, UTF-16LE with BOM, UTF-8 with BOM, and an invalid byte. */

const finished = (page: Page) => page.getByRole('status').getByRole('heading').first()

async function startImport(page: Page) {
  await page.getByRole('button', { name: 'Import…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click()
}

const TEXT = 'name,city\nMüller,Köln\nÅse,Malmö\n'
const file = (name: string, buffer: Buffer) => ({ name, mimeType: 'text/csv', buffer })

/** Latin-1 range characters are one byte in windows-1252, so the buffer is built from char codes. */
const win1252 = (s: string) => Buffer.from(s, 'latin1')

test.describe('SCN-061 charset and BOM', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await scratch.q(
      'CREATE TABLE `' +
        scratch.name +
        '`.people (name VARCHAR(40), city VARCHAR(40)) CHARACTER SET utf8mb4',
    )
    await signIn(page, address)
    await openImport(page, scratch.name, 'people')
  })

  const people = (scratch: { q: (s: string) => Promise<Record<string, string>[]>; name: string }) =>
    scratch.q('SELECT name, city FROM `' + scratch.name + '`.people ORDER BY name')

  const expected = [
    { name: 'Müller', city: 'Köln' },
    { name: 'Åse', city: 'Malmö' },
  ].sort((a, b) => a.name.localeCompare(b.name, 'sv'))

  test('windows-1252 with the chosen character set', async ({ page, scratch }) => {
    await pickFile(page, file('w.csv', win1252(TEXT)))
    // Read as UTF-8 the umlauts are invalid bytes; the page says so and keeps the charset choice reachable.
    await expect(page.getByRole('alert').first()).toBeVisible()
    await page.getByLabel('Character set').selectOption('windows-1252')
    await page.getByLabel('First row has column names').check()
    await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
    await startImport(page)
    await expect(finished(page)).toHaveText('Import finished')
    expect(await people(scratch)).toEqual(expect.arrayContaining(expected))
  })

  test('UTF-16LE with BOM needs no choice and the BOM is not in the first column name', async ({
    page,
    scratch,
  }) => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, 'utf16le')])
    await pickFile(page, file('u16.csv', buf))
    await page.getByLabel('First row has column names').check()
    await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'name', exact: true })).toHaveValue('name')
    await startImport(page)
    await expect(finished(page)).toHaveText('Import finished')
    expect(await people(scratch)).toEqual(expect.arrayContaining(expected))
  })

  test('UTF-8 with BOM', async ({ page, scratch }) => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf8')])
    await pickFile(page, file('u8.csv', buf))
    await page.getByLabel('First row has column names').check()
    await expect(page.getByRole('combobox', { name: 'name', exact: true })).toHaveValue('name')
    await startImport(page)
    await expect(finished(page)).toHaveText('Import finished')
    expect(await people(scratch)).toEqual(expect.arrayContaining(expected))
  })

  test('an invalid byte stops the analysis and no row is stored', async ({ page, scratch }) => {
    // 0xE4 alone is not valid UTF-8; the rows before it are fine.
    await pickFile(
      page,
      file(
        'bad.csv',
        Buffer.concat([
          Buffer.from('name,city\nAnna,Bonn\n'),
          Buffer.from([0x4d, 0xe4, 0x72]),
          Buffer.from(',x\n'),
        ]),
      ),
    )
    await expect(page.getByRole('alert').first()).toContainText(
      /not valid in the chosen character set\. \(byte 21, line 3\)/,
    )
    await expect(page.getByRole('button', { name: 'Import…', exact: true })).toHaveCount(0)
    expect(await people(scratch)).toEqual([])
  })
})
