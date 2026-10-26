import { expect, signIn, test } from './fixtures/scratch-db'
import { openTable } from './fixtures/rows-fixtures'

const dataRow = (page: import('@playwright/test').Page, n: number) =>
  page.getByRole('grid').getByRole('row').nth(n)

/** SCN-043 of SPEC/24: which key identifies a row, and what a keyless write costs. */

test.describe('SCN-043 row identity', () => {
  test('keyless table: hard confirmation with LIMIT 1 and the match count; one duplicate goes', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.nokey (a INT, b VARCHAR(10))`)
    await scratch.q(`INSERT INTO ${db}.nokey VALUES (1,'x'),(1,'x'),(2,'y')`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'nokey')

    await dataRow(page, 2).getByRole('button', { name: 'Delete row' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/LIMIT 1/).first()).toBeVisible()
    await expect(dialog.getByText(/\b2\b.*match|match.*\b2\b/i).first()).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: /Type nokey to confirm/ })).toBeVisible()
    expect(await scratch.q(`SELECT COUNT(*) AS n FROM ${db}.nokey`)).toEqual([{ n: 3 }])
    await dialog.getByRole('textbox', { name: /Type nokey to confirm/ }).fill('nokey')
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect(dialog).toBeHidden()
    expect(await scratch.q(`SELECT a, b FROM ${db}.nokey ORDER BY a`)).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ])
  })

  test('NOT NULL unique key is the identity: delete needs a plain confirmation, no typing', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.uq (code VARCHAR(10) NOT NULL, v INT, UNIQUE KEY (code))`)
    await scratch.q(`INSERT INTO ${db}.uq VALUES ('a',1),('b',2)`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'uq')
    await dataRow(page, 1).getByRole('button', { name: 'Delete row' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/DELETE FROM/).first()).toBeVisible()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect(dialog).toBeHidden()
    expect(await scratch.q(`SELECT code FROM ${db}.uq`)).toEqual([{ code: 'b' }])
  })

  test('nullable unique key falls back to all columns (hard)', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.nu (code VARCHAR(10) NULL, UNIQUE KEY (code))`)
    await scratch.q(`INSERT INTO ${db}.nu VALUES ('a'),(NULL)`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'nu')
    await dataRow(page, 1).getByRole('button', { name: 'Delete row' }).click()
    await expect(
      page.getByRole('dialog').getByRole('textbox', { name: /Type nu to confirm/ }),
    ).toBeVisible()
  })

  test('DOUBLE column and no key: write controls are off with the reason', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.fl (a INT, d DOUBLE)`)
    await scratch.q(`INSERT INTO ${db}.fl VALUES (1, 0.1)`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'fl')
    const row = page.getByRole('grid').getByRole('row').nth(1)
    for (const name of ['Edit row', 'Delete row']) {
      const button = row.getByRole('button', { name: new RegExp(`^${name}`) })
      await expect(button).toBeDisabled()
      await expect(button).toHaveAttribute('title', /SQL tab/)
    }
  })

  test('a view has no edit controls', async ({ page, scratch, address }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.base (id INT PRIMARY KEY, v INT)`)
    await scratch.q(`INSERT INTO ${db}.base VALUES (1, 1)`)
    await scratch.q(`CREATE VIEW ${db}.vw AS SELECT id, v FROM ${db}.base`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'vw')
    await expect(page.getByRole('button', { name: /^Insert — / })).toBeDisabled()
    await expect(
      page
        .getByRole('grid')
        .getByRole('row')
        .nth(1)
        .getByRole('button', { name: /^Edit row — / }),
    ).toBeDisabled()
  })
})
