import type { APIRequestContext, Browser } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { expect, randomName, signIn, test, type Scratch } from './fixtures/scratch-db'
import { gridRow, openTable, seedRowsCustomer } from './fixtures/rows-fixtures'
import {
  type Captured,
  capture,
  dropProperty,
  editInput,
  replaceString,
} from './fixtures/sql-fixtures'

/**
 * SCN-040 (hard delete token), SCN-042 (read-only server) and SCN-050 (privileges) of SPEC/24, from the
 * server side: requests are harvested from the real UI (aborted, so they change nothing), then modified or
 * replayed by hand with the CSRF header of the target session.
 */

const READ_ONLY_URL = 'http://localhost:3101'
const DEFAULT_URL = 'http://localhost:3100'
const CSRF = 'x-dbloom-csrf'

type Op = 'insert' | 'update' | 'delete'

/**
 * Drives the real UI as root on `origin`, aborts the changeRows request it sends and returns it.
 * `update` edits `column`; the resulting `set` holds only that column.
 */
async function harvest(
  browser: Browser,
  origin: string,
  address: string,
  scratch: Scratch,
  op: Op,
  column: 'name' | 'email' = 'name',
): Promise<Captured> {
  const context = await browser.newContext({ baseURL: origin })
  try {
    const page = await context.newPage()
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    const seen = capture(page, ['acceptSoft'])
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('"acceptSoft"')) await route.abort()
      else await route.continue()
    })
    if (op === 'insert') {
      await page.getByRole('button', { name: 'Insert', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('forged insert')
      await dialog
        .getByRole('textbox', { name: 'email', exact: true })
        .fill('forged-insert@example.test')
      await dialog.getByRole('button', { name: 'Go' }).last().click()
    } else if (op === 'update') {
      await gridRow(page, 'customer 1').getByRole('button', { name: 'Edit row' }).click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByRole('textbox', { name: column, exact: true })
        .fill(column === 'email' ? 'forged@example.test' : 'forged name')
      await dialog.getByRole('button', { name: 'Save' }).last().click()
    } else {
      await gridRow(page, 'customer 1').getByRole('button', { name: 'Delete row' }).click()
    }
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    return seen[0] as Captured
  } finally {
    await context.close()
  }
}

/** Sets `acceptSoft` to true so that a soft plan runs at once (a hard plan still only returns a token). */
const acceptSoft = (body: string) =>
  editInput(body, 'acceptSoft', (o, at) => {
    o.v[at] = { t: 2, s: 2 } as never
  })

/** Posts a captured request (possibly from another origin) to `origin` with that session's CSRF header. */
async function send(
  request: APIRequestContext,
  origin: string,
  c: Captured,
  body: string,
  csrf: string = c.headers[CSRF] as string,
) {
  const headers: Record<string, string> = {
    ...c.headers,
    [CSRF]: csrf,
    origin,
    referer: `${origin}/`,
  }
  for (const h of ['content-length', 'host', 'cookie']) delete headers[h]
  const u = new URL(c.url)
  const res = await request.post(`${origin}${u.pathname}${u.search}`, { headers, data: body })
  return res.text()
}

/** The CSRF header the page sends, read from its first table read. */
async function csrfOf(page: Parameters<typeof capture>[0], open: () => Promise<void>) {
  const seen = capture(page, ['table'])
  await open()
  await expect.poll(() => seen.length).toBeGreaterThan(0)
  return (seen[0] as Captured).headers[CSRF] as string
}

const customers = (scratch: Scratch) =>
  scratch.q<{ id: number; name: string; email: string }>(
    `SELECT id, name, email FROM \`${scratch.name}\`.customer ORDER BY id`,
  )

test.describe('SCN-040 step 2: the hard delete token', () => {
  test('missing, forged, tampered, other-session and replayed tokens are refused; nothing is deleted', async ({
    page,
    browser,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 4)
    const origin = DEFAULT_URL
    await signIn(page, address)
    await openTable(page, scratch.name, 'customer')
    const changes = capture(page, ['acceptSoft'])
    const confirms = capture(page, ['planId', 'confirmToken'])

    // Two rows: a hard plan, the table name must be typed. Hold the real confirm back.
    await page.route('**/_serverFn/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('"planId"') && body.includes('"confirmToken"')) await route.abort()
      else await route.continue()
    })
    await page.getByRole('checkbox', { name: 'Select row 1', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Select row 2', exact: true }).check()
    await page.getByRole('button', { name: 'Delete selected (2)' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: /Type customer to confirm/ }).fill('customer')
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect.poll(() => confirms.length).toBeGreaterThan(0)
    const good = confirms[0] as Captured
    const change = changes[0] as Captured
    expect(await customers(scratch)).toHaveLength(4)

    // A direct changeRows call cannot skip the confirmation: even with acceptSoft the hard plan only
    // comes back as a plan (no row is deleted).
    await send(page.request, origin, change, acceptSoft(change.body))
    expect(await customers(scratch)).toHaveLength(4)

    // Missing token.
    let text = await send(page.request, origin, good, dropProperty(good.body, 'confirmToken'))
    expect(text).toContain('token-missing')
    expect(await customers(scratch)).toHaveLength(4)

    // Forged token.
    text = await send(
      page.request,
      origin,
      good,
      replaceString(good.body, 'confirmToken', 'forged.token'),
    )
    expect(text).toContain('token-invalid')
    expect(await customers(scratch)).toHaveLength(4)

    // Tampered token: last character of the signature changed.
    const tampered = editInput(good.body, 'confirmToken', (o, at) => {
      const node = o.v[at] as unknown as { s: string }
      const last = node.s.slice(-1)
      node.s = node.s.slice(0, -1) + (last === 'A' ? 'B' : 'A')
    })
    text = await send(page.request, origin, good, tampered)
    expect(text).toContain('token-invalid')
    expect(await customers(scratch)).toHaveLength(4)

    // Another session cannot see the plan of the first.
    const other = await browser.newContext({ baseURL: origin })
    try {
      const page2 = await other.newPage()
      await signIn(page2, address)
      const csrf2 = await csrfOf(page2, () => openTable(page2, scratch.name, 'customer'))
      text = await send(other.request, origin, good, good.body, csrf2)
      expect(text).toContain('plan-missing')
      expect(await customers(scratch)).toHaveLength(4)
    } finally {
      await other.close()
    }

    // The refusals did not spend the plan: the real click still works, once.
    await page.unroute('**/_serverFn/**')
    await dialog
      .getByRole('button', { name: /^Delete/ })
      .last()
      .click()
    await expect(dialog).toBeHidden()
    await expect(gridRow(page, 'customer 1')).toHaveCount(0)
    await expect(gridRow(page, 'customer 2')).toHaveCount(0)
    expect((await customers(scratch)).map((r) => r.name)).toEqual(['customer 3', 'customer 4'])

    // Replay of the used token: the plan is gone. Put the rows back first so that a delete would show.
    await scratch.q(
      `INSERT INTO \`${scratch.name}\`.customer (id, name, email) VALUES (1, 'back 1', 'b1@example.test'), (2, 'back 2', 'b2@example.test')`,
    )
    text = await send(page.request, origin, good, good.body)
    expect(text).toContain('plan-missing')
    expect(await customers(scratch)).toHaveLength(4)
  })

  // Expiry (10 minutes) is covered by tests/rows.integration.test.ts with an injected clock; a browser
  // test cannot move the server clock.
})

test.describe('SCN-042 forged writes on the read-only server', () => {
  test.use({ baseURL: READ_ONLY_URL })

  test('insert, update and delete through changeRows are refused with read-only; nothing changes', async ({
    page,
    browser,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    const before = await customers(scratch)
    const harvested: Record<Op, Captured> = {
      insert: await harvest(browser, DEFAULT_URL, address, scratch, 'insert'),
      update: await harvest(browser, DEFAULT_URL, address, scratch, 'update'),
      delete: await harvest(browser, DEFAULT_URL, address, scratch, 'delete'),
    }
    expect(await customers(scratch)).toEqual(before) // the harvest itself changed nothing

    await signIn(page, address)
    const csrf = await csrfOf(page, () => openTable(page, scratch.name, 'customer'))
    for (const op of ['insert', 'update', 'delete'] as const) {
      const c = harvested[op]
      for (const body of [c.body, acceptSoft(c.body)]) {
        const text = await send(page.request, READ_ONLY_URL, c, body, csrf)
        expect(text, op).toContain('read-only')
        expect(await customers(scratch), op).toEqual(before)
      }
    }
  })
})

test.describe('SCN-050 forged writes without the privilege', () => {
  test('SELECT only: insert, update and delete give the server 1142 with a hint; nothing changes', async ({
    page,
    browser,
    scratch,
    address,
  }) => {
    await seedRowsCustomer(scratch, 3)
    const before = await customers(scratch)
    const harvested: Record<Op, Captured> = {
      insert: await harvest(browser, DEFAULT_URL, address, scratch, 'insert'),
      update: await harvest(browser, DEFAULT_URL, address, scratch, 'update'),
      delete: await harvest(browser, DEFAULT_URL, address, scratch, 'delete'),
    }
    const { user, password } = await scratch.createLimitedUser()
    await signIn(page, address, user, password)
    const csrf = await csrfOf(page, () => openTable(page, scratch.name, 'customer'))
    for (const op of ['insert', 'update', 'delete'] as const) {
      const c = harvested[op]
      const text = await send(page.request, DEFAULT_URL, c, acceptSoft(c.body), csrf)
      expect(text, op).toContain('1142')
      expect(text, op).toMatch(/lacks a privilege/i)
      expect(await customers(scratch), op).toEqual(before)
    }
  })

  test('UPDATE (name) only: a forged update of email gives 1143 and the row stays', async ({
    page,
    browser,
    scratch,
    address,
  }) => {
    const t = `\`${scratch.name}\`.customer`
    await seedRowsCustomer(scratch, 3)
    const before = await customers(scratch)
    const forged = await harvest(browser, DEFAULT_URL, address, scratch, 'update', 'email')
    const user = randomName('e2e_lim_')
    const password = randomBytes(9).toString('hex')
    await scratch.q('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password])
    try {
      await scratch.q(`GRANT SELECT ON \`${scratch.name}\`.* TO ?@?`, [user, '%'])
      await scratch.q(`GRANT UPDATE (name) ON ${t} TO ?@?`, [user, '%'])
      await signIn(page, address, user, password)
      const csrf = await csrfOf(page, () => openTable(page, scratch.name, 'customer'))
      const text = await send(page.request, DEFAULT_URL, forged, acceptSoft(forged.body), csrf)
      expect(text).toContain('1143')
      expect(text).toMatch(/lacks a privilege/i)
      expect(await customers(scratch)).toEqual(before)
    } finally {
      await scratch.q('DROP USER IF EXISTS ?@?', [user, '%'])
    }
  })

  test('no SELECT on one column: the table still renders', async ({ page, scratch, address }) => {
    const t = `\`${scratch.name}\`.customer`
    await seedRowsCustomer(scratch, 3)
    const user = randomName('e2e_lim_')
    const password = randomBytes(9).toString('hex')
    await scratch.q('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password])
    try {
      await scratch.q(`GRANT SELECT (id, name) ON ${t} TO ?@?`, [user, '%'])
      await signIn(page, address, user, password)
      await openTable(page, scratch.name, 'customer')
      // The column without privilege is absent or an error cell; the page does not crash either way.
      await expect(gridRow(page, 'customer 1')).toBeVisible()
      await expect(gridRow(page, 'customer 3')).toBeVisible()
      await expect(page.getByText('unexpected_error')).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 1 })).toContainText('customer')
    } finally {
      await scratch.q('DROP USER IF EXISTS ?@?', [user, '%'])
    }
  })
})
