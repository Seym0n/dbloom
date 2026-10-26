import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/** SCN-045 step 4 of SPEC/24: relation modes `full`, `links` and `none` (FR-ROW-014, DATA-ISS-122). */

test('SCN-045 relation modes: names come from one lookup per page; links and none issue none', async ({
  page,
  scratch,
  address,
}) => {
  const db = `\`${scratch.name}\``
  await scratch.q(`CREATE TABLE ${db}.customer (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)`)
  await scratch.q(
    `CREATE TABLE ${db}.orders (id INT PRIMARY KEY, customer_id INT NOT NULL,
       CONSTRAINT fk_o FOREIGN KEY (customer_id) REFERENCES ${db}.customer (id))`,
  )
  const customers = Array.from({ length: 30 }, (_, i) => `(${i + 1}, 'Name ${i + 1}')`).join(',')
  await scratch.q(`INSERT INTO ${db}.customer VALUES ${customers}`)
  const orders = Array.from({ length: 30 }, (_, i) => `(${i + 1}, ${i + 1})`).join(',')
  await scratch.q(`INSERT INTO ${db}.orders VALUES ${orders}`)
  await signIn(page, address)
  await openTable(page, scratch.name, 'orders')

  const row = gridRow(page, '12')
  const keyCell = () => page.getByRole('grid').getByRole('row').nth(2).getByRole('gridcell').nth(1)

  // Default `links`: a link, no names.
  await expect(keyCell().getByRole('link')).toBeVisible()
  await expect(page.getByRole('grid').getByText('Name 1', { exact: true })).toHaveCount(0)
  void row

  const setMode = async (label: string) => {
    await page.getByRole('button', { name: 'Columns' }).click()
    await page
      .getByRole('dialog', { name: 'Columns' })
      .getByRole('combobox', { name: 'Foreign keys' })
      .selectOption({ label })
    await page.keyboard.press('Escape')
  }
  let posts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/_serverFn/')) posts++
  })

  // `full`: names of all 30 rows arrive; one lookup for the page, plus the saved preference.
  posts = 0
  await setMode('Links and names')
  await expect(page.getByRole('grid').getByText('Name 1', { exact: true })).toBeVisible()
  await expect(page.getByRole('grid').getByText('Name 30', { exact: true })).toBeVisible()
  await expect(keyCell().getByRole('link')).toBeVisible()
  expect(posts, 'one setPref and one lookup for 30 rows').toBe(2)

  // `none`: plain values, no link, no names, no lookup (only the preference is saved).
  posts = 0
  await setMode('Plain values')
  await expect(page.getByRole('grid').getByText('Name 1', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('grid').getByRole('link')).toHaveCount(0)
  expect(posts, 'only setPref').toBe(1)

  // Back to `links`: links, no names, no lookup.
  posts = 0
  await setMode('Links')
  await expect(keyCell().getByRole('link')).toBeVisible()
  await expect(page.getByRole('grid').getByText('Name 1', { exact: true })).toHaveCount(0)
  expect(posts, 'only setPref').toBe(1)

  // The mode is a preference: it survives closing and reopening the table.
  await setMode('Links and names')
  await expect(page.getByRole('grid').getByText('Name 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close orders' }).click()
  await openTable(page, scratch.name, 'orders')
  await expect(page.getByRole('grid').getByText('Name 1', { exact: true })).toBeVisible()
})
