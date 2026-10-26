import { expect, signIn, test } from './fixtures/scratch-db'
import { openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-049 of SPEC/24: counts, estimates, paging (sizes scaled down from the 2 000 000 row fixture). */

test.describe('SCN-049 paging and counts', () => {
  test('a table below one page shows its exact total at once', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 30)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    await expect(page.getByText('30 rows', { exact: false }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Count' })).toHaveCount(0)
  })

  test('a large table shows an estimate; Count gives the exact total and enables Last page', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.big (id INT NOT NULL PRIMARY KEY, v INT NOT NULL)`)
    await scratch.q(
      `INSERT INTO ${db}.big
         SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n + 10000 * e.n + 100000 * f.n + 1, 0
           FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
                 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
                (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
                 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
                (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
                 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c,
                (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
                 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) d,
                (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
                 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) e,
                (SELECT 0 n UNION SELECT 1) f`,
    )
    await scratch.q(`ANALYZE TABLE ${db}.big`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'big')

    await expect(page.getByText(/about [\d,.\s ]+ rows/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Last page' })).toBeDisabled()
    await expect(page.getByText('The last page needs an exact row count.')).toBeVisible()

    await page.getByRole('button', { name: 'Count' }).click()
    await expect(page.getByText(/200[,.\s ]?000 rows/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Last page' })).toBeEnabled()
    await expect(page.getByText(/page .*count /)).toBeVisible()

    await page.getByRole('button', { name: 'Last page' }).click()
    await expect(page.getByText(/Rows 199[,.\s ]?951/)).toBeVisible()
  })

  test('a table and a column with dots and backticks sort and page', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.\`a.b\` (id INT PRIMARY KEY, \`x\`\`\` INT)`)
    await scratch.q(
      `INSERT INTO ${db}.\`a.b\` VALUES ${Array.from({ length: 60 }, (_, i) => `(${i + 1}, ${(i * 7) % 60})`).join(',')}`,
    )
    await signIn(page, address)
    await openTable(page, scratch.name, 'a.b')
    await page.getByRole('button', { name: 'x`', exact: true }).click()
    await expect(page.getByRole('columnheader', { name: 'x`' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    await expect(page.locator('code')).toContainText('ORDER BY `x```')
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Rows 51–60')).toBeVisible()
  })
})
