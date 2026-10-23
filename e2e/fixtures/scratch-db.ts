import { randomBytes } from 'node:crypto'
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { createConnection, type Connection } from 'mysql2/promise'

export type Product = 'mysql' | 'mariadb'

/** Project option: which product a structure spec runs against (see playwright.config.ts). */
export type StructureOptions = { product: Product }

export const SERVERS: Record<Product, { host: string; port: number; label: string }> = {
  mysql: { host: '127.0.0.1', port: 33064, label: 'MySQL' },
  mariadb: { host: '127.0.0.1', port: 33061, label: 'MariaDB' },
}

const ROOT = { user: 'root', password: 'root' }
const DB_PREFIX = 'e2e_struct_'
const USER_PREFIX = 'e2e_lim_'

export const randomName = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`

const connect = (product: Product) =>
  createConnection({ host: SERVERS[product].host, port: SERVERS[product].port, ...ROOT })

/** Global setup: removes scratch databases and users that an aborted earlier run left behind. */
export default async function sweepLeftovers() {
  for (const product of ['mysql', 'mariadb'] as const) {
    let conn: Connection
    try {
      conn = await connect(product)
    } catch {
      console.warn(`${product} is not reachable; skipping the sweep of old scratch databases`)
      continue
    }
    const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [`${DB_PREFIX.replace(/_/g, '\\_')}%`])
    for (const row of dbs as Record<string, string>[]) {
      await conn.query(`DROP DATABASE IF EXISTS \`${Object.values(row)[0]}\``)
    }
    const [users] = await conn.query('SELECT User, Host FROM mysql.user WHERE User LIKE ?', [
      `${USER_PREFIX.replace(/_/g, '\\_')}%`,
    ])
    for (const u of users as { User: string; Host: string }[]) {
      await conn.query('DROP USER IF EXISTS ?@?', [u.User, u.Host])
    }
    await conn.end()
  }
}

export type Scratch = {
  /** Name of this test's own database (`e2e_struct_<random>`), created empty. */
  name: string
  /** Runs SQL on the target as root, outside DBLoom, to set up or to verify the real catalog. */
  q: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>
  /** Registers one more database for removal after the test. */
  trackDatabase: (name: string) => void
  /** Creates a user with SELECT on the scratch database only and removes it after the test. */
  createLimitedUser: () => Promise<{ user: string; password: string }>
  /** Opens another connection as root, for changes "from a second connection". */
  second: () => Promise<Connection>
}

type Fixtures = {
  scratch: Scratch
  /** Address typed into the sign-in form for this product. */
  address: string
}

export const test = base.extend<Fixtures & StructureOptions>({
  product: ['mysql', { option: true }],
  address: async ({ product }, use) => use(`${SERVERS[product].host}:${SERVERS[product].port}`),
  scratch: async ({ product }, use) => {
    const conn = await connect(product)
    const databases = [randomName(DB_PREFIX)]
    const users: string[] = []
    const others: Connection[] = []
    await conn.query(`CREATE DATABASE \`${databases[0]}\` CHARACTER SET utf8mb4`)
    const scratch: Scratch = {
      name: databases[0] as string,
      q: async (sql, params) => {
        const [rows] = await conn.query(sql, params)
        return rows as never
      },
      trackDatabase: (name) => void databases.push(name),
      createLimitedUser: async () => {
        const user = randomName(USER_PREFIX)
        const password = randomBytes(9).toString('hex')
        users.push(user)
        await conn.query('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password])
        await conn.query(`GRANT SELECT ON \`${databases[0]}\`.* TO ?@?`, [user, '%'])
        return { user, password }
      },
      second: async () => {
        const other = await connect(product)
        others.push(other)
        return other
      },
    }
    try {
      await use(scratch)
    } finally {
      for (const other of others) await other.end().catch(() => undefined)
      for (const db of databases) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``)
      for (const user of users) await conn.query('DROP USER IF EXISTS ?@?', [user, '%'])
      await conn.end()
    }
  },
})

export { expect }

// ---- Page helpers ---------------------------------------------------------------------------------

export async function signIn(page: Page, address: string, user = 'root', password = 'root') {
  await page.goto('/')
  await page.getByLabel('Server').fill(address)
  await page.getByLabel('User name').fill(user)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Databases' })).toBeVisible()
}

export const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Databases' })

/** Expands a database in the sidebar (idempotent). */
export async function expandDatabase(page: Page, db: string) {
  const row = sidebar(page).getByRole('button', { name: db, exact: true })
  await expect(row).toBeVisible()
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
}

/** Opens the "Actions for {table}" menu in the sidebar and picks an item. */
export async function tableAction(page: Page, table: string, item: string) {
  await sidebar(page)
    .getByRole('button', { name: `Actions for ${table}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function databaseAction(page: Page, db: string, item: string) {
  await sidebar(page)
    .getByRole('button', { name: `Actions for database ${db}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}

/** Opens the designer tab of an existing table from the sidebar. */
export async function openDesigner(page: Page, db: string, table: string) {
  await expandDatabase(page, db)
  await tableAction(page, table, 'Design table')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(table)
  await expect(page.getByRole('table')).toBeVisible()
}

/** Opens the designer of a new table in `db`. */
export async function openNewTable(page: Page, db: string) {
  await expandDatabase(page, db)
  await sidebar(page)
    .getByRole('button', { name: `New table in ${db}`, exact: true })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`New table in ${db}`)
}

/** Row `index` (0 based) of the column grid in the designer. */
export const columnRow = (page: Page, index: number): Locator =>
  page
    .getByRole('table')
    .getByRole('row')
    .nth(index + 1)

/** Row of the column grid that currently has this name. */
export const columnNamed = (page: Page, name: string): Locator =>
  page
    .getByRole('table')
    .getByRole('row')
    .filter({ has: page.getByRole('textbox', { name: `Name, column ${name}`, exact: true }) })

/** Fills a column row. Labels contain the column name, so every control is found by its prefix. */
export async function fillColumn(
  row: Locator,
  col: {
    name: string
    type?: string
    length?: number
    nullable?: boolean
    defaultKind?: 'none' | 'null' | 'literal' | 'currentTimestamp' | 'expression'
    defaultValue?: string
    comment?: string
  },
) {
  await row.getByRole('textbox', { name: /^Name, column/ }).fill(col.name)
  if (col.type) await row.getByRole('combobox', { name: /^Type, column/ }).selectOption(col.type)
  if (col.length !== undefined) {
    await row.getByRole('spinbutton', { name: /^Length, column/ }).fill(String(col.length))
  }
  if (col.nullable !== undefined) {
    await row.getByRole('checkbox', { name: /^Allow NULL, column/ }).setChecked(col.nullable)
  }
  if (col.defaultKind) {
    await row.getByRole('combobox', { name: /^Default, column/ }).selectOption(col.defaultKind)
  }
  if (col.defaultValue !== undefined) {
    await row.getByRole('textbox', { name: /^Default value, column/ }).fill(col.defaultValue)
  }
  if (col.comment !== undefined) {
    await row.getByRole('textbox', { name: /^Comment, column/ }).fill(col.comment)
  }
}

/** The small form dialogs of the sidebar (first dialog); the preview dialog opens above it (last). */
export const formDialog = (page: Page) => page.getByRole('dialog').first()
export const previewDialog = (page: Page) => page.getByRole('dialog').last()

/** The "Add column" button of the column grid (the index editor has one of the same name later on). */
export const addColumn = (page: Page) => page.getByRole('button', { name: 'Add column' }).first()

/** Counts the server-function POSTs a page sends, to prove that a click sent nothing. */
export function countServerCalls(page: Page) {
  let count = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/_serverFn/')) count++
  })
  return () => count
}

/** The `customer` table of SCN-013 to SCN-019: id, name, created_at (+ email) and `rows` rows. */
export async function seedCustomer(
  scratch: Scratch,
  options: { rows?: number; email?: boolean; nameIndex?: boolean } = {},
) {
  const { rows = 0, email = false, nameIndex = false } = options
  await scratch.q(
    `CREATE TABLE \`${scratch.name}\`.customer (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       name VARCHAR(100) NOT NULL,
       ${email ? "email VARCHAR(255) NULL COMMENT 'login mail'," : ''}
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id)
       ${nameIndex ? ', KEY idx_name (name(20))' : ''}
     )`,
  )
  if (rows > 0) {
    const values = Array.from({ length: rows }, (_, i) => [`customer ${i + 1}`])
    await scratch.q(`INSERT INTO \`${scratch.name}\`.customer (name) VALUES ?`, [values])
  }
}

/** Column names of a table in position order, read from the real catalog. */
export async function columnNames(scratch: Scratch, table: string) {
  const rows = await scratch.q<{ n: string }>(
    `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [scratch.name, table],
  )
  return rows.map((r) => r.n)
}

/** Table names of the scratch database, read from the real catalog. */
export async function tableNames(scratch: Scratch) {
  const rows = await scratch.q<{ n: string }>(
    'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1',
    [scratch.name],
  )
  return rows.map((r) => r.n)
}
