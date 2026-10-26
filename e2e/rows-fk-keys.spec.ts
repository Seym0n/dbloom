import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/** SCN-045 steps 5 and the sign-in detour of SPEC/24: composite and binary keys, and a link followed signed out. */

test.describe('SCN-045 composite and binary keys', () => {
  test('a composite key link filters on every key column', async ({ page, scratch, address }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.region (country CHAR(2) NOT NULL, code CHAR(3) NOT NULL, label VARCHAR(40) NOT NULL,
         PRIMARY KEY (country, code))`,
    )
    await scratch.q(
      `CREATE TABLE ${db}.site (id INT PRIMARY KEY, country CHAR(2) NOT NULL, code CHAR(3) NOT NULL,
         CONSTRAINT fk_s FOREIGN KEY (country, code) REFERENCES ${db}.region (country, code))`,
    )
    await scratch.q(
      `INSERT INTO ${db}.region VALUES ('DE','BAY','Bavaria'),('DE','BER','Berlin'),('FR','BAY','Not Bavaria')`,
    )
    await scratch.q(`INSERT INTO ${db}.site VALUES (1,'DE','BAY'),(2,'FR','BAY')`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'site')

    const href = await gridRow(page, 'DE').getByRole('link').first().getAttribute('href')
    expect(href).toContain('table=region')
    const target = await page.context().newPage()
    await target.goto(href as string)
    const grid = target.getByRole('grid')
    // Only (DE, BAY): neither (DE, BER) nor (FR, BAY).
    await expect(grid.getByRole('row')).toHaveCount(2)
    await expect(grid.getByText('Bavaria', { exact: true })).toBeVisible()
    await expect(grid.getByText('Berlin')).toHaveCount(0)
    await expect(grid.getByText('Not Bavaria')).toHaveCount(0)
  })

  test('a BINARY(16) key link finds the referenced row by its bytes', async ({
    page,
    scratch,
    address,
  }) => {
    const db = `\`${scratch.name}\``
    await scratch.q(
      `CREATE TABLE ${db}.parent (uid BINARY(16) PRIMARY KEY, label VARCHAR(20) NOT NULL)`,
    )
    await scratch.q(
      `CREATE TABLE ${db}.child (id INT PRIMARY KEY, parent_uid BINARY(16) NOT NULL,
         CONSTRAINT fk_c FOREIGN KEY (parent_uid) REFERENCES ${db}.parent (uid))`,
    )
    await scratch.q(
      `INSERT INTO ${db}.parent VALUES (UNHEX('00112233445566778899AABBCCDDEEFF'), 'first'),
         (UNHEX('FFEEDDCCBBAA99887766554433221100'), 'second')`,
    )
    await scratch.q(`INSERT INTO ${db}.child VALUES (1, UNHEX('FFEEDDCCBBAA99887766554433221100'))`)
    await signIn(page, address)
    await openTable(page, scratch.name, 'child')

    const link = page.getByRole('grid').getByRole('row').nth(1).getByRole('link').first()
    const href = (await link.getAttribute('href')) as string
    expect(href).toContain('table=parent')
    const target = await page.context().newPage()
    await target.goto(href)
    const grid = target.getByRole('grid')
    await expect(grid.getByRole('row')).toHaveCount(2)
    await expect(grid.getByText('second', { exact: true })).toBeVisible()
    await expect(grid.getByText('first', { exact: true })).toHaveCount(0)
  })
})

test('SCN-045 a link followed while signed out opens the table after sign-in', async ({
  page,
  browser,
  scratch,
  address,
}) => {
  const db = `\`${scratch.name}\``
  await scratch.q(`CREATE TABLE ${db}.customer (id INT PRIMARY KEY, name VARCHAR(20))`)
  await scratch.q(
    `CREATE TABLE ${db}.orders (id INT PRIMARY KEY, customer_id INT NOT NULL,
       CONSTRAINT fk_o FOREIGN KEY (customer_id) REFERENCES ${db}.customer (id))`,
  )
  await scratch.q(`INSERT INTO ${db}.customer VALUES (1,'Ann'),(2,'Bob')`)
  await scratch.q(`INSERT INTO ${db}.orders VALUES (10, 2)`)
  await signIn(page, address)
  await openTable(page, scratch.name, 'orders')
  const href = (await page
    .getByRole('grid')
    .getByRole('row')
    .nth(1)
    .getByRole('link')
    .first()
    .getAttribute('href')) as string

  // A fresh browser context has no session cookie.
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const fresh = await context.newPage()
  await fresh.goto(href)
  await expect(fresh.getByRole('heading', { name: /Sign in/ })).toBeVisible()
  await fresh.getByLabel('Server').fill(address)
  await fresh.getByLabel('User name').fill('root')
  await fresh.getByLabel('Password').fill('root')
  await fresh.getByRole('button', { name: 'Sign in' }).click()
  await expect(fresh.getByRole('heading', { level: 1 })).toContainText('customer')
  const grid = fresh.getByRole('grid')
  await expect(grid.getByText('Bob', { exact: true })).toBeVisible()
  await expect(grid.getByText('Ann')).toHaveCount(0)
  await context.close()
})
