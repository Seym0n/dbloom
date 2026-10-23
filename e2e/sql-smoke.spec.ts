import { expandDatabase, expect, sidebar, signIn, test } from './fixtures/scratch-db'

// Smoke test of the SQL tab wiring (the full SQL scenarios come with their own specs).
test.describe('SQL tab smoke', () => {
  test('run, confirm a DROP, cancel a long statement, refresh the sidebar', async ({
    page,
    scratch,
    address,
  }) => {
    await scratch.q(`CREATE TABLE \`${scratch.name}\`.scratch_t (id INT PRIMARY KEY)`)
    await signIn(page, address)
    await expandDatabase(page, scratch.name)
    await sidebar(page)
      .getByRole('button', { name: `New SQL tab on ${scratch.name}` })
      .click()
    const editor = page.getByRole('textbox', { name: 'SQL editor' })
    await expect(editor).toBeVisible()

    // 1. a plain read
    await editor.click()
    await editor.fill('SELECT 1 AS one')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const results = page.getByRole('region', { name: 'Results', exact: true })
    await expect(results.getByRole('gridcell', { name: '1', exact: true })).toBeVisible()

    await expect(
      sidebar(page).getByRole('button', { name: 'scratch_t', exact: true }),
    ).toBeVisible()

    // 2. DROP TABLE asks first and runs nothing until confirmed
    await editor.click()
    await editor.fill(`DROP TABLE scratch_t`)
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('DROP TABLE scratch_t')
    expect(await scratch.q(`SHOW TABLES FROM \`${scratch.name}\` LIKE 'scratch_t'`)).toHaveLength(1)
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Run anyway' }).click()
    await expect(dialog).toBeHidden()
    await expect(results).toContainText('1 statements')
    expect(await scratch.q(`SHOW TABLES FROM \`${scratch.name}\` LIKE 'scratch_t'`)).toHaveLength(0)

    // the sidebar lists the tables again after the DDL
    await expect(sidebar(page).getByRole('button', { name: 'scratch_t', exact: true })).toBeHidden()

    // 3. a long statement can be cancelled
    await editor.click()
    await editor.fill('SELECT SLEEP(10)')
    const started = Date.now()
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Cancel/ }).click()
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible()
    expect(Date.now() - started).toBeLessThan(8000)
  })
})
