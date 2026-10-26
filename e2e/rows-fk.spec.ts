import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/** SCN-045 of SPEC/24 (core): real foreign key links, filtered target, referencing rows. */

const CHILD = 'ü/ä&x'

test('SCN-045 FK cell links open the referenced row; referencing rows lists the group', async ({
  page,
  scratch,
  address,
}) => {
  const db = `\`${scratch.name}\``
  await scratch.q(
    `CREATE TABLE ${db}.customer (id INT PRIMARY KEY, name VARCHAR(40)) CHARACTER SET utf8mb4`,
  )
  await scratch.q(
    `CREATE TABLE ${db}.\`${CHILD}\` (id INT PRIMARY KEY, customer_id INT NOT NULL,
       CONSTRAINT fk_c FOREIGN KEY (customer_id) REFERENCES ${db}.customer (id)) CHARACTER SET utf8mb4`,
  )
  await scratch.q(`INSERT INTO ${db}.customer VALUES (1,'Ann'),(2,'Bob'),(3,'Cy')`)
  await scratch.q(`INSERT INTO ${db}.\`${CHILD}\` VALUES (10,2),(11,2),(12,3)`)
  await signIn(page, address)
  await openTable(page, scratch.name, CHILD)

  // The key cell is a real link: href, new tab, noopener.
  const link = gridRow(page, '10').getByRole('link').first()
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  const href = await link.getAttribute('href')
  expect(href).toContain(`db=${encodeURIComponent(scratch.name)}`)
  expect(href).toContain('table=customer')

  // Following it shows the referenced table filtered to that one row.
  const target = await page.context().newPage()
  await target.goto(href as string)
  await expect(target.getByRole('heading', { level: 1 })).toContainText('customer')
  const grid = target.getByRole('grid')
  await expect(grid.getByRole('row')).toHaveCount(2)
  await expect(grid.getByText('Bob')).toBeVisible()
  await expect(grid.getByText('Ann')).toHaveCount(0)
  await expect(target.getByLabel('Active filter')).toBeVisible()

  // Referencing rows of Bob: one group, a count of 2, a real link back to the odd table name.
  await gridRow(target, 'Bob').getByRole('button', { name: 'Referencing rows' }).click()
  const dialog = target.getByRole('dialog')
  const back = dialog.getByRole('link').first()
  await expect(back).toContainText(CHILD)
  await expect(dialog.getByText('2').first()).toBeVisible()
  const backHref = (await back.getAttribute('href')) as string
  expect(backHref).toContain(encodeURIComponent(CHILD))
  await expect(dialog.getByRole('button', { name: /Insert a row into/ })).toBeVisible()

  const child = await page.context().newPage()
  await child.goto(backHref)
  await expect(child.getByRole('grid').getByRole('row')).toHaveCount(3)
})
