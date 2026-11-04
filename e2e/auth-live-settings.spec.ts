import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  SECRET_KEY,
  SETUP_TOKEN,
  dialog,
  fillSignIn,
  h1,
  openSignIn,
  runSetupWizard,
  signInWithRecovery,
  startServer,
  storePath,
  storeQuery,
  takeTotp,
  type Account,
  type LiveServer,
} from './fixtures/auth-live'

/** SPEC/32 on a real server: the settings editor, its audit trail, locks, narrowing, site texts, maintenance mode and the CLI. */

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const EXTRAS = { DBLOOM_SETTINGS_LOCK: 'sessionsPerUser' }
let server: LiveServer
let admin: Account
let adminPage: Page
let adminContext: BrowserContext
const temps: Record<string, string> = {}

const MAINTENANCE_REFUSED = 'DBLoom is in maintenance mode. Try again later.'
const row = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })
const field = (page: Page, name: string) => row(page, name).getByLabel(name, { exact: true })
const save = (page: Page, name: string) => row(page, name).getByRole('button', { name: `Save: ${name}` })
const reset = (page: Page, name: string) => row(page, name).getByRole('button', { name: `Reset: ${name}` })
const userRow = (page: Page, username: string) => page.getByRole('list', { name: 'Users' }).getByRole('listitem').filter({ hasText: username })

test.beforeAll(async ({ browser }) => {
  server = await startServer(EXTRAS)
  const setup = await browser.newPage()
  admin = await runSetupWizard(setup, server, { username: 'root1' })
  await setup.close()
  adminContext = await browser.newContext()
  adminPage = await adminContext.newPage()
  await signInWithRecovery(adminPage, server, admin)
})
test.afterAll(async () => {
  await adminContext?.close()
  await server?.stop()
})

async function stepUpIfAsked(page: Page) {
  const d = dialog(page, 'Confirm it is you')
  if (await d.isVisible({ timeout: 1500 }).catch(() => false)) {
    await d.getByLabel('Code from your authenticator app').fill(await takeTotp(admin))
    await d.getByRole('button', { name: 'Confirm and continue' }).click()
    await expect(d).toBeHidden()
  }
}

/** After a restart the browser starts over: a new context signs the administrator in again with a recovery code. */
async function freshAdmin(browser: Browser) {
  await adminContext.close()
  adminContext = await browser.newContext()
  adminPage = await adminContext.newPage()
  await signInWithRecovery(adminPage, server, admin)
}

async function settingsPage() {
  await adminPage.goto(`${server.baseURL}/admin/settings`)
  await expect(h1(adminPage)).toHaveText('Settings')
}

/** Types a value into a row and saves it, confirming with a second factor when asked. */
async function change(name: string, value: string) {
  await field(adminPage, name).fill(value)
  await save(adminPage, name).click()
  await stepUpIfAsked(adminPage)
}

type AuditRow = { event: string; actor_name: string | null; actor_kind: string; subject: string | null; fields: string }
const settingsRows = () =>
  storeQuery<AuditRow>(server, "SELECT event, actor_name, actor_kind, subject, fields FROM audit_log WHERE event IN ('settings.change','settings.reset','settings.clamped') ORDER BY id")!.map((r) => ({ ...r, f: JSON.parse(r.fields) as Record<string, unknown> }))
const storedSettings = () => storeQuery<{ key: string; value: string }>(server, 'SELECT key, value FROM settings ORDER BY key')!
/** The setup wizard stores its site values; the specs look at single keys and at what a refusal leaves unchanged. */
const stored = (key: string) => storedSettings().find((r) => r.key === key)?.value

/** The CLI runs with the environment of the server, as an operator would run it. */
function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [resolve('.output/cli/dbloom.mjs'), ...args], {
    env: { ...process.env, DBLOOM_DATA_DIR: server.dataDir, ...EXTRAS, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout }
}

async function createUser(username: string): Promise<void> {
  await adminPage.goto(`${server.baseURL}/admin/users`)
  await expect(h1(adminPage)).toHaveText('Users')
  await adminPage.getByRole('button', { name: 'Create user' }).first().click()
  const d = dialog(adminPage, 'Create a user')
  await d.getByLabel('User name').fill(username)
  await d.getByRole('button', { name: 'Generate password' }).click()
  await d.getByRole('button', { name: 'Create user' }).click()
  await stepUpIfAsked(adminPage)
  const done = dialog(adminPage, 'User created')
  temps[username] = (await done.getByRole('list', { name: 'Temporary password' }).innerText()).replace(/\s+/g, '')
  await done.getByLabel('I passed it on').check()
  await done.getByRole('button', { name: 'Done' }).click()
  await expect(userRow(adminPage, username)).toBeVisible()
}

async function userAttempt(browser: Browser, username: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await openSignIn(page, server)
  await fillSignIn(page, username, temps[username]!)
  return { context, page }
}

test('the page lists every group; a locked setting is read-only; no secret is on the page', async () => {
  await settingsPage()
  for (const g of ['Sign-in and second factor', 'Sessions', 'Throttling', 'Audit and notices', 'Site messages and maintenance']) {
    await expect(adminPage.getByRole('heading', { level: 2, name: g })).toBeVisible()
  }
  await expect(field(adminPage, 'Failed sign-ins before a delay')).toHaveValue('5')
  await expect(row(adminPage, 'Failed sign-ins before a delay')).toContainText('Built-in default')
  await expect(row(adminPage, 'Sessions per user')).toContainText('Locked by the operator')
  await expect(row(adminPage, 'Sessions per user').getByRole('button')).toHaveCount(0)
  await expect(row(adminPage, 'Authenticator code tolerance (steps)')).toContainText('Set by the operator in the environment only.')
  const body = await adminPage.locator('body').innerText()
  expect(body).not.toContain(SECRET_KEY)
  expect(body).not.toContain(SETUP_TOKEN)
  expect(body).not.toMatch(/dbloom-session/)
})

test('a change asks for a second factor, writes the audit row with old and new first, and a reset undoes it', async () => {
  await settingsPage()
  await change('Failed sign-ins before a delay', '7')
  await expect(row(adminPage, 'Failed sign-ins before a delay').getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await expect(row(adminPage, 'Failed sign-ins before a delay')).toContainText('Set here')
  expect(stored('loginFailures')).toBe('7')
  expect(settingsRows()).toMatchObject([{ event: 'settings.change', actor_name: 'root1', actor_kind: 'user', f: { setting: 'loginFailures', old: '5', new: '7', stored: false } }])

  await adminPage.reload()
  await expect(field(adminPage, 'Failed sign-ins before a delay')).toHaveValue('7')
  await reset(adminPage, 'Failed sign-ins before a delay').click()
  await expect(row(adminPage, 'Failed sign-ins before a delay')).toContainText('Built-in default')
  expect(stored('loginFailures')).toBeUndefined()
  expect(settingsRows().map((r) => [r.event, r.f.old, r.f.new])).toEqual([
    ['settings.change', '5', '7'],
    ['settings.reset', '7', '5'],
  ])

  await adminPage.goto(`${server.baseURL}/admin/audit`)
  await adminPage.getByLabel('Event').selectOption('settings.change')
  await adminPage.getByRole('button', { name: 'Apply filters' }).click()
  await expect(adminPage.getByRole('list', { name: 'Audit entries' }).getByRole('listitem')).toHaveCount(1)
})

test('a value outside the limits and a narrowing that would lock out users are refused; nothing is stored or audited', async () => {
  const before = storedSettings()
  await settingsPage()
  await change('Failed sign-ins before a delay', '2')
  await expect(row(adminPage, 'Failed sign-ins before a delay').getByRole('alert')).toHaveText('The value is below the lowest allowed.')
  await change('Failed sign-ins before a delay', '11')
  await expect(row(adminPage, 'Failed sign-ins before a delay').getByRole('alert')).toHaveText('The value is above the highest allowed.')
  await change('Keep audit entries for', '30')
  await expect(row(adminPage, 'Keep audit entries for').getByRole('alert')).toHaveText('The value is below the lowest allowed.')

  // The only administrator has an authenticator app and no passkey: removing the app would lock them out.
  const factors = row(adminPage, 'Allowed second factors')
  await factors.getByLabel('Authenticator app').uncheck()
  await expect(factors.getByRole('status')).toContainText('1 active users would be left with no allowed option')
  await save(adminPage, 'Allowed second factors').click()
  await stepUpIfAsked(adminPage)
  await expect(factors.getByRole('alert')).toContainText('1 active users would be left with no allowed option and could not sign in. Nothing was changed.')

  expect(storedSettings()).toEqual(before)
  expect(settingsRows()).toHaveLength(2) // the two rows of the previous test
})

test('when the audit row cannot be written the change is not made; once it can, it is', async () => {
  await settingsPage()
  const name = 'Failed sign-ins before a delay'
  // A trigger refuses the audit row of this one event: the required insert fails, every other write of the server goes on.
  const sql = new DatabaseSync(storePath(server)!)
  sql.exec('PRAGMA busy_timeout = 10000')
  sql.exec("CREATE TRIGGER refuse_settings_audit BEFORE INSERT ON audit_log WHEN NEW.event = 'settings.change' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END")
  try {
    await field(adminPage, name).fill('8')
    await save(adminPage, name).click()
    await stepUpIfAsked(adminPage)
    await expect(row(adminPage, name).getByRole('alert')).toHaveText('The audit log could not be written, so nothing was changed.')
  } finally {
    sql.exec('DROP TRIGGER refuse_settings_audit')
    sql.close()
  }
  expect(stored('loginFailures')).toBeUndefined()
  await save(adminPage, name).click()
  await stepUpIfAsked(adminPage)
  await expect(row(adminPage, name)).toContainText('Set here')
  expect(stored('loginFailures')).toBe('8')
  await reset(adminPage, name).click()
  await expect(row(adminPage, name)).toContainText('Built-in default')
})

test('the login notice shows on the sign-in page and the banner after sign-in, both as plain text', async ({ browser }) => {
  await settingsPage()
  await change('Notice on the sign-in page', '<b>Planned</b> work on Friday')
  await expect(row(adminPage, 'Notice on the sign-in page')).toContainText('Set here')
  await field(adminPage, 'Banner for signed-in users').fill('Backup tonight.\n<i>No data is lost.</i>')
  await save(adminPage, 'Banner for signed-in users').click()
  await expect(row(adminPage, 'Banner for signed-in users')).toContainText('Set here')

  const anonymous = await browser.newContext()
  const page = await anonymous.newPage()
  await openSignIn(page, server)
  const note = page.getByRole('note', { name: 'Notice' })
  await expect(note).toHaveText('<b>Planned</b> work on Friday')
  await expect(note.locator('b')).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Notice from the administrators' })).toHaveCount(0) // not before sign-in
  await anonymous.close()

  await adminPage.goto(`${server.baseURL}/`)
  const banner = adminPage.getByRole('complementary', { name: 'Notice from the administrators' })
  await expect(banner).toContainText('Backup tonight.')
  await expect(banner).toContainText('<i>No data is lost.</i>')
  await expect(banner.locator('i')).toHaveCount(0)

  await settingsPage()
  await field(adminPage, 'Notice on the sign-in page').fill('')
  await save(adminPage, 'Notice on the sign-in page').click()
  await field(adminPage, 'Banner for signed-in users').fill('')
  await save(adminPage, 'Banner for signed-in users').click()
  await expect(row(adminPage, 'Banner for signed-in users').getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await adminPage.goto(`${server.baseURL}/`)
  await expect(adminPage.getByRole('complementary', { name: 'Notice from the administrators' })).toHaveCount(0)
  await settingsPage()
  await expect(row(adminPage, 'Banner for signed-in users')).toContainText('Last changed by root1')
})

test('maintenance mode: users are refused, the administrator keeps working, the CLI switches it off while the server runs', async ({ browser }) => {
  await createUser('ann')
  await createUser('ben')
  // ann is signed in before maintenance starts; ben is not.
  const ann = await userAttempt(browser, 'ann')
  const change_ = dialog(ann.page, 'Choose a new password')
  const fresh = 'purple harbour violin 4242 quiet'
  await change_.getByLabel('Current password').fill(temps.ann!)
  await change_.getByLabel('New password', { exact: true }).fill(fresh)
  await change_.getByLabel('New password again').fill(fresh)
  await change_.getByRole('button', { name: 'Change password' }).click()
  await expect(h1(ann.page)).toHaveText('Connect to a database')

  await settingsPage()
  await field(adminPage, 'Maintenance mode').check()
  await save(adminPage, 'Maintenance mode').click()
  await stepUpIfAsked(adminPage)
  await expect(row(adminPage, 'Maintenance mode')).toContainText('Set here')
  await expect(adminPage.getByRole('complementary', { name: 'Maintenance' })).toContainText('You are exempt as an administrator.')

  // ben proves who they are and is refused; nothing counts as a failed attempt
  const ben = await userAttempt(browser, 'ben')
  await expect(ben.page.getByRole('alert')).toHaveText(MAINTENANCE_REFUSED)
  expect(storeQuery<{ n: number }>(server, "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'auth.signin' AND outcome = 'refused'")![0]!.n).toBeGreaterThanOrEqual(1)
  await expect(ben.page.getByRole('complementary', { name: 'Maintenance' })).toContainText('Maintenance: only administrators can sign in right now.')

  // ann's open session is kept, but she is told and nothing works
  await ann.page.reload()
  await expect(ann.page.getByRole('complementary', { name: 'Maintenance' })).toContainText('DBLoom is in maintenance mode. You can work again when it ends.')

  // the administrator is not affected
  await adminPage.goto(`${server.baseURL}/admin/users`)
  await expect(h1(adminPage)).toHaveText('Users')

  const list = cli(['settings', 'list'])
  expect(list.code).toBe(0)
  expect(list.out).toMatch(/^maintenanceOn\s+true\s+\(ui override\)/m)

  const off = cli(['maintenance', 'off'])
  expect(off.code).toBe(0)
  expect(off.out).toContain('Maintenance mode is off')
  // a running server picks it up within its short cache
  await expect
    .poll(async () => {
      await openSignIn(ben.page, server)
      await fillSignIn(ben.page, 'ben', temps.ben!)
      return Promise.race([
        ben.page.getByRole('alert').waitFor({ timeout: 8000 }).then(() => 'refused'),
        dialog(ben.page, 'Choose a new password').waitFor({ timeout: 8000 }).then(() => 'allowed'),
      ]).catch(() => 'none')
    }, { timeout: 30_000, intervals: [1000] })
    .toBe('allowed')
  await expect(dialog(ben.page, 'Choose a new password')).toBeVisible()

  expect(stored('maintenanceOn')).toBeUndefined()
  const rows = settingsRows().filter((r) => r.f.setting === 'maintenanceOn')
  expect(rows.map((r) => [r.event, r.actor_kind, r.f.old, r.f.new])).toEqual([
    ['settings.change', 'user', 'false', 'true'],
    ['settings.reset', 'cli', 'true', 'false'],
  ])
  await ann.context.close()
  await ben.context.close()
})

test('maintenance forced by the operator cannot be switched off from the page or the CLI', async ({ browser }) => {
  await server.restart({ ...EXTRAS, DBLOOM_MAINTENANCE: 'true' })
  await freshAdmin(browser)
  await settingsPage()
  const r = row(adminPage, 'Maintenance mode')
  await expect(r).toContainText('Forced on by the operator')
  await expect(r.getByRole('checkbox')).toHaveCount(0)
  const refused = cli(['maintenance', 'off'], { DBLOOM_MAINTENANCE: 'true' })
  expect(refused.code).toBe(1)
  expect(refused.out).toContain('forced on by DBLOOM_MAINTENANCE')
  const ben = await userAttempt(browser, 'ben')
  await expect(ben.page.getByRole('alert')).toHaveText(MAINTENANCE_REFUSED)
  await ben.context.close()
  await server.restart(EXTRAS)
  await freshAdmin(browser)
  await settingsPage()
  await expect(adminPage.getByRole('complementary', { name: 'Maintenance' })).toHaveCount(0)
})

test('the CLI keeps the locks and limits: a locked or environment-only setting cannot be reset', async () => {
  const locked = cli(['settings', 'reset', 'sessionsPerUser'])
  expect(locked.code).toBe(1)
  expect(locked.out).toContain('settings_locked')
  expect(cli(['settings', 'reset', 'totpWindow']).code).toBe(1)
  expect(cli(['settings', 'reset', 'nope']).out).toContain('No setting named "nope".')
  expect(cli(['settings', 'list']).out).toMatch(/^sessionsPerUser\s+5\s+\(built in, locked\)/m)
})
