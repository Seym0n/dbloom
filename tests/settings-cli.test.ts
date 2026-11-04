/** SPEC/32 task 3: `dbloom settings list`, `settings reset <key>`, `maintenance off` against a real store. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/server/auth/cli/main'
import { openSqliteStore } from '../src/server/store/sqlite-store'
import type { AuthSettingKey } from '../src/server/auth/types'
import { CLI_USAGE } from '../src/server/auth/cli/commands'

let dir: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-setcli-'))
  env = { DBLOOM_DATA_DIR: dir }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const seed = (key: AuthSettingKey, value: unknown, at = 5) => {
  const s = openSqliteStore(join(dir, 'dbloom.db'))
  s.accounts.setSetting({ key, value: JSON.stringify(value), updatedAt: at, updatedBy: 'seed' })
  s.close()
}
const stored = () => {
  const s = openSqliteStore(join(dir, 'dbloom.db'))
  const rows = s.accounts.getSettings().map((r) => r.key)
  s.close()
  return rows
}
async function run(...argv: string[]) {
  let out = ''
  const code = await main(argv, env, (s) => void (out += s))
  return { code, out }
}

describe('settings list', () => {
  it('prints every setting with effective value, source, lock and a differing stored value', async () => {
    seed('mfaGraceMs', 5 * 86_400_000)
    seed('sessionsPerUser', 3)
    env.DBLOOM_MFA_GRACE_DAYS = '2'
    env.DBLOOM_SETTINGS_LOCK = 'sessionsPerUser'
    const { code, out } = await run('settings', 'list')
    expect(code).toBe(0)
    const line = (key: string) => out.split('\n').find((l) => l.startsWith(`${key} `)) ?? ''
    expect(line('loginFailures')).toContain('5')
    expect(line('loginFailures')).toContain('(built in)')
    expect(line('mfaGraceMs')).toContain(String(2 * 86_400_000))
    expect(line('mfaGraceMs')).toContain(`stored ${5 * 86_400_000}`)
    expect(line('mfaGraceMs')).toContain('limit')
    expect(line('sessionsPerUser')).toContain('locked')
    expect(line('loginAutofocus')).toBe('') // per-user preference, not a site setting
  })

  it('shows no secret from the environment', async () => {
    env.DBLOOM_SECRET_KEY = 'sUpErSeCrEt-key-value-1234567890'
    env.DBLOOM_SETUP_TOKEN = 'tok-abcdef-0123456789'
    const { out } = await run('settings', 'list')
    expect(out).not.toContain('sUpErSeCrEt')
    expect(out).not.toContain('tok-abcdef')
  })

  it('refuses extra arguments with the usage text', async () => {
    expect(await run('settings', 'list', 'x')).toEqual({ code: 2, out: `${CLI_USAGE}\n` })
    expect((await run('settings')).code).toBe(2)
  })
})

describe('settings reset', () => {
  it('removes the stored value and says so; a second call says there was none', async () => {
    seed('loginFailures', 8)
    expect(await run('settings', 'reset', 'loginFailures')).toEqual({ code: 0, out: 'Setting loginFailures was reset.\n' })
    expect(stored()).toEqual([])
    expect(await run('settings', 'reset', 'loginFailures')).toEqual({ code: 0, out: 'Setting loginFailures had no stored value.\n' })
  })

  it('keeps every lock and limit: locked, env-only and unknown keys are refused', async () => {
    seed('sessionsPerUser', 3)
    env.DBLOOM_SETTINGS_LOCK = 'sessionsPerUser'
    expect(await run('settings', 'reset', 'sessionsPerUser')).toEqual({ code: 1, out: 'Setting sessionsPerUser cannot be reset: settings_locked (locked).\n' })
    expect(stored()).toEqual(['sessionsPerUser'])
    expect((await run('settings', 'reset', 'totpWindow')).code).toBe(1)
    expect(await run('settings', 'reset', 'nope')).toEqual({ code: 1, out: 'No setting named "nope".\n' })
  })

  it('needs exactly one key', async () => {
    expect((await run('settings', 'reset')).code).toBe(2)
    expect((await run('settings', 'reset', 'a', 'b')).code).toBe(2)
  })
})

describe('maintenance off', () => {
  it('removes the stored switch', async () => {
    seed('maintenanceOn', true)
    const r = await run('maintenance', 'off')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Maintenance mode is off')
    expect(stored()).toEqual([])
  })

  it('says so when it was never switched on from the page', async () => {
    expect(await run('maintenance', 'off')).toEqual({ code: 0, out: 'Maintenance mode was not switched on from the settings page.\n' })
  })

  it('a locked switch is refused, never silently skipped', async () => {
    seed('maintenanceOn', true)
    env.DBLOOM_SETTINGS_LOCK = 'maintenanceOn'
    expect((await run('maintenance', 'off')).code).toBe(1)
    expect(stored()).toEqual(['maintenanceOn'])
  })

  it('when DBLOOM_MAINTENANCE forces it on the command says so and changes nothing', async () => {
    seed('maintenanceOn', true)
    env.DBLOOM_MAINTENANCE = 'true'
    expect(await run('maintenance', 'off')).toEqual({ code: 1, out: 'Maintenance mode is forced on by DBLOOM_MAINTENANCE. Unset it and restart DBLoom.\n' })
    expect(stored()).toEqual(['maintenanceOn'])
  })

  it('takes no arguments and only `off`', async () => {
    expect((await run('maintenance')).code).toBe(2)
    expect((await run('maintenance', 'on')).code).toBe(2)
    expect((await run('maintenance', 'off', 'now')).code).toBe(2)
  })
})

describe('help', () => {
  it('the usage text lists the three commands', () => {
    for (const c of ['settings list', 'settings reset <key>', 'maintenance off']) expect(CLI_USAGE).toContain(c)
  })
})
