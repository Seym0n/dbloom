import { expect, type Locator, type Page } from '@playwright/test'
import { expandDatabase, sidebar, type Scratch } from './scratch-db'

/** `customer` of SPEC 24 (SCN-037..): id PK auto-increment, unique email, nullable note, trigger-free. */
export async function seedRowsCustomer(scratch: Scratch, rows = 3) {
  await scratch.q(
    `CREATE TABLE \`${scratch.name}\`.customer (
       id INT NOT NULL AUTO_INCREMENT,
       name VARCHAR(100) NOT NULL,
       email VARCHAR(100) NOT NULL,
       note TEXT NULL,
       created DATETIME(6) NULL,
       flag TINYINT(1) NOT NULL DEFAULT 0,
       PRIMARY KEY (id),
       UNIQUE KEY uq_email (email)
     )`,
  )
  if (rows > 0) {
    const values = Array.from({ length: rows }, (_, i) => [
      `customer ${i + 1}`,
      `c${i + 1}@example.test`,
    ])
    await scratch.q(`INSERT INTO \`${scratch.name}\`.customer (name, email) VALUES ?`, [values])
  }
}

/** Opens a table of the scratch database in a tab from the sidebar. */
export async function openTable(page: Page, db: string, table: string) {
  await expandDatabase(page, db)
  await sidebar(page).getByRole('button', { name: table, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(table)
  await expect(page.getByRole('grid')).toBeVisible()
}

/** The data row of the grid whose cells contain `text`. */
export const gridRow = (page: Page, text: string): Locator =>
  page.getByRole('grid').getByRole('row').filter({ hasText: text })
