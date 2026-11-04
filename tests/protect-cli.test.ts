/** SPEC/33 task 4: `dbloom settings pending`, and `settings reset` closing the pending change of its key. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/server/auth/cli/main'
import { openSqliteStore } from '../src/server/store/sqlite-store'
import { CLI_USAGE } from '../src/server/auth/cli/commands'
import type { AuthSettingKey, PendingSetting } from '../src/server/auth/types'

let dir: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-protcli-'))
  env = { DBLOOM_DATA_DIR: dir }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const withStore = <T>(fn: (s: ReturnType<typeof openSqliteStore>) => T): T => {
  const s = openSqliteStore(join(dir, 'dbloom.db'))
  try {
    return fn(s)
  } finally {
    s.close()
  }
}
const seedPending = (key: AuthSettingKey, value: number, over: Partial<PendingSetting> = {}) =>
  withStore((s) => {
    s.accounts.setSetting({ key, value: JSON.stringify(value), updatedAt: 50, updatedBy: 'a1' })
    s.accounts.upsertPending({ key, revertTo: null, newValue: JSON.stringify(value), newUpdatedAt: 50, actor: 'a1', createdAt: 50, deadlineAt: Date.parse('2030-01-02T03:04:05.000Z'), status: 'pending', ...over })
  })
const statuses = () => withStore((s) => s.accounts.getPendingSettings().map((p) => `${p.key}:${p.status}`))
async function run(...argv: string[]) {
  let out = ''
  const code = await main(argv, env, (t) => void (out += t))
  return { code, out }
}

describe('settings pending', () => {
  it('says so when nothing is waiting', async () => {
    expect(await run('settings', 'pending')).toEqual({ code: 0, out: 'No change is waiting for confirmation.\n' })
  })

  it('lists the waiting changes with value, deadline and who changed them', async () => {
    seedPending('loginFailures', 7)
    const r = await run('settings', 'pending')
    expect(r.code).toBe(0)
    expect(r.out).toContain('loginFailures')
    expect(r.out).toContain('now 7')
    expect(r.out).toContain('2030-01-02T03:04:05.000Z')
    expect(r.out).toContain('changed by a1')
  })

  it('does not list resolved changes', async () => {
    seedPending('loginFailures', 7, { status: 'pending' })
    withStore((s) => s.accounts.resolvePending('loginFailures', 'confirmed'))
    expect((await run('settings', 'pending')).out).toBe('No change is waiting for confirmation.\n')
  })

  it('refuses extra arguments and is listed in the usage', async () => {
    expect((await run('settings', 'pending', 'x')).code).toBe(2)
    expect(CLI_USAGE).toContain('settings pending')
  })
})

describe('settings reset and a pending change', () => {
  it('resets the key at once, with no auto-revert of its own, and closes the pending row', async () => {
    seedPending('loginFailures', 7)
    const r = await run('settings', 'reset', 'loginFailures')
    expect(r).toEqual({ code: 0, out: 'Setting loginFailures was reset.\n' })
    expect(withStore((s) => s.accounts.getSettings())).toEqual([])
    expect(statuses()).toEqual(['loginFailures:superseded'])
  })

  it('leaves other pending changes alone', async () => {
    seedPending('loginFailures', 7)
    seedPending('mfaGraceMs', 3 * 86_400_000)
    await run('settings', 'reset', 'loginFailures')
    expect(statuses().sort()).toEqual(['loginFailures:superseded', 'mfaGraceMs:pending'])
  })

  it('a reset of an unguarded key creates no pending row', async () => {
    withStore((s) => s.accounts.setSetting({ key: 'sessionsPerUser', value: '3', updatedAt: 5, updatedBy: 'x' }))
    await run('settings', 'reset', 'sessionsPerUser')
    expect(statuses()).toEqual([])
  })

  it('a guarded key reset from the CLI is not pending (the owner is the recovery path)', async () => {
    withStore((s) => s.accounts.setSetting({ key: 'loginFailures', value: '8', updatedAt: 5, updatedBy: 'x' }))
    await run('settings', 'reset', 'loginFailures')
    expect(statuses()).toEqual([])
  })
})
