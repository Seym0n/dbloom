import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, sidebar, signIn, test } from './fixtures/scratch-db'
import { dropPrefWrites, openExport, openImport, pickFile, upload } from './fixtures/io-fixtures'
import { openTable, seedRowsCustomer } from './fixtures/rows-fixtures'

/** SCN-056 drop overlay and read-only import, plus axe and phone width of the io pages. */

type DropFile = { name: string; content: string }

async function dragOver(page: Page, files: DropFile[], drop: boolean) {
  const nav = sidebar(page)
  const dt = await page.evaluateHandle((list) => {
    const data = new DataTransfer()
    for (const f of list) data.items.add(new File([f.content], f.name, { type: 'text/plain' }))
    return data
  }, files)
  await nav.dispatchEvent('dragenter', { dataTransfer: dt })
  await nav.dispatchEvent('dragover', { dataTransfer: dt })
  if (drop) await nav.dispatchEvent('drop', { dataTransfer: dt })
  return dt
}

test.describe('drop files on the navigation panel', () => {
  test('overlay, two files, one cancelled, the other opens the import dialog', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await sidebar(page).getByRole('button', { name: scratch.name, exact: true }).click()
    // Hold the first upload so it can be cancelled; the other passes through.
    let held = false
    await page.route('**/api/io/upload*', async (route) => {
      if (route.request().url().includes('name=slow.sql') && !held) {
        held = true
        await new Promise((r) => setTimeout(r, 4000))
        return route.abort()
      }
      return route.continue()
    })
    const files = [
      { name: 'slow.sql', content: 'SELECT 1;\n' },
      { name: 'quick.sql', content: 'CREATE TABLE dropped (id INT);\n' },
    ]
    await dragOver(page, files, false)
    await expect(page.getByText('Drop files here')).toBeVisible()
    await sidebar(page).dispatchEvent('dragleave')
    await dragOver(page, files, true)
    await expect(page.getByText('Drop files here')).toBeHidden()

    const panel = page.getByRole('region', { name: /Uploading|Uploads/ })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('slow.sql')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel upload of slow.sql' }).click()
    await expect(panel.getByText('Cancelled. The file was removed.')).toBeVisible()
    // The completed file opens in the import dialog of the current database.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Import into')
    await expect(page.getByText('quick.sql (31 B)')).toBeVisible()
    await expect(page.getByText('1 statements', { exact: true })).toBeVisible()
  })

  test('other file types are rejected with the reason', async ({ page, scratch, address }) => {
    await signIn(page, address)
    await sidebar(page).getByRole('button', { name: scratch.name, exact: true }).click()
    await dragOver(page, [{ name: 'photo.png', content: 'x' }], true)
    await expect(
      page.getByText('Only .sql, .csv and .json files, also as .gz or .zip'),
    ).toBeVisible()
  })
})

test.describe('read-only session', () => {
  test.use({ baseURL: 'http://localhost:3101' })

  test('import entries stay, Start cannot run, a direct upload is refused', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await expect(page.getByText(/This connection is read-only/).first()).toBeVisible()
    await pickFile(page, upload('ro.sql', 'CREATE TABLE ro (id INT);\n'))
    // The server refuses the upload of a read-only session, so there is no analysis and no Start.
    await expect(page.getByRole('alert').filter({ hasText: /read-only/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import�', exact: true })).toHaveCount(0)
    expect(
      await scratch.q('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [
        scratch.name,
      ]),
    ).toEqual([])
  })
})

const axe = async (page: Page, include?: string) => {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  if (include) builder.include(include)
  const { violations } = await builder.analyze()
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  )
}

/** At phone width the navigation is a drawer behind the Databases button; returns a function that opens it. */
async function phoneSignIn(page: Page, address: string) {
  await page.goto('/')
  await page.getByLabel('Server').fill(address)
  await page.getByLabel('User name').fill('root')
  await page.getByLabel('Password').fill('root')
  await page.getByRole('button', { name: 'Sign in' }).click()
  const menu = page.getByRole('button', { name: 'Databases' }).first()
  await expect(menu).toBeVisible()
  return async () => {
    if (!(await sidebar(page).isVisible())) await menu.click()
    await expect(sidebar(page)).toBeVisible()
  }
}

test.describe('io pages: accessibility and phone width', () => {
  test.beforeEach(async ({ page }) => {
    await dropPrefWrites(page)
  })

  test('axe: export quick and custom, import choose, analysis, confirm dialog, mapping', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openExport(page, scratch.name)
    expect(await axe(page), 'export quick').toEqual([])
    await page.getByRole('button', { name: 'Custom', exact: true }).click()
    expect(await axe(page), 'export custom').toEqual([])
    await page.getByLabel('Format', { exact: true }).selectOption('csv')
    expect(await axe(page), 'export custom csv').toEqual([])

    await openImport(page, scratch.name, 'customer')
    expect(await axe(page), 'import choose').toEqual([])
    await pickFile(page, upload('a.csv', 'name,email\nx,x@example.test\n', 'text/csv'))
    await page.getByLabel('First row has column names').check()
    await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
    expect(await axe(page), 'import mapping').toEqual([])
    await page.getByRole('button', { name: 'Import…', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await axe(page, 'dialog, [role=dialog]'), 'confirm dialog').toEqual([])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    await openImport(page, scratch.name)
    await pickFile(page, upload('d.sql', 'DROP TABLE IF EXISTS gone;\n'))
    await expect(page.getByText('1 statements', { exact: true })).toBeVisible()
    expect(await axe(page), 'import sql analysis').toEqual([])
    await page.getByRole('button', { name: 'Import…', exact: true }).click()
    expect(await axe(page, 'dialog, [role=dialog]'), 'hard confirm dialog').toEqual([])
  })

  test('axe: rows toolbar with the Export button and the SQL result export button', async ({
    page,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    expect(await axe(page), 'rows toolbar').toEqual([])
  })

  test.describe('phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('export and import pages do not scroll sideways and keep their buttons reachable', async ({
      page,
      scratch,
      address,
    }) => {
      await seedRowsCustomer(scratch, 3)
      const open = await phoneSignIn(page, address)
      const noSideScroll = async (what: string) => {
        const wide = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        )
        expect(wide, `${what} scrolls sideways`).toBe(false)
      }
      await open()
      await openExport(page, scratch.name, 'customer')
      await noSideScroll('export quick')
      await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeInViewport()
      await page.getByRole('button', { name: 'Custom', exact: true }).click()
      await noSideScroll('export custom')

      await open()
      await openImport(page, scratch.name, 'customer')
      await pickFile(page, upload('a.csv', 'name,email\nx,x@example.test\n', 'text/csv'))
      await page.getByLabel('First row has column names').check()
      await expect(page.getByRole('region', { name: 'Map columns' })).toBeVisible()
      await noSideScroll('import mapping')
      await expect(page.getByRole('button', { name: 'Import…', exact: true })).toBeInViewport()
    })

    test('the table toolbar shows the Export button', async ({ page, scratch, address }) => {
      await seedRowsCustomer(scratch, 3)
      const open = await phoneSignIn(page, address)
      await open()
      await openTable(page, scratch.name, 'customer')
      await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible()
    })
  })
})
