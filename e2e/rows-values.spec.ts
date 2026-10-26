import { expect, signIn, test, type Product } from './fixtures/scratch-db'
import { openTable } from './fixtures/rows-fixtures'
import { capture, forge } from './fixtures/sql-fixtures'
import type { Page } from '@playwright/test'

/**
 * SCN-047 (download handle, hostile BLOB bytes) and SCN-048 (geometry, odd characters, hostile text, JSON view)
 * of SPEC/24, plus NUL bytes in binary values. Complements rows-blob-json.spec.ts.
 */

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex')
const FAKE_PNG = Buffer.concat([PNG_MAGIC, Buffer.from('this is not a real png body')])
const NOT_IMAGE = Buffer.from('plain bytes, not an image\u0000\u0001\u0002', 'utf8')
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=1"><script>window.__pwned=1</script></svg>',
)
const HTML = Buffer.from('<html><body onload="window.__pwned=1"><script>window.__pwned=1</script>')
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
)

const firstRow = (page: Page) => page.getByRole('grid').getByRole('row').nth(1)
const pwned = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)

/** Opens the cell dialog of column number `index` (0 based) of the first row with Shift+Enter. */
async function openCellDialog(page: Page, index: number) {
  const cell = firstRow(page).getByRole('gridcell').nth(index)
  await cell.click()
  await page.keyboard.press('Shift+Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

async function openEditForm(page: Page) {
  await firstRow(page).getByRole('button', { name: 'Edit row' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** Finds the first string property called `key` anywhere in a serialised server-function response. */
function findString(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const n = node as { p?: { k: string[]; v: unknown[] }; a?: unknown[]; s?: unknown }
  const at = n.p?.k.indexOf(key) ?? -1
  if (n.p && at >= 0) {
    const v = n.p.v[at] as { s?: unknown } | undefined
    if (typeof v?.s === 'string') return v.s
  }
  for (const child of [...(n.p?.v ?? []), ...(n.a ?? [])]) {
    const found = findString(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Mints a fresh one-time cell handle without touching the browser's own download: the real `openCell` call is
 * captured once (the click that downloads uses up its own handle), then replayed through the page's request
 * context, which carries the session cookie.
 */
async function mintHandle(page: Page, click: () => Promise<void>) {
  const seen = capture(page, ['disposition', 'column'])
  await click()
  await expect.poll(() => seen.length).toBeGreaterThan(0)
  const real = seen.at(-1)!
  return async () => {
    const response = await forge(page, real, real.body)
    const id = findString(JSON.parse(await response.text()), 'id')
    if (!id) throw new Error('openCell answered without a handle id')
    return `/api/rows/cell/${id}`
  }
}

test.describe('SCN-047 download handle and hostile bytes', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.blobs (id INT PRIMARY KEY, img LONGBLOB NULL)`)
    await scratch.q(`INSERT INTO ${db}.blobs VALUES (1, ?)`, [FAKE_PNG])
    await signIn(page, address)
    await openTable(page, scratch.name, 'blobs')
    await openEditForm(page)
    await expect(page.getByRole('button', { name: 'Download img' })).toBeVisible()
  })

  test('the handle works once, with attachment headers; a second fetch fails', async ({ page }) => {
    const mint = await mintHandle(page, () =>
      page.getByRole('button', { name: 'Download img' }).click(),
    )
    const url = await mint()
    const first = await page.request.get(url)
    expect(first.status()).toBe(200)
    expect(first.headers()['content-disposition']).toMatch(/^attachment/)
    expect(first.headers()['x-content-type-options']).toBe('nosniff')
    expect(first.headers()['content-type']).toBe('application/octet-stream')
    expect(Buffer.from(await first.body()).equals(FAKE_PNG)).toBe(true)

    // Same session, same handle, second use: refused.
    const again = await page.request.get(url)
    expect(again.status()).toBe(404)
  })

  test('the handle is bound to the session that created it', async ({ page, browser, address }) => {
    const mint = await mintHandle(page, () =>
      page.getByRole('button', { name: 'Download img' }).click(),
    )
    const url = await mint()
    const base = page.url().split('/').slice(0, 3).join('/')

    const other = await browser.newContext({ baseURL: base })
    try {
      const otherPage = await other.newPage()
      await otherPage.goto('/')
      await signIn(otherPage, address)
      const stolen = await other.request.get(url)
      expect(stolen.status()).toBe(404)
    } finally {
      await other.close()
    }

    // A signed-out client has no handle either.
    const anonymous = await browser.newContext({ baseURL: base })
    try {
      const response = await anonymous.request.get(url)
      expect(response.status()).toBe(404)
    } finally {
      await anonymous.close()
    }

    // The owner can still use it: the failed attempts did not consume it.
    const owner = await page.request.get(url)
    expect(owner.status()).toBe(200)
  })

  test('bytes that are not an image give a placeholder in that place only', async ({
    page,
    scratch,
  }) => {
    const t = `\`${scratch.name}\`.blobs`
    await scratch.q(`UPDATE ${t} SET img = ?`, [NOT_IMAGE])
    await page.reload()
    await openTable(page, scratch.name, 'blobs')
    const dialog = await openEditForm(page)
    await dialog.getByRole('button', { name: 'Preview img' }).click()
    await expect(dialog.getByText(/No preview is available/)).toBeVisible()
    await expect(dialog.locator('img')).toHaveCount(0)
    await expect(page.getByRole('grid')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Download img' })).toBeVisible()
  })

  test('a PNG signature with a broken body shows the "not a valid image" placeholder', async ({
    page,
  }) => {
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Preview img' }).click()
    await expect(dialog.getByText('This value is not a valid image.')).toBeVisible()
    await expect(page.getByRole('grid')).toBeVisible()
  })

  for (const [label, bytes] of [
    ['SVG', SVG],
    ['HTML', HTML],
  ] as const) {
    test(`${label} bytes are never rendered inline and never run`, async ({ page, scratch }) => {
      const t = `\`${scratch.name}\`.blobs`
      await scratch.q(`UPDATE ${t} SET img = ?`, [bytes])
      await page.reload()
      await openTable(page, scratch.name, 'blobs')
      const dialog = await openEditForm(page)
      await dialog.getByRole('button', { name: 'Preview img' }).click()
      await expect(dialog.getByText(/No preview is available/)).toBeVisible()
      await expect(dialog.locator('img, iframe, object, embed, svg[onload]')).toHaveCount(0)
      expect(await pwned(page)).toBeUndefined()

      expect(await pwned(page)).toBeUndefined()
    })
  }

  test('a PDF opens in a new tab served with a sandbox policy', async ({ page, scratch }) => {
    const t = `\`${scratch.name}\`.blobs`
    await scratch.q(`UPDATE ${t} SET img = ?`, [PDF])
    await page.reload()
    await openTable(page, scratch.name, 'blobs')
    const dialog = await openEditForm(page)
    // The click opens a popup (using up its own handle); a second handle is minted from the same call.
    const mint = await mintHandle(page, async () => {
      const popup = page.waitForEvent('popup')
      await dialog.getByRole('button', { name: 'Preview img' }).click()
      await popup
    })
    const response = await page.request.get(await mint())
    expect(response.status()).toBe(200)
    const headers = response.headers()
    expect(headers['content-security-policy']).toBe('sandbox')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-type']).toBe('application/pdf')
  })
})

const GEOMETRY_ENV: Record<Product, { column: string; insert: string; label: RegExp }> = {
  mysql: {
    column: 'g POINT SRID 4326 NULL',
    insert: 'ST_GeomFromText(?, 4326)',
    label: /WKT, SRID 4326/,
  },
  mariadb: { column: 'g POINT NULL', insert: 'ST_GeomFromText(?)', label: /WKT/ },
}

test.describe('SCN-048 geometry', () => {
  test('WKT and SRID are shown in the cell dialog and the form; an edited WKT round-trips', async ({
    page,
    scratch,
    address,
    product,
  }) => {
    const env = GEOMETRY_ENV[product]
    const t = `\`${scratch.name}\`.places`
    await scratch.q(`CREATE TABLE ${t} (id INT PRIMARY KEY, ${env.column})`)
    await scratch.q(`INSERT INTO ${t} VALUES (1, ${env.insert})`, ['POINT(1 2)'])
    const [before] = await scratch.q<{ w: string }>(`SELECT ST_AsText(g) AS w FROM ${t}`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'places')

    const cellDialog = await openCellDialog(page, 1)
    await expect(cellDialog.getByText(env.label).first()).toBeVisible()
    await expect(cellDialog.getByText('map view not available in this version')).toBeVisible()
    await expect(cellDialog).toContainText(/POINT\s*\(/i)
    await cellDialog.getByRole('button', { name: 'Close' }).first().click()
    await expect(cellDialog).toBeHidden()

    const form = await openEditForm(page)
    await expect(form.getByText(env.label).first()).toBeVisible()
    await expect(form.getByText('map view not available in this version')).toBeVisible()
    const wkt = form.getByRole('textbox', { name: 'g', exact: true })
    await expect(wkt).toHaveValue(/POINT\s*\(/i)
    // Same axis order as the server reports it, before editing.
    await expect(wkt).toHaveValue(before?.w ?? '')
    await wkt.fill('POINT(3 4)')
    await form.getByRole('button', { name: 'Save' }).last().click()

    await expect(async () => {
      const [row] = await scratch.q<{ w: string; s: number }>(
        `SELECT ST_AsText(g) AS w, ST_SRID(g) AS s FROM ${t}`,
      )
      expect(row?.w).toBe('POINT(3 4)')
      expect(row?.s).toBe(product === 'mysql' ? 4326 : 0)
    }).toPass({ timeout: 8000 })
  })
})

// Emoji (4 bytes), CR LF, tab, no-break space, zero-width space, run of spaces.
const ODD = 'a😀b\r\nc\td e​f    g'

test.describe('SCN-048 odd characters and hostile values', () => {
  test.beforeEach(async ({ scratch }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.odd (id INT PRIMARY KEY, txt TEXT NULL, label VARCHAR(40) NULL) CHARACTER SET utf8mb4`,
    )
  })

  test('markers are visible in the cell dialog and the stored bytes survive an edit of another column', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.odd`
    await scratch.q(`INSERT INTO ${t} VALUES (1, ?, 'x')`, [ODD])
    const [stored] = await scratch.q<{ h: string }>(`SELECT HEX(txt) AS h FROM ${t}`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'odd')

    const dialog = await openCellDialog(page, 1)
    for (const name of [
      'carriage return',
      'line feed',
      'tab',
      'no-break space',
      'zero-width character',
    ]) {
      await expect(dialog.getByRole('img', { name }).first()).toBeVisible()
    }
    const text = dialog.locator('pre').first()
    await expect(text).toContainText('😀')
    // Runs of spaces are kept as typed.
    await expect(text).toContainText('f    g')
    await dialog.getByRole('button', { name: 'Close' }).first().click()
    await expect(dialog).toBeHidden()

    // Opening and closing changed nothing.
    expect(await scratch.q(`SELECT HEX(txt) AS h FROM ${t}`)).toEqual([{ h: stored?.h }])

    const form = await openEditForm(page)
    await form.getByRole('textbox', { name: 'label', exact: true }).fill('changed')
    await form.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ h: string; label: string }>(
        `SELECT HEX(txt) AS h, label FROM ${t}`,
      )
      expect(row?.label).toBe('changed')
      expect(row?.h).toBe(stored?.h)
    }).toPass({ timeout: 8000 })
  })

  test('an edit of a value with emoji, tab, no-break and zero-width characters keeps them', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.odd`
    const value = 'a😀b\tc d​e  f'
    await scratch.q(`INSERT INTO ${t} VALUES (1, ?, 'x')`, [value])
    await signIn(page, address)
    await openTable(page, scratch.name, 'odd')
    const form = await openEditForm(page)
    const txt = form.getByRole('textbox', { name: 'txt', exact: true })
    await expect(txt).toHaveValue(value)
    await txt.fill(`${value}Z`)
    await form.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ h: string }>(`SELECT HEX(txt) AS h FROM ${t}`)
      expect(row?.h).toBe(Buffer.from(`${value}Z`, 'utf8').toString('hex').toUpperCase())
    }).toPass({ timeout: 8000 })
  })

  test('hostile text renders as text in the grid and in the cell dialog', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.odd`
    const hostile = '<img src=x onerror="window.__pwned=1">'
    await scratch.q(`INSERT INTO ${t} VALUES (1, ?, ?)`, [hostile, hostile])
    await signIn(page, address)
    await openTable(page, scratch.name, 'odd')
    await expect(firstRow(page)).toContainText(hostile)
    await expect(page.locator('img[src="x"]')).toHaveCount(0)

    const dialog = await openCellDialog(page, 1)
    await expect(dialog.locator('pre').first()).toContainText(hostile)
    await expect(page.locator('img[src="x"]')).toHaveCount(0)
    // Give an onerror handler time to fire if the markup had been parsed.
    await page.waitForTimeout(300)
    expect(await pwned(page)).toBeUndefined()
  })
})

test.describe('SCN-048 JSON view', () => {
  test('the cell dialog shows a pretty-printed JSON document', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.docs`
    await scratch.q(`CREATE TABLE ${t} (id INT PRIMARY KEY, meta JSON NULL)`)
    await scratch.q(`INSERT INTO ${t} VALUES (1, '{"a":1,"b":[1,2,{"c":"d"}]}')`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'docs')
    const dialog = await openCellDialog(page, 1)
    const pre = dialog.locator('pre').first()
    // Pretty printing: two-space indent per level, one member per line (read the raw text, not the
    // whitespace-normalised text of the matcher).
    await expect(pre).toContainText('"c"')
    const text = (await pre.evaluate((e) => e.textContent)) ?? ''
    expect(text).toMatch(/\n {2}"a": 1,/)
    expect(text).toMatch(/\n {6}"c": "d"/)
    await expect(dialog.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('NUL bytes in binary values', () => {
  test('a NUL inside VARBINARY survives an edit; an untouched field is not rewritten', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.bin`
    await scratch.q(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, b VARBINARY(16) NULL, k BLOB NULL, note VARCHAR(20) NULL)`,
    )
    const b = Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x43])
    const k = Buffer.from([0x00, 0xff, 0x00, 0x10])
    await scratch.q(`INSERT INTO ${t} VALUES (1, ?, ?, 'n')`, [b, k])
    await signIn(page, address)
    await openTable(page, scratch.name, 'bin')

    const form = await openEditForm(page)
    await form.getByRole('textbox', { name: 'note', exact: true }).fill('changed')
    await form.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ b: string; k: string; note: string }>(
        `SELECT HEX(b) AS b, HEX(k) AS k, note FROM ${t}`,
      )
      expect(row?.note).toBe('changed')
      expect(row?.b).toBe('410042000043')
      expect(row?.k).toBe('00FF0010')
    }).toPass({ timeout: 8000 })

    // Editing the binary value itself with NUL bytes in the hex field.
    const again = await openEditForm(page)
    await again.getByPlaceholder('0x…').fill('0x00ff00')
    await again.getByRole('button', { name: 'Save' }).last().click()
    await expect(async () => {
      const [row] = await scratch.q<{ b: string; k: string }>(
        `SELECT HEX(b) AS b, HEX(k) AS k FROM ${t}`,
      )
      expect(row?.b).toBe('00FF00')
      expect(row?.k).toBe('00FF0010')
    }).toPass({ timeout: 8000 })
  })
})
