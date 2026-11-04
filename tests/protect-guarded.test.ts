/** SPEC/33 task 2: guarded set, describe flags, pending_settings storage, migration 8, autoRevertMs. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { AUTH_SETTINGS, AUTH_SETTING_KEYS, MINUTE_MS, type AuthSettingKey, type PendingSetting } from '~/server/auth/types'
import { GUARDED_KEYS, isGuardedKey } from '~/server/settings-guard'
import settingsTexts from '~/i18n/settings.json'

let dir: string
let store: SqliteStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-protect-'))
  store = openSqliteStore(join(dir, 'store.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const pendingRow = (over: Partial<PendingSetting> = {}): PendingSetting => ({
  key: 'loginFailures', revertTo: '5', newValue: '3', newUpdatedAt: 100, actor: 'u1', createdAt: 100, deadlineAt: 400_000, status: 'pending', ...over,
})

describe('guarded set (FR-APR-003)', () => {
  it('names ten registry keys, all editable through the UI', () => {
    expect(GUARDED_KEYS).toHaveLength(10)
    for (const key of GUARDED_KEYS) {
      expect(AUTH_SETTING_KEYS as string[], key).toContain(key)
      expect(AUTH_SETTINGS[key as AuthSettingKey].source, key).toBe('ui_within_env')
    }
  })

  it('marks exactly the guarded keys in describe()', () => {
    const described = createAuthSettingsResolver(store.accounts, {}).describe()
    for (const d of described) expect(d.guarded, d.key).toBe(isGuardedKey(d.key))
    expect(described.filter((d) => d.guarded).map((d) => d.key).sort()).toEqual([...GUARDED_KEYS].sort())
  })
})

describe('pending_settings (migration 8)', () => {
  it('is migration 8 and a store at version 7 upgrades', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(8)
    store.close()
    const db = new DatabaseSync(join(dir, 'store.db'))
    db.exec('DROP TABLE pending_settings; PRAGMA user_version = 7')
    db.close()
    store = openSqliteStore(join(dir, 'store.db'))
    store.accounts.upsertPending(pendingRow())
    expect(store.accounts.getPendingSettings()).toHaveLength(1)
  })

  it('stores, lists by status and resolves atomically', () => {
    store.accounts.upsertPending(pendingRow())
    expect(store.accounts.getPendingSettings('pending')[0]).toMatchObject({ key: 'loginFailures', revertTo: '5', newValue: '3', status: 'pending' })
    expect(store.accounts.resolvePending('loginFailures', 'reverted')).toBe(true)
    expect(store.accounts.resolvePending('loginFailures', 'confirmed')).toBe(false)
    expect(store.accounts.getPendingSettings('pending')).toEqual([])
    expect(store.accounts.getPendingSettings('reverted')).toHaveLength(1)
  })

  it('a second change while pending keeps revertTo and createdAt, moves value and deadline', () => {
    store.accounts.upsertPending(pendingRow())
    store.accounts.upsertPending(pendingRow({ revertTo: '3', newValue: '4', newUpdatedAt: 200, createdAt: 200, deadlineAt: 500_000 }))
    expect(store.accounts.getPendingSettings()).toEqual([
      expect.objectContaining({ revertTo: '5', createdAt: 100, newValue: '4', newUpdatedAt: 200, deadlineAt: 500_000, status: 'pending' }),
    ])
  })

  it('a change after a resolved one starts fresh', () => {
    store.accounts.upsertPending(pendingRow())
    store.accounts.resolvePending('loginFailures', 'confirmed')
    store.accounts.upsertPending(pendingRow({ revertTo: '3', newValue: '8', createdAt: 900, deadlineAt: 1_200_000 }))
    expect(store.accounts.getPendingSettings()).toEqual([expect.objectContaining({ revertTo: '3', createdAt: 900, status: 'pending' })])
  })

  it('a null revert target is kept as null', () => {
    store.accounts.upsertPending(pendingRow({ revertTo: null }))
    expect(store.accounts.getPendingSettings()[0]!.revertTo).toBeNull()
  })

  it('always writes status pending on upsert', () => {
    expect(() => store.accounts.upsertPending(pendingRow({ status: 'bogus' as never }))).not.toThrow()
    expect(store.accounts.getPendingSettings()[0]!.status).toBe('pending')
  })
})

describe('describe() pending (FR-APR-012)', () => {
  it('shows the pending change of a key and none after it is resolved', () => {
    store.accounts.upsertPending(pendingRow({ newValue: '3', deadlineAt: 777, actor: 'u1' }))
    const find = () => createAuthSettingsResolver(store.accounts, {}).describe().find((d) => d.key === 'loginFailures')!
    expect(find().pending).toEqual({ newValue: 3, deadlineAt: 777, actor: 'u1' })
    expect(createAuthSettingsResolver(store.accounts, {}).describe().find((d) => d.key === 'mfaScope')!.pending).toBeNull()
    store.accounts.resolvePending('loginFailures', 'confirmed')
    expect(find().pending).toBeNull()
  })
})

describe('autoRevertMs (ST-035)', () => {
  const resolve = (env: NodeJS.ProcessEnv = {}) => createAuthSettingsResolver(store.accounts, env).resolve().autoRevertMs
  it('defaults to 5 minutes', () => expect(resolve()).toBe(5 * MINUTE_MS))
  it('takes minutes from DBLOOM_AUTOREVERT_MINUTES within 1 to 15', () => {
    expect(resolve({ DBLOOM_AUTOREVERT_MINUTES: '1' })).toBe(MINUTE_MS)
    expect(resolve({ DBLOOM_AUTOREVERT_MINUTES: '15' })).toBe(15 * MINUTE_MS)
  })
  it('clamps outside the range, so a value of 0 never removes the net', () => {
    expect(resolve({ DBLOOM_AUTOREVERT_MINUTES: '0' })).toBe(MINUTE_MS)
    expect(resolve({ DBLOOM_AUTOREVERT_MINUTES: '99' })).toBe(15 * MINUTE_MS)
  })
  it('is env-only: shown, never editable, with a label', () => {
    const d = createAuthSettingsResolver(store.accounts, {}).describe().find((x) => x.key === 'autoRevertMs')!
    expect(d.editable).toBe(false)
    expect((settingsTexts as Record<string, string>)['settings.key.autoRevertMs']).toBeTruthy()
  })
})
