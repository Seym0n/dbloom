import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/** SCN-047 and SCN-048 of SPEC/24: BLOB download, preview, upload; JSON and odd characters. */

// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('SCN-047 BLOB', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.blobs (id INT PRIMARY KEY, img LONGBLOB NULL)`)
    await scratch.q(`INSERT INTO ${db}.blobs VALUES (1, ?)`, [PNG])
    await signIn(page, address)
    await openTable(page, scratch.name, 'blobs')
    await gridRow(page, '0x').getByRole('button', { name: 'Edit row' }).click()
    await expect(page.getByRole('button', { name: 'Download img' })).toBeVisible()
  })

  test('download returns the stored bytes as an attachment', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download img' }).click(),
    ])
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).equals(PNG)).toBe(true)
    expect(download.suggestedFilename()).toMatch(/blobs.*img/)
  })

  test('a PNG previews as an image', async ({ page }) => {
    await page.getByRole('button', { name: 'Preview img' }).click()
    await expect(page.getByRole('dialog').last().locator('img').first()).toBeVisible()
  })

  test('upload replaces the value; a file over the cap is refused', async ({ page, scratch }) => {
    const t = `\`${scratch.name}\`.blobs`
    const dialog = page.getByRole('dialog')
    const input = dialog.locator('input[type=file]')
    await input.setInputFiles({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(9 * 1024 * 1024, 1),
    })
    await expect(dialog.getByText(/8 MiB|too large|exceeds/i).first()).toBeVisible()
    expect(await scratch.q(`SELECT LENGTH(img) AS n FROM ${t}`)).toEqual([{ n: PNG.length }])

    const small = Buffer.from('00ff0a42', 'hex')
    await input.setInputFiles({
      name: 'small.bin',
      mimeType: 'application/octet-stream',
      buffer: small,
    })
    await expect(dialog.getByText('small.bin')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ h: string }>(`SELECT HEX(img) AS h FROM ${t}`)
      expect(row?.h).toBe('00FF0A42')
    }).toPass({ timeout: 8000 })
  })
})

test.describe('SCN-048 JSON and odd characters', () => {
  test('invalid JSON is refused before any statement; valid JSON and emoji round-trip', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.docs (id INT PRIMARY KEY, meta JSON NULL, txt VARCHAR(100) NULL) CHARACTER SET utf8mb4`,
    )
    await scratch.q(`INSERT INTO ${db}.docs VALUES (1, '{"a": 1}', 'x')`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'docs')
    await page
      .getByRole('grid')
      .getByRole('row')
      .nth(1)
      .getByRole('button', { name: 'Edit row' })
      .click()
    const dialog = page.getByRole('dialog')
    const meta = dialog.getByRole('textbox', { name: 'meta', exact: true })

    await meta.fill('{"a": ')
    await expect(dialog.getByText(/Invalid at line/)).toBeVisible()
    let posts = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/_serverFn/')) posts++
    })
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(dialog.getByText(/Invalid JSON at line/).first()).toBeVisible()
    expect(posts).toBe(0)

    await meta.fill('{"b":[1,2,{"c":"d"}]}')
    await dialog.getByRole('button', { name: 'Format' }).click()
    await expect(meta).toHaveValue(/\n/)
    await dialog.getByRole('textbox', { name: 'txt', exact: true }).fill('héllo 😀 "q" \'q\' \ ✓')
    await dialog.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ meta: unknown; txt: string }>(
        `SELECT meta, txt FROM ${db}.docs`,
      )
      expect(typeof row?.meta === 'string' ? JSON.parse(row.meta) : row?.meta).toEqual({
        b: [1, 2, { c: 'd' }],
      })
      expect(row?.txt).toBe('héllo 😀 "q" \'q\' \ ✓')
    }).toPass({ timeout: 8000 })
  })
})
