import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuthSettingsResolver } from '../src/server/auth/settings'
import { AUTH_SETTING_KEYS } from '../src/server/auth/types'
import { loadConfig } from '../src/server/config'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

let dir: string
let store: SqliteStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-notices-cfg-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv

describe('startup', () => {
  it('defaults 10, 10 and 90', () => {
    expect(loadConfig(env({}))).toMatchObject({ noticeBurstFailures: 10, noticeBurstMinutes: 10, noticeLocationDays: 90 })
  })
  it.each([
    ['DBLOOM_NOTICE_BURST_FAILURES', ['3', '20'], ['2', '21', 'x']],
    ['DBLOOM_NOTICE_BURST_MINUTES', ['1', '60'], ['0', '61']],
    ['DBLOOM_NOTICE_LOCATION_DAYS', ['7', '365'], ['6', '366']],
  ] as const)('%s accepts its range ends and refuses outside', (name, good, bad) => {
    for (const v of good) expect(() => loadConfig(env({ [name]: v }))).not.toThrow()
    for (const v of bad) expect(() => loadConfig(env({ [name]: v }))).toThrow(new RegExp(name))
  })
})

describe('setting keys', () => {
  it('exist with the spec ranges and default', () => {
    expect(AUTH_SETTING_KEYS).toEqual(expect.arrayContaining(['noticeBurstFailures', 'noticeBurstMinutes', 'noticeLocationDays']))
    const s = createAuthSettingsResolver(store.accounts, {}).resolve()
    expect(s).toMatchObject({ noticeBurstFailures: 10, noticeBurstMinutes: 10, noticeLocationDays: 90 })
  })
  it('the environment sets the value and the resolver clamps it into the range', () => {
    const s = createAuthSettingsResolver(store.accounts, env({ DBLOOM_NOTICE_BURST_FAILURES: '5', DBLOOM_NOTICE_BURST_MINUTES: '30', DBLOOM_NOTICE_LOCATION_DAYS: '1000' })).resolve()
    expect(s).toMatchObject({ noticeBurstFailures: 5, noticeBurstMinutes: 30, noticeLocationDays: 365 })
  })
})
