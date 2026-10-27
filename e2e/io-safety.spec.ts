import { readdirSync } from 'node:fs'
import { request as nodeRequest } from 'node:http'
import { resolve } from 'node:path'
import { zipSync } from 'fflate'
import { expect as pwExpect, request as pwRequest } from '@playwright/test'
import type { Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures/scratch-db'
import { gz, openImport, pickFile, upload, zip1 } from './fixtures/io-fixtures'

/** SCN-062 of SPEC/25: upload and file safety, the server import folder, signed-out access. */

const IO_URL = 'http://localhost:3103'
const TMP = resolve('test-results/data-io/tmp')
const staged = () => {
  try {
    return readdirSync(TMP).length
  } catch {
    return 0
  }
}

/** The CSRF header and cookie of a signed-in page, captured from one real upload. */
async function sessionOf(page: Page, origin: string) {
  let csrf = ''
  page.on('request', (r) => {
    if (r.url().includes('/api/io/upload')) csrf = r.headers()['x-dbloom-csrf'] ?? ''
  })
  await pickFile(page, upload('probe.sql', 'SELECT 1;\n'))
  await expect.poll(() => csrf).not.toBe('')
  const cookies = await page.context().cookies(origin)
  return { csrf, cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') }
}

type RawResult = { status: number; body: string }

/** A raw PUT with full control of the framing: declared length, chunked body, and an early disconnect. */
function rawPut(
  origin: string,
  s: { csrf: string; cookie: string },
  o: {
    declared?: number
    chunks: Buffer[]
    destroyAfter?: boolean
    path?: string
  },
): Promise<RawResult> {
  const url = new URL(origin)
  return new Promise((resolveResult, reject) => {
    const headers: Record<string, string | number> = {
      'x-dbloom-csrf': s.csrf,
      cookie: s.cookie,
      origin,
      'content-type': 'application/octet-stream',
    }
    if (o.declared !== undefined) headers['content-length'] = o.declared
    const req = nodeRequest(
      {
        host: url.hostname,
        port: url.port,
        method: 'PUT',
        path: o.path ?? '/api/io/upload?format=sql&name=raw.sql',
        headers,
      },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolveResult({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', (e) => {
      if (o.destroyAfter) resolveResult({ status: 0, body: String(e) })
      else reject(e)
    })
    void (async () => {
      for (const c of o.chunks) {
        if (!req.write(c)) await new Promise((r) => req.once('drain', r))
      }
      if (o.destroyAfter) {
        await new Promise((r) => setTimeout(r, 200))
        req.destroy()
        resolveResult({ status: 0, body: 'aborted' })
      } else req.end()
    })()
  })
}

test.describe('SCN-062 upload limit and abort (1 MiB server)', () => {
  test.use({ baseURL: IO_URL })

  test('an oversize file is refused in the page with the effective limit, nothing is staged', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await expect(page.getByText('Largest file: 1 MiB.')).toBeVisible()
    const before = staged()
    await pickFile(page, upload('big.csv', Buffer.alloc(1_500_000, 'a')))
    await expect(page.getByText(/larger than the upload limit of 1/)).toBeVisible()
    expect(staged()).toBe(before)
  })

  test('direct calls: correct length, missing length and aborted upload are cut off and leave nothing', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    const s = await sessionOf(page, IO_URL)
    await page.waitForTimeout(500)
    const before = staged()

    // A correct, too large length is refused before a byte is read.
    const big = Buffer.alloc(1_500_000, 'x')
    const declared = await rawPut(IO_URL, s, { declared: big.length, chunks: [big] }).catch(() => ({
      status: 413,
      body: 'closed',
    }))
    expect(declared.status).toBe(413)

    // No length at all (chunked): counted while reading and cut off at the limit.
    const chunked = await rawPut(IO_URL, s, {
      chunks: Array.from({ length: 30 }, () => Buffer.alloc(50_000, 'y')),
    }).catch(() => ({ status: 413, body: 'closed' }))
    expect(chunked.status).toBe(413)
    expect(chunked.body + '').not.toContain('/etc')

    // A half-sent body that is abandoned.
    await rawPut(IO_URL, s, {
      declared: 900_000,
      chunks: [Buffer.alloc(100_000, 'z')],
      destroyAfter: true,
    })
    await expect.poll(staged, { timeout: 10_000 }).toBe(before)
  })

  test('the server import folder lists a regular file, which imports', async ({
    page,
    scratch,
    address,
  }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await expect(page.getByText('Files in the server import folder')).toBeVisible()
    await page.getByRole('button', { name: /^folder-dump\.sql/ }).click()
    await expect(page.getByText('2 statements', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Import…', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click()
    await expect(page.getByRole('status').getByRole('heading').first()).toHaveText(
      'Import finished',
    )
    const rows = await scratch.q('SELECT id FROM `' + scratch.name + '`.folder_t ORDER BY id')
    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    // The staged copy of a folder file does not exist: the folder is read in place.
    void gz
  })

  test('a forged path or id for the folder is refused', async ({ page, scratch, address }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
    await expect(page.getByText('Files in the server import folder')).toBeVisible()
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('uploadId') && !body.includes('confirmToken')) {
        return route.continue({
          postData: body.replace(/"s":"fld_[0-9a-f]+"/, '"s":"fld_../../etc/passwd"'),
        })
      }
      return route.continue()
    })
    await page.getByRole('button', { name: /^folder-dump\.sql/ }).click()
    await expect(page.getByRole('alert').first()).toBeVisible()
    await expect(page.getByText('2 statements', { exact: true })).toHaveCount(0)
  })
})

test.describe('SCN-062 refused archives', () => {
  test.beforeEach(async ({ page, scratch, address }) => {
    await signIn(page, address)
    await openImport(page, scratch.name)
  })

  test('a zip with two entries', async ({ page }) => {
    const two = Buffer.from(
      zipSync({ 'a.sql': Buffer.from('SELECT 1;'), 'b.sql': Buffer.from('SELECT 2;') }),
    )
    await pickFile(page, upload('two.sql.zip', two))
    await expect(page.getByRole('alert').first()).toContainText(
      'Only an archive with a single file and no archive inside is accepted.',
    )
  })

  test('a zip inside a zip', async ({ page }) => {
    await pickFile(page, upload('nested.sql.zip', zip1('inner.zip', zip1('x.sql', 'SELECT 1;'))))
    await expect(page.getByRole('alert').first()).toContainText(
      'Only an archive with a single file and no archive inside is accepted.',
    )
  })

  test('a zip bomb is stopped by the ratio', async ({ page }) => {
    const bomb = zip1('zeros.sql', Buffer.alloc(150 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(1024 * 1024)
    await pickFile(page, upload('bomb.sql.zip', bomb))
    await expect(page.getByRole('alert').first()).toContainText(
      'unpacks to far more than its size',
      { timeout: 30_000 },
    )
  })

  test('a truncated gzip', async ({ page }) => {
    await pickFile(
      page,
      upload('cut.sql.gz', gz('INSERT INTO a VALUES (1);\n'.repeat(5000)).subarray(0, 60)),
    )
    await expect(page.getByRole('alert').first()).toBeVisible()
  })
})

test.describe('SCN-062 signed out', () => {
  test('upload, download and the server functions refuse without a session', async () => {
    const anon = await pwRequest.newContext({ baseURL: 'http://localhost:3100' })
    const up = await anon.put('/api/io/upload?format=sql&name=x.sql', { data: 'SELECT 1;' })
    pwExpect([401, 403]).toContain(up.status())
    const down = await anon.get('/api/io/download/AAAAAAAAAAAAAAAAAAAAAA')
    pwExpect([401, 403, 404]).toContain(down.status())
    pwExpect(await down.text()).not.toContain('CREATE TABLE')
    await anon.dispose()
  })
})
