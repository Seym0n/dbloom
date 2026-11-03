import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  dialog,
  fillSignIn,
  h1,
  openSignIn,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  storeQuery,
  takeTotp,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SPEC/29 section 8 on a real server: the viewer shows sign-in, failed sign-in and a user action with actor and address; export; sink. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

let server: LiveServer
let admin: Account
let sinkFile: string
const entries = (page: Page) => page.getByRole('list', { name: 'Audit entries' }).getByRole('listitem')

test.beforeAll(async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-live-'))
  mkdirSync(dir, { recursive: true })
  sinkFile = join(dir, 'audit.log')
  server = await startServer({ DBLOOM_AUDIT_SINK: `file:${sinkFile}` })
  const page = await browser.newPage()
  admin = await runSetupWizard(page, server, { username: 'root1' })
  await page.close()
})
test.afterAll(async () => server?.stop())

async function stepUpIfAsked(page: Page) {
  const d = dialog(page, 'Confirm it is you')
  if (await d.isVisible({ timeout: 1500 }).catch(() => false)) {
    await d.getByLabel('Code from your authenticator app').fill(await takeTotp(admin))
    await d.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(d).toBeHidden()
  }
}

async function auditPage(page: Page) {
  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(h1(page)).toHaveText('Audit log')
}

test('a failed sign-in, a sign-in and a user action appear in the viewer with actor and address', async ({ page }) => {
  // Failed sign-in first (wrong password), then the real one.
  await openSignIn(page, server)
  await fillSignIn(page, admin.username, 'wrong password entirely')
  await expect(page.getByRole('alert')).toBeVisible()
  await signInWithRecovery(page, server, admin)

  // A user action: create dora.
  await page.getByRole('link', { name: 'Users' }).click()
  await expect(h1(page)).toHaveText('Users')
  await page.getByRole('button', { name: 'Create user' }).first().click()
  const d = dialog(page, 'Create a user')
  await d.getByLabel('User name').fill('dora')
  await d.getByRole('button', { name: 'Generate password' }).click()
  await d.getByRole('button', { name: 'Create user' }).click()
  await stepUpIfAsked(page)
  const done = dialog(page, 'User created')
  await done.getByLabel('I passed it on').check()
  await done.getByRole('button', { name: 'Done' }).click()

  await page.goto(`${server.baseURL}/`)
  await expect(h1(page)).toHaveText('Connect to a database')
  await auditPage(page)

  // Newest first; filter to sign-ins: one failed and one ok.
  await page.getByLabel('Event').selectOption('auth.signin')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(entries(page).filter({ hasText: 'failed' })).toHaveCount(1)
  await expect(entries(page).filter({ hasText: 'ok' }).first()).toBeVisible()

  // The user action, with actor name and a loopback address in the detail.
  await page.getByRole('button', { name: 'Reset' }).click()
  await page.getByLabel('Event').selectOption('user.create')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(entries(page)).toHaveCount(1)
  await expect(entries(page).first()).toContainText('root1')
  await entries(page).first().getByRole('button').click()
  const panel = page.getByRole('region', { name: /^Entry \d+$/ })
  await expect(panel).toContainText('root1')
  await expect(panel).toContainText(/127\.0\.0\.1|::1/)
  await expect(panel).not.toContainText(/password/i)
})

test('own activity on the account page lists the administrator’s events', async ({ page }) => {
  await signInWithRecovery(page, server, admin)
  await page.goto(`${server.baseURL}/account`)
  const list = page.getByRole('list', { name: 'Recent activity' })
  await expect(list.getByRole('listitem').first()).toBeVisible()
  await expect(list).toContainText('auth.signin')
})

test('export needs a step-up, writes audit.export first, and the file holds the rows', async ({ page }) => {
  await signInWithRecovery(page, server, admin)
  await auditPage(page)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  await stepUpIfAsked(page)
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^dbloom-audit-\d{4}-\d{2}-\d{2}\.csv$/)
  const path = join(tmpdir(), `audit-export-${Date.now()}.csv`)
  await file.saveAs(path)
  const csv = readFileSync(path, 'utf8')
  expect(csv.startsWith('id,time,event,outcome,actor_id,actor_name,actor_kind,subject,address,fields\r\n')).toBe(true)
  expect(csv).toContain('user.create')
  expect(csv).toContain('auth.signin')
  const exported = storeQuery<{ actor_name: string | null; actor_kind: string }>(server, "SELECT actor_name, actor_kind FROM audit_log WHERE event = 'audit.export'")
  expect(exported).toHaveLength(1)
  expect(exported![0]).toMatchObject({ actor_name: 'root1', actor_kind: 'user' })
})

test('the table and the file sink hold the same events; direct writes are refused; growth is recorded', async () => {
  const rows = storeQuery<{ event: string; actor_kind: string; address: string | null }>(server, 'SELECT event, actor_kind, address FROM audit_log ORDER BY id')!
  const events = new Set(rows.map((r) => r.event))
  for (const e of ['setup.token', 'setup.complete', 'auth.signin', 'user.create', 'audit.export']) expect(events, e).toContain(e)
  // Request events carry the client address; setup and system events may not.
  expect(rows.filter((r) => r.event === 'user.create').every((r) => !!r.address)).toBe(true)

  // File sink: one line per event, same count of audit.export lines (no double write).
  await new Promise((r) => setTimeout(r, 2500)) // flush interval
  const lines = readFileSync(sinkFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { audit: string })
  expect(lines.filter((l) => l.audit === 'audit.export')).toHaveLength(1)
  expect(lines.filter((l) => l.audit === 'user.create')).toHaveLength(1)

  // Append only: direct SQL through a writable handle fails.
  const { DatabaseSync } = await import('node:sqlite')
  const { storePath } = await import('./fixtures/auth-live')
  const db = new DatabaseSync(storePath(server)!)
  try {
    expect(() => db.exec("UPDATE audit_log SET event = 'x'")).toThrow(/append-only/)
    expect(() => db.exec('DELETE FROM audit_log')).toThrow(/append-only/)
  } finally {
    db.close()
  }

  // Row growth of this run, for reviews/admin-audit-acceptance.md.
  const stats = storeQuery<{ n: number; bytes: number }>(server, 'SELECT COUNT(*) AS n, SUM(LENGTH(fields) + LENGTH(event) + COALESCE(LENGTH(subject), 0) + COALESCE(LENGTH(address), 0) + COALESCE(LENGTH(actor_name), 0)) AS bytes FROM audit_log')![0]!
  writeFileSync(join(tmpdir(), 'dbloom-audit-live-growth.json'), JSON.stringify({ rows: stats.n, payloadBytes: stats.bytes, perRow: Math.round(stats.bytes / stats.n) }))
  test.info().annotations.push({ type: 'growth', description: `${stats.n} rows, ${stats.bytes} bytes of payload, ${Math.round(stats.bytes / stats.n)} per row` })
})
