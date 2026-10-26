import { expect, signIn, test } from './fixtures/scratch-db'
import { gridRow, openTable } from './fixtures/rows-fixtures'

/** SCN-039 of SPEC/24: saving an untouched form keeps every stored value byte for byte. */

test('SCN-039 untouched edit form sends nothing; changing one field writes only that field', async ({
  page,
  scratch,
  address,
}) => {
  const t = `\`${scratch.name}\`.typed`
  await scratch.q(
    `CREATE TABLE ${t} (
       id INT NOT NULL PRIMARY KEY, name VARCHAR(50) NOT NULL, txt TEXT NULL,
       dt DATETIME(6) NULL, tm TIME(3) NULL, yr YEAR NULL, d DATE NULL,
       bin16 BINARY(16) NULL, vb VARBINARY(20) NULL, st SET('a','b') NOT NULL,
       bt BIT(12) NULL, dec30 DECIMAL(30,10) NULL, big BIGINT NULL)`,
  )
  await scratch.q(`SET SESSION sql_mode = ''`)
  await scratch.q(
    `INSERT INTO ${t} VALUES (1, 'row one', ?, '2024-03-05 12:34:56.123456', '01:02:03.456', 2024,
       '0099-01-02', ?, ?, '', b'000000000101', '12345678901234567890.0123456789',
       9223372036854775807)`,
    [
      'a\r\nb  ',
      Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      Buffer.from('00ff0a', 'hex'),
    ],
  )
  const checksum = async () =>
    (await scratch.q<{ Checksum: string }>(`CHECKSUM TABLE ${t}`))[0]?.Checksum
  const before = await checksum()
  const snapshot = async () =>
    scratch.q(
      `SELECT txt, dt, tm, yr, CAST(d AS CHAR) AS d, HEX(bin16) AS bin16, HEX(vb) AS vb, st,
              CAST(bt AS UNSIGNED) AS bt, dec30, big FROM ${t}`,
    )
  const values = await snapshot()

  await signIn(page, address)
  await openTable(page, scratch.name, 'typed')
  await gridRow(page, 'row one').getByRole('button', { name: 'Edit row' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('textbox', { name: 'name', exact: true })).toHaveValue('row one')

  let posts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/_serverFn/')) posts++
  })
  await dialog.getByRole('button', { name: 'Save' }).last().click()
  await expect(page.getByText('No changes. Nothing was sent.')).toBeVisible()
  expect(posts).toBe(0)
  expect(await checksum()).toBe(before)

  // Step 2: change only `name`.
  await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('renamed')
  await dialog.getByRole('button', { name: 'Show SQL' }).click()
  const sql = page.getByRole('dialog').last()
  await expect(sql.getByText(/UPDATE/).first()).toBeVisible()
  await expect(sql.getByText(/SET `name`/).first()).toBeVisible()
  await expect(sql.getByText(/`txt`|`dt`|`bt`|`big`/)).toHaveCount(0)
  await sql.getByRole('button', { name: 'Close' }).click()
  await dialog.getByRole('button', { name: 'Save' }).last().click()
  await expect(async () => {
    const [row] = await scratch.q<{ name: string }>(`SELECT name FROM ${t}`)
    expect(row?.name).toBe('renamed')
  }).toPass({ timeout: 8000 })
  expect(await snapshot()).toEqual(values)
})
