import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/**
 * A textarea hands back LF only; the form puts the stored line terminators back by position
 * (`restoreLineBreaks`, DATA-ISS-010 and 115). Editing one line of a CR LF text must keep every CR LF.
 */

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

test.describe('line terminators survive an edit through the form', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.notes (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, txt TEXT NULL)`,
    )
    await scratch.q(`INSERT INTO ${db}.notes VALUES (1, 'crlf', ?), (2, 'lf', ?)`, [
      'line one\r\nline two\r\nline three',
      'line one\nline two\nline three',
    ])
    await signIn(page, address)
    await openTable(page, scratch.name, 'notes')
  })

  const stored = async (
    scratch: { q: <T = Record<string, unknown>>(sql: string) => Promise<T[]>; name: string },
    id: number,
  ) =>
    (
      await scratch.q<{ h: string }>(
        `SELECT HEX(txt) AS h FROM \`${scratch.name}\`.notes WHERE id = ${id}`,
      )
    )[0]?.h

  test('appending to a CR LF text keeps every CR LF', async ({ page, scratch }) => {
    await gridRow(page, 'crlf').getByRole('button', { name: 'Edit row' }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByText('The line breaks of the stored text (CR LF) are kept.'),
    ).toBeVisible()
    const area = dialog.getByRole('textbox', { name: 'txt', exact: true })
    await area.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('!')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(async () => {
      expect(await stored(scratch, 1)).toBe(hex('line one\r\nline two\r\nline three!'))
    }).toPass({ timeout: 8000 })
  })

  test('editing one line in the middle of a CR LF text keeps the others', async ({
    page,
    scratch,
  }) => {
    await gridRow(page, 'crlf').getByRole('button', { name: 'Edit row' }).click()
    const dialog = page.getByRole('dialog')
    const area = dialog.getByRole('textbox', { name: 'txt', exact: true })
    await area.fill('line one\nline TWO\nline three')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(async () => {
      expect(await stored(scratch, 1)).toBe(hex('line one\r\nline TWO\r\nline three'))
    }).toPass({ timeout: 8000 })
  })

  test('a line added by the user in a CR LF text gets the text’s own terminator', async ({
    page,
    scratch,
  }) => {
    await gridRow(page, 'crlf').getByRole('button', { name: 'Edit row' }).click()
    const dialog = page.getByRole('dialog')
    const area = dialog.getByRole('textbox', { name: 'txt', exact: true })
    await area.fill('line one\nline two\nline three\nline four')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(async () => {
      expect(await stored(scratch, 1)).toBe(hex('line one\r\nline two\r\nline three\r\nline four'))
    }).toPass({ timeout: 8000 })
  })

  test('a plain LF text stays LF', async ({ page, scratch }) => {
    await page
      .getByRole('grid')
      .getByRole('row')
      .nth(2)
      .getByRole('button', { name: 'Edit row' })
      .click()
    const dialog = page.getByRole('dialog')
    const area = dialog.getByRole('textbox', { name: 'txt', exact: true })
    await area.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('!')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(async () => {
      expect(await stored(scratch, 2)).toBe(hex('line one\nline two\nline three!'))
    }).toPass({ timeout: 8000 })
  })

  test('saving a CR LF text without touching it sends nothing', async ({ page, scratch }) => {
    await gridRow(page, 'crlf').getByRole('button', { name: 'Edit row' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('renamed')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(async () => {
      const [row] = await scratch.q<{ name: string }>(
        `SELECT name FROM \`${scratch.name}\`.notes WHERE id = 1`,
      )
      expect(row?.name).toBe('renamed')
    }).toPass({ timeout: 8000 })
    expect(await stored(scratch, 1)).toBe(hex('line one\r\nline two\r\nline three'))
  })
})
