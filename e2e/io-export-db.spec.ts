import { unzipSync } from 'fflate'
import type { Page } from '@playwright/test'
import { expect, signIn, test, type Scratch } from './fixtures/scratch-db'
import {
  customMode,
  dropPrefWrites,
  openExport,
  runExport,
  seedIoDatabase,
} from './fixtures/io-fixtures'

/** SCN-053 (custom database export as zip, templates) and SCN-055 (failure, skip) of SPEC/25. */

const exportButton = (page: Page) => page.getByRole('button', { name: 'Export', exact: true })

/** Puts the remembered export settings of the database scope back to the built-in defaults. */
async function restoreDefaults(page: Page, scratch: Scratch) {
  await page.reload()
  await openExport(page, scratch.name)
  await customMode(page)
  await page.getByLabel('Format', { exact: true }).selectOption('sql')
  await page.getByLabel('Compression').selectOption('none')
  await page.getByLabel('File name', { exact: true }).fill('@DATABASE@')
  await page.getByRole('button', { name: 'Quick', exact: true }).click()
  await runExport(page)
}

test.describe('SCN-053 custom export of a database as zip with separate files', () => {
  test('csv zip, one entry per table, view data, large table skipped, template remembered', async ({
    page,
    scratch,
    address,
  }) => {
    await seedIoDatabase(scratch)
    await signIn(page, address)
    await openExport(page, scratch.name)
    try {
      await customMode(page)
      // The scope list has the three tables, the view and the heavy table.
      for (const name of ['alpha', 'beta', 'alpha_view view', 'heavy']) {
        await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked()
      }
      await page.getByLabel('Format', { exact: true }).selectOption('csv')
      await expect(page.getByLabel('Compression')).toBeDisabled()
      await expect(page.getByLabel('Compression')).toHaveValue('zip')
      await page.getByLabel('One file per table').check()
      await page.getByLabel('Skip tables larger than').fill('1')
      await page.getByLabel('File name', { exact: true }).fill('@DATABASE@_@TABLE@')

      const out = await runExport(page)
      expect(out.headers['content-type']).toContain('application/zip')
      expect(out.name).toMatch(/\.zip$/)
      const entries = unzipSync(new Uint8Array(out.body))
      const names = Object.keys(entries).sort()
      expect(names).toEqual(
        [
          `${scratch.name}_alpha.csv`,
          `${scratch.name}_alpha_view.csv`,
          `${scratch.name}_beta.csv`,
        ].sort(),
      )
      const alpha = Buffer.from(entries[`${scratch.name}_alpha.csv`] as Uint8Array).toString('utf8')
      expect(alpha.split('\n')[0]).toContain('id,label')
      const view = Buffer.from(entries[`${scratch.name}_alpha_view.csv`] as Uint8Array).toString(
        'utf8',
      )
      expect(view).toContain('one')
      expect(view).not.toContain('3,')
      // The skipped table is listed in the result.
      await expect(page.getByText('heavy').first()).toBeVisible()
      await expect(
        page.getByRole('heading', { name: /Finished, some objects were skipped/ }),
      ).toBeVisible()

      // The file name template is remembered per scope and offered next time.
      await page.reload()
      await openExport(page, scratch.name)
      await customMode(page)
      await expect(page.getByLabel('File name', { exact: true })).toHaveValue('@DATABASE@_@TABLE@')
    } finally {
      await restoreDefaults(page, scratch)
    }
  })

  test('a hostile template yields a harmless name', async ({ page, scratch, address }) => {
    await dropPrefWrites(page)
    await seedIoDatabase(scratch)
    await signIn(page, address)
    await openExport(page, scratch.name, 'alpha')
    await customMode(page)
    await page.getByLabel('File name', { exact: true }).fill('../ev"il/@TABLE@ ü')
    const out = await runExport(page)
    expect(out.name).toMatch(/^[\p{L}\p{N}_.-]+\.sql$/u)
    expect(out.name).not.toContain('..')
    expect(out.headers['content-disposition']).toMatch(/filename\*=UTF-8''/)
  })

  test('named templates can be saved, loaded and deleted', async ({ page, scratch, address }) => {
    await dropPrefWrites(page)
    await seedIoDatabase(scratch)
    await signIn(page, address)
    await openExport(page, scratch.name, 'alpha')
    await customMode(page)
    await page.getByLabel('Format', { exact: true }).selectOption('json')
    await page.getByLabel('Indent the output').uncheck()
    await page.getByLabel('Save current options as').fill('e2e-compact')
    await page.getByRole('button', { name: 'Save template' }).click()
    const saved = page.getByLabel('Saved templates').locator('option', { hasText: 'e2e-compact' })
    await expect(saved).toHaveCount(1)
    try {
      await page.getByLabel('Indent the output').check()
      await page.getByLabel('Saved templates').selectOption('e2e-compact')
      await page.getByRole('button', { name: 'Load', exact: true }).click()
      await expect(page.getByLabel('Indent the output')).not.toBeChecked()
    } finally {
      await page.getByLabel('Saved templates').selectOption('e2e-compact')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(saved).toHaveCount(0)
    }
  })

  test('an invalid format sent directly is refused with a clear error', async ({
    page,
    scratch,
    address,
  }) => {
    await dropPrefWrites(page)
    await seedIoDatabase(scratch)
    await signIn(page, address)
    await openExport(page, scratch.name, 'alpha')
    let seen = ''
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('fileNameTemplate') && body.includes('"sql"')) {
        seen = body
        return route.continue({ postData: body.replace('"sql"', '"xml"') })
      }
      return route.continue()
    })
    await exportButton(page).click()
    await expect(page.getByRole('alert')).toBeVisible()
    expect(seen).not.toBe('')
    await expect(page.getByRole('link', { name: 'Download again' })).toHaveCount(0)
  })
})

test.describe('SCN-055 failure of an export', () => {
  test('an unreadable table fails the export; skipping lists it', async ({
    page,
    scratch,
    address,
  }) => {
    await dropPrefWrites(page)
    const db = `\`${scratch.name}\``
    await scratch.q(`CREATE TABLE ${db}.readable (id INT PRIMARY KEY)`)
    await scratch.q(`INSERT INTO ${db}.readable VALUES (1),(2)`)
    await scratch.q(`CREATE TABLE ${db}.secret (id INT PRIMARY KEY)`)
    const { user, password } = await scratch.createLimitedUser()
    await scratch.q(`REVOKE SELECT ON ${db}.* FROM ?@?`, [user, '%'])
    await scratch.q(`GRANT SELECT ON ${db}.readable TO ?@?`, [user, '%'])
    await scratch.q(`GRANT INSERT ON ${db}.secret TO ?@?`, [user, '%'])
    await signIn(page, address, user, password)
    await openExport(page, scratch.name)
    await customMode(page)

    // Default: stops at the table it cannot read, no file is offered.
    let downloaded = false
    page.on('download', () => (downloaded = true))
    await exportButton(page).click()
    await expect(page.getByRole('heading', { name: 'Failed' }).first()).toBeVisible()
    await expect(page.getByText('secret').first()).toBeVisible()
    await expect(page.getByText(/SELECT command denied|1142/).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Download again' })).toHaveCount(0)
    expect(downloaded).toBe(false)

    // With "skip objects that cannot be read": a file with the skip comment and the skip listed.
    await page.getByRole('button', { name: 'Back to options' }).click()
    await page.getByLabel('Skip objects that cannot be read').check()
    const out = await runExport(page)
    const sql = out.body.toString('utf8')
    expect(sql).toContain(`-- skipped: ${scratch.name}.secret`)
    expect(sql).toContain('INSERT INTO `readable`')
    expect(sql).not.toContain('INSERT INTO `secret`')
    await expect(page.getByRole('heading', { name: /some objects were skipped/ })).toBeVisible()
    await expect(page.getByText('Skipped objects (1)')).toBeVisible()
  })
})
