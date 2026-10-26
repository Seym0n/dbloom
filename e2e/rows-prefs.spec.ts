import { expect, signIn, test } from './fixtures/scratch-db'
import { openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-051 of SPEC/24: column layout, display options and sort survive closing the tab. */

test('SCN-051 layout and sort persist per table; structure changes prune and append', async ({
  page,
  scratch,
  address,
}) => {
  const t = `\`${scratch.name}\`.customer`
  await seedRowsCustomer(scratch, 5)
  await signIn(page, address)
  await openTable(page, scratch.name, 'customer')

  await page.getByRole('button', { name: 'Columns' }).click()
  const menu = page.getByRole('dialog', { name: 'Columns' })
  await menu.getByRole('checkbox', { name: /^note / }).uncheck()
  await menu.getByRole('checkbox', { name: /^created / }).uncheck()
  await menu.getByRole('button', { name: 'Move flag left' }).click()
  await menu.getByRole('spinbutton', { name: 'Width of name in pixels' }).fill('240')
  await menu.getByRole('spinbutton', { name: 'Characters shown per cell' }).fill('40')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'name', exact: true }).click()
  await expect(page.getByRole('columnheader', { name: 'name' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )

  const headers = () => page.getByRole('grid').getByRole('columnheader').allInnerTexts()
  const shown = (await headers())
    .map((h) => h.trim())
    .filter((h) => /^(id|name|email|flag|note|created|extra)$/.test(h))
  expect(shown).toEqual(['id', 'name', 'email', 'flag'])

  // Close the tab and open the table again.
  await page.getByRole('button', { name: 'Close customer' }).click()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await openTable(page, scratch.name, 'customer')
  const again = (await headers())
    .map((h) => h.trim())
    .filter((h) => /^(id|name|email|flag|note|created|extra)$/.test(h))
  expect(again).toEqual(['id', 'name', 'email', 'flag'])
  await expect(page.getByRole('columnheader', { name: 'name' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await page.getByRole('button', { name: 'Columns' }).click()
  await expect(
    page
      .getByRole('dialog', { name: 'Columns' })
      .getByRole('spinbutton', { name: 'Width of name in pixels' }),
  ).toHaveValue('240')
  await expect(
    page
      .getByRole('dialog', { name: 'Columns' })
      .getByRole('spinbutton', { name: 'Characters shown per cell' }),
  ).toHaveValue('40')
  await page.keyboard.press('Escape')

  // Step 2: drop `email` and add `extra` behind the tab's back; the saved layout is pruned, `extra` is last and visible.
  await page.getByRole('button', { name: 'Close customer' }).click()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await scratch.q(`ALTER TABLE ${t} DROP COLUMN email, ADD COLUMN extra INT NULL`)
  await openTable(page, scratch.name, 'customer')
  await expect(page.locator('code').first()).not.toContainText('`email`')
  const after = (await headers())
    .map((h) => h.trim())
    .filter((h) => /^(id|name|email|flag|note|created|extra)$/.test(h))
  expect(after).toEqual(['id', 'name', 'flag', 'extra'])
})
