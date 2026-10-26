import { randomBytes } from 'node:crypto'
import { expect, randomName, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-050 of SPEC/24: what the grid offers follows the account's privileges. */

test.describe('SCN-050 privileges', () => {
  test('SELECT only: grid works, write controls are off with the reason', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    const { user, password } = await scratch.createLimitedUser()
    await signIn(page, address, user, password)
    await openTable(page, scratch.name, 'customer')
    await expect(gridRow(page, 'customer 1')).toBeVisible()
    const reason = 'Your account lacks the privilege for this.'
    await expect(page.getByRole('button', { name: /^Insert — / })).toHaveAttribute('title', reason)
    await expect(page.getByRole('button', { name: /^Insert — / })).toBeDisabled()
    const row = gridRow(page, 'customer 1')
    await expect(row.getByRole('button', { name: /^Edit row — / })).toBeDisabled()
    await expect(row.getByRole('button', { name: /^Delete row — / })).toBeDisabled()
  })

  test('UPDATE on one column only: that column edits, the others do not', async ({
    page,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    await seedRowsCustomer(scratch, 3)
    const user = randomName('e2e_lim_')
    const password = randomBytes(9).toString('hex')
    await scratch.q('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password])
    try {
      await scratch.q(`GRANT SELECT ON \`${scratch.name}\`.* TO ?@?`, [user, '%'])
      await scratch.q(`GRANT UPDATE (name) ON ${t} TO ?@?`, [user, '%'])
      await signIn(page, address, user, password)
      await openTable(page, scratch.name, 'customer')

      const row = gridRow(page, 'customer 1')
      await row.getByRole('gridcell').filter({ hasText: 'c1@example.test' }).dblclick()
      await page.keyboard.press('F2')
      await expect(page.getByRole('textbox', { name: /c1@example/ })).toHaveCount(0)

      await row.getByRole('gridcell').filter({ hasText: 'customer 1' }).dblclick()
      await page.getByRole('textbox').last().fill('by col user')
      await page.keyboard.press('Enter')
      await expect(gridRow(page, 'by col user')).toBeVisible()
      expect(await scratch.q(`SELECT name FROM ${t} WHERE id = 1`)).toEqual([
        { name: 'by col user' },
      ])
    } finally {
      await scratch.q('DROP USER IF EXISTS ?@?', [user, '%'])
    }
  })
})
