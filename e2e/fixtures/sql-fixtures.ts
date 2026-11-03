import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { APIResponse, Locator, Page, Request } from '@playwright/test'
import {
  expandDatabase,
  expect,
  randomName,
  sidebar,
  signIn,
  test,
  type Scratch,
} from './scratch-db'

export { expect, signIn, sidebar, expandDatabase }
export { sqlTest as test }
export type { Scratch }

/** Servers started by playwright.config.ts besides the default one on port 3100. */
export const READ_ONLY_URL = 'http://localhost:3101'
/** 2 s statement timeout and 1 000 row cap (DBLOOM_STATEMENT_TIMEOUT_SECONDS, DBLOOM_SQL_ROW_CAP). */
export const LIMITS_URL = 'http://localhost:3102'
export const LIMITS_ROW_CAP = 1000
export const LIMITS_TIMEOUT_S = 2

export const editorOf = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' })
export const runButton = (page: Page) => page.getByRole('button', { name: /^Run( selection)?$/ })
export const resultsOf = (page: Page) => page.getByRole('region', { name: 'Results', exact: true })
export const dbSelect = (page: Page) =>
  page.getByRole('combobox', { name: 'Database', exact: true })
export const cancelButton = (page: Page) => page.getByRole('button', { name: /^Cancel/ })
export const confirmDialog = (page: Page) => page.getByRole('dialog')

/** Replaces the editor text. Newlines in `text` are typed as real line breaks. */
export async function setSql(page: Page, text: string) {
  const editor = editorOf(page)
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (line !== '') await page.keyboard.insertText(line)
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter')
  }
}

/** The text currently in the editor, lines joined with \n. */
export async function sqlText(page: Page) {
  return (await editorOf(page).locator('.cm-line').allInnerTexts()).join('\n')
}

/** Opens a SQL tab on `db` from the sidebar. */
export async function openSql(page: Page, db: string) {
  await expandDatabase(page, db)
  await sidebar(page)
    .getByRole('button', { name: `New SQL tab on ${db}`, exact: true })
    .click()
  await expect(editorOf(page)).toBeVisible()
  await expect(dbSelect(page)).toHaveValue(db)
}

/** Types `text` and presses the Run button. Does not wait for the result. */
export async function run(page: Page, text: string) {
  await setSql(page, text)
  await page.keyboard.press('Escape') // closes a completion popup that would swallow the click
  await runButton(page).click()
}

/** Types, runs and waits until the run finished (the Run button is back and a result is shown). */
export async function runAndWait(page: Page, text: string) {
  await run(page, text)
  await expect(resultsOf(page)).toBeVisible()
  await expect(runButton(page)).toBeVisible()
}

/**
 * Confirms the dialog that asks before a run: waits for it, ticks the acknowledgement of a hard dialog
 * and presses "Run anyway" (hard) or "Run" (soft).
 */
export async function confirmHard(page: Page) {
  const dialog = confirmDialog(page)
  await expect(dialog).toBeVisible()
  const ack = dialog.getByRole('checkbox')
  if ((await ack.count()) > 0) await ack.check()
  await dialog.getByRole('button', { name: /^Run( anyway)?$/ }).click()
  await expect(dialog).toBeHidden()
}

/** Run, then confirm the dialog and wait for the result. */
export async function runConfirmed(page: Page, text: string) {
  await run(page, text)
  await confirmHard(page)
  await expect(resultsOf(page)).toBeVisible()
  await expect(runButton(page)).toBeVisible()
}

export const gridOf = (scope: Locator | Page) => scope.getByRole('grid', { name: 'Result rows' })

export async function openRunOptions(page: Page) {
  const button = page.getByRole('button', { name: 'Options' })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  return page.getByRole('dialog', { name: 'Options' })
}

export async function setRunOption(page: Page, label: string, on: boolean) {
  const panel = await openRunOptions(page)
  await panel.getByRole('checkbox', { name: label }).setChecked(on)
  await page.keyboard.press('Escape')
}

/** Number of rows the grid reports through aria-rowcount (header included in the attribute, removed here). */
export async function gridRowCount(grid: Locator) {
  return Number(await grid.getAttribute('aria-rowcount')) - 1
}

// ---- Server state helpers --------------------------------------------------------------------------

export const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``

/** Fills `table` (id INT PRIMARY KEY, name VARCHAR(40)) with `rows` rows `row 1` ... in batches. */
export async function seedRows(scratch: Scratch, table: string, rows: number) {
  await scratch.q(
    `CREATE TABLE ${quote(scratch.name)}.${quote(table)} (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)`,
  )
  for (let from = 1; from <= rows; from += 2000) {
    const batch: [number, string][] = []
    for (let id = from; id < from + 2000 && id <= rows; id++) batch.push([id, `row ${id}`])
    await scratch.q(`INSERT INTO ${quote(scratch.name)}.${quote(table)} VALUES ?`, [batch])
  }
}

export async function countRows(scratch: Scratch, table: string) {
  const [row] = await scratch.q<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${quote(scratch.name)}.${quote(table)}`,
  )
  return Number(row?.n)
}

/** Threads of other connections that currently run a statement containing `needle`. */
export async function threadsRunning(scratch: Scratch, needle: string) {
  const rows = await scratch.q<{ Id: number; Info: string | null }>('SHOW FULL PROCESSLIST')
  return rows.filter((r) => r.Info?.includes(needle) && !r.Info.startsWith('SHOW FULL PROCESSLIST'))
}

export type Owner = { user: string; password: string }

type SqlFixtures = {
  /** Creates users with all privileges on the scratch database; removed after the test. */
  newOwner: (extraGrants?: string[]) => Promise<Owner>
}

/**
 * `test` of the scratch fixtures plus `newOwner`. History and bookmarks are keyed by target and user
 * name, so a fresh user starts with empty lists whatever earlier tests did.
 */
export const sqlTest = test.extend<SqlFixtures>({
  newOwner: async ({ scratch }, use) => {
    const users: string[] = []
    await use(async (extraGrants = []) => {
      const user = randomName('e2e_lim_')
      const password = randomBytes(9).toString('hex')
      users.push(user)
      await scratch.q('CREATE USER ?@? IDENTIFIED BY ?', [user, '%', password])
      await scratch.q(`GRANT ALL ON ${quote(scratch.name)}.* TO ?@?`, [user, '%'])
      for (const grant of extraGrants) await scratch.q(`GRANT ${grant} TO ?@?`, [user, '%'])
      return { user, password }
    })
    for (const user of users) await scratch.q('DROP USER IF EXISTS ?@?', [user, '%'])
  },
})

/**
 * Everything a page keeps in the browser: localStorage, sessionStorage, IndexedDB (all databases, all
 * object stores, serialised), cookies visible to scripts. Used to prove that no SQL text is stored.
 */
export async function browserStorageDump(page: Page): Promise<string> {
  const inPage = await page.evaluate(async () => {
    const parts: string[] = []
    const dump = (s: Storage) => {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i) as string
        parts.push(`${k}=${s.getItem(k)}`)
      }
    }
    try {
      dump(localStorage)
    } catch {
      // not available
    }
    try {
      dump(sessionStorage)
    } catch {
      // not available
    }
    parts.push(document.cookie)
    const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
    const dbs = (await idb.databases?.()) ?? []
    for (const info of dbs) {
      if (!info.name) continue
      parts.push(`idb:${info.name}`)
      await new Promise<void>((resolve) => {
        const open = indexedDB.open(info.name as string)
        open.onerror = () => resolve()
        open.onsuccess = () => {
          const db = open.result
          const names = Array.from(db.objectStoreNames)
          if (names.length === 0) {
            db.close()
            return resolve()
          }
          const tx = db.transaction(names, 'readonly')
          let pending = names.length
          for (const name of names) {
            const all = tx.objectStore(name).getAll()
            all.onsuccess = () => {
              try {
                parts.push(`${name}:${JSON.stringify(all.result)}`)
              } catch {
                parts.push(`${name}:<unserialisable>`)
              }
              if (--pending === 0) {
                db.close()
                resolve()
              }
            }
            all.onerror = () => {
              if (--pending === 0) {
                db.close()
                resolve()
              }
            }
          }
        }
      })
    }
    return parts.join('\n')
  })
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('\n')
  return `${inPage}\n${cookies}`
}

// ---- Extra DBLoom processes (restart and stateless scenarios) --------------------------------------------

export type DbloomProcess = { url: string; dataDir: string; stop: () => Promise<void> }

/**
 * Starts the built server (`.output/server/index.mjs`, built by the first webServer of the config) on
 * `port` with its own data directory, e.g. to restart it or to run it with `DBLOOM_STORE=none`.
 */
export async function startDbloom(
  port: number,
  options: { env?: Record<string, string>; dataDir?: string } = {},
): Promise<DbloomProcess> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'dbloom-e2e-'))
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
      DBLOOM_AUTO_SETUP: 'direct',
      DBLOOM_ALLOW_LOOPBACK: 'true',
      DBLOOM_TARGET_TLS: 'off',
      PORT: String(port),
      DBLOOM_DATA_DIR: dataDir,
      ...options.env,
    },
  })
  const url = `http://localhost:${port}`
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const stop = async () => {
    if (child.exitCode === null) child.kill()
    await exited
  }
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop()
      throw new Error(`DBLoom did not start on port ${port}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { url, dataDir, stop }
}

// ---- Server-function helpers (captured and forged requests) -----------------------------------------------

export type Captured = { url: string; headers: Record<string, string>; body: string }

/** Collects the POSTs of the page whose body contains all of `keys` (property names of the input). */
export function capture(page: Page, keys: string[]) {
  const seen: Captured[] = []
  page.on('request', (r: Request) => {
    const body = r.postData()
    if (r.method() !== 'POST' || !r.url().includes('/_serverFn/') || !body) return
    if (keys.every((k) => body.includes(`"${k}"`))) {
      seen.push({ url: r.url(), headers: r.headers(), body })
    }
  })
  return seen
}

type Node = { p?: { k: string[]; v: Node[] }; s?: unknown; [k: string]: unknown }

/** Edits the serialised input: finds the object that has property `key` and lets `edit` change it. */
export function editInput(
  body: string,
  key: string,
  edit: (obj: { k: string[]; v: Node[] }, at: number) => void,
) {
  const root = JSON.parse(body) as Node
  const visit = (n: unknown): boolean => {
    if (!n || typeof n !== 'object') return false
    const node = n as Node
    const at = node.p?.k.indexOf(key) ?? -1
    if (node.p && at >= 0) {
      edit(node.p, at)
      return true
    }
    for (const child of node.p?.v ?? []) if (visit(child)) return true
    return false
  }
  if (!visit(root.t)) throw new Error(`property ${key} not found in the request`)
  return JSON.stringify(root)
}

export const replaceString = (body: string, key: string, value: string) =>
  editInput(body, key, (o, at) => {
    o.v[at] = { t: 1, s: value } as unknown as Node
  })

export const dropProperty = (body: string, key: string) =>
  editInput(body, key, (o, at) => {
    o.k.splice(at, 1)
    o.v.splice(at, 1)
  })

export function forge(page: Page, c: Captured, body: string): Promise<APIResponse> {
  const headers = { ...c.headers }
  delete headers['content-length']
  delete headers['host']
  // A replay is not a browser request: add the Origin the gate requires on state-changing requests (FR-SVR-006).
  return page.request.post(c.url, { headers: { ...headers, origin: new URL(c.url).origin }, data: body })
}

export const succeeded = async (res: APIResponse) => (await res.text()).includes('"s":"done"')
