/** SPEC/33 task 3: apply and arm, confirm, cancel, revert, superseded, timer, restart, audit order. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { createSettingsWriter, SettingsError, type SettingsWriter } from '~/server/auth/settings-write'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createPendingSettings, type PendingAuditEvent, type PendingSettings, type PendingTimers } from '~/server/settings-pending'
import { isAuditEvent } from '~/server/audit/events'
import { MINUTE_MS, type AuthSettingKey } from '~/server/auth/types'

const FIVE = 5 * MINUTE_MS
let dir: string
let store: SqliteStore
let clock: number
let audits: { event: string; fields: Record<string, unknown>; stored: string | undefined }[]
let bestEffort: { event: string; fields: Record<string, unknown> }[]
let changedCalls: number
let failAudit: boolean
let bestEffortThrows: boolean
let reported: number
let timerSet: { fn: () => void; ms: number }[]
let timerCleared: number

const stored = (key: AuthSettingKey) => store.accounts.getSettings().find((s) => s.key === key)?.value
const timers: PendingTimers = {
  set: (fn, ms) => {
    timerSet.push({ fn, ms })
    return timerSet.length
  },
  clear: () => void timerCleared++,
}

function make(over: { guard?: boolean; env?: NodeJS.ProcessEnv } = {}): { writer: SettingsWriter; pending: PendingSettings } {
  const pending = createPendingSettings({
    store: store.accounts,
    now: () => clock,
    timers,
    changed: () => void changedCalls++,
    onError: () => void reported++,
    audit: (event: PendingAuditEvent, fields) => {
      if (failAudit) throw new SettingsError('settings_audit_unavailable')
      audits.push({ event, fields, stored: stored(fields.setting as AuthSettingKey) })
    },
    auditBestEffort: (event, fields) => {
      if (bestEffortThrows) throw new Error('sink down')
      bestEffort.push({ event, fields })
    },
  })
  const writer = createSettingsWriter({
    store: store.accounts,
    env: over.env ?? {},
    now: () => clock,
    changed: () => void changedCalls++,
    armed: () => pending.schedule(),
    ...(over.guard !== undefined ? { guard: over.guard } : {}),
    audit: (event, fields) => {
      if (failAudit) throw new SettingsError('settings_audit_unavailable')
      audits.push({ event, fields, stored: stored(fields.setting as AuthSettingKey) })
    },
  })
  return { writer, pending }
}
const pendingRows = () => store.accounts.getPendingSettings()
const effective = (key: AuthSettingKey) => createAuthSettingsResolver(store.accounts, {}).describe().find((d) => d.key === key)!.effective

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-pending-'))
  store = openSqliteStore(join(dir, 'store.db'))
  clock = 10_000
  audits = []
  bestEffort = []
  changedCalls = 0
  failAudit = false
  bestEffortThrows = false
  reported = 0
  timerSet = []
  timerCleared = 0
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('apply and arm (FR-APR-006)', () => {
  it('applies a guarded change at once and records the way back with an absolute deadline', () => {
    const { writer } = make()
    writer.set('loginFailures', 7, null, 'u1')
    expect(JSON.parse(stored('loginFailures')!)).toBe(7)
    expect(pendingRows()).toEqual([
      { key: 'loginFailures', revertTo: null, newValue: '7', newUpdatedAt: 10_000, actor: 'u1', createdAt: 10_000, deadlineAt: 10_000 + FIVE, status: 'pending' },
    ])
  })

  it('takes the revert target from the stored value and the period from DBLOOM_AUTOREVERT_MINUTES', () => {
    const { writer } = make({ env: { DBLOOM_AUTOREVERT_MINUTES: '2' } })
    writer.set('loginFailures', 7, null, 'u1')
    store.accounts.resolvePending('loginFailures', 'confirmed')
    clock = 20_000
    writer.set('loginFailures', 8, store.accounts.getSettings()[0]!.updatedAt, 'u1')
    expect(pendingRows()[0]).toMatchObject({ revertTo: '7', newValue: '8', deadlineAt: 20_000 + 2 * MINUTE_MS, createdAt: 20_000 })
  })

  it('audits settings.pending with old, new and deadline before the store write', () => {
    const { writer } = make()
    writer.set('loginFailures', 7, null, 'u1')
    const row = audits.find((a) => a.event === 'settings.pending')!
    expect(row.fields).toMatchObject({ setting: 'loginFailures', old: '5', new: '7', deadlineAt: 10_000 + FIVE, actor: 'u1' })
    expect(row.stored).toBeUndefined()
    expect(isAuditEvent('settings.pending')).toBe(true)
  })

  it('a failing audit leaves neither value nor pending row', () => {
    const { writer } = make()
    failAudit = true
    expect(() => writer.set('loginFailures', 7, null, 'u1')).toThrow()
    expect(stored('loginFailures')).toBeUndefined()
    expect(pendingRows()).toEqual([])
  })

  it('a second change keeps the first revert target and moves the deadline', () => {
    const { writer } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock = 60_000
    writer.set('loginFailures', 9, store.accounts.getSettings()[0]!.updatedAt, 'u2')
    expect(pendingRows()).toEqual([expect.objectContaining({ revertTo: null, newValue: '9', actor: 'u2', createdAt: 10_000, deadlineAt: 60_000 + FIVE })])
  })

  it('an unguarded key, or a writer with guard off (CLI), leaves no pending row', () => {
    make().writer.set('sessionsPerUser', 6, null, 'u1')
    make({ guard: false }).writer.set('loginFailures', 7, null, 'cli')
    expect(pendingRows()).toEqual([])
  })

  it('a reset of a guarded key is pending too and expects no row', () => {
    const { writer } = make()
    store.accounts.setSetting({ key: 'loginFailures', value: '8', updatedAt: 5_000, updatedBy: 'u0' })
    writer.reset('loginFailures', 5_000, 'u1')
    expect(stored('loginFailures')).toBeUndefined()
    expect(pendingRows()).toEqual([expect.objectContaining({ revertTo: '8', newUpdatedAt: 0, newValue: '5' })])
  })

  it('arms the timer for the deadline after a guarded commit', () => {
    make().writer.set('loginFailures', 7, null, 'u1')
    expect(timerSet.map((t) => t.ms)).toEqual([FIVE])
  })
})

describe('revert (FR-APR-009)', () => {
  it('does nothing before the deadline and restores the stored value after it', () => {
    const { writer, pending } = make()
    store.accounts.setSetting({ key: 'loginFailures', value: '4', updatedAt: 5_000, updatedBy: 'u0' })
    writer.set('loginFailures', 7, 5_000, 'u1')
    clock = 10_000 + FIVE - 1
    expect(pending.sweep()).toBe(0)
    expect(effective('loginFailures')).toBe(7)
    clock = 10_000 + FIVE
    changedCalls = 0
    expect(pending.sweep()).toBe(1)
    expect(effective('loginFailures')).toBe(4)
    expect(store.accounts.getPendingSettings('reverted')).toHaveLength(1)
    expect(changedCalls).toBe(1)
    expect(bestEffort).toEqual([{ event: 'settings.revert', fields: expect.objectContaining({ setting: 'loginFailures', old: '7', new: '4', actor: 'system', requestedBy: 'u1' }) }])
  })

  it('a null target deletes the stored value', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock += FIVE
    pending.sweep()
    expect(stored('loginFailures')).toBeUndefined()
    expect(effective('loginFailures')).toBe(5)
  })

  it('reverting a reset puts the old value back', () => {
    const { writer, pending } = make()
    store.accounts.setSetting({ key: 'loginFailures', value: '8', updatedAt: 5_000, updatedBy: 'u0' })
    writer.reset('loginFailures', 5_000, 'u1')
    clock += FIVE
    pending.sweep()
    expect(JSON.parse(stored('loginFailures')!)).toBe(8)
  })

  it('the restored row is newer than the guarded one, so an open editor sees a conflict', () => {
    const { writer, pending } = make()
    store.accounts.setSetting({ key: 'loginFailures', value: '4', updatedAt: 5_000, updatedBy: 'u0' })
    writer.set('loginFailures', 7, 5_000, 'u1')
    const guardedAt = store.accounts.getSettings()[0]!.updatedAt
    clock += FIVE
    pending.sweep()
    expect(store.accounts.getSettings()[0]!.updatedAt).toBeGreaterThan(guardedAt)
  })

  it('is superseded, not reverted, when the row changed after the guarded change', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    store.accounts.setSetting({ key: 'loginFailures', value: '9', updatedAt: 99_999, updatedBy: 'cli' })
    clock += FIVE
    expect(pending.sweep()).toBe(0)
    expect(JSON.parse(stored('loginFailures')!)).toBe(9)
    expect(store.accounts.getPendingSettings('superseded')).toHaveLength(1)
    expect(bestEffort).toEqual([])
  })

  it('a double sweep reverts once', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock += FIVE
    expect(pending.sweep() + pending.sweep()).toBe(1)
    expect(bestEffort).toHaveLength(1)
  })

  it('does not depend on the required audit: it still reverts when that write would fail', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    failAudit = true
    clock += FIVE
    expect(pending.sweep()).toBe(1)
    expect(stored('loginFailures')).toBeUndefined()
  })
})

describe('confirm (FR-APR-007)', () => {
  it('refuses a session older than the change, accepts a later one, then the change stays', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock = 12_000
    expect(() => pending.confirm('loginFailures', 9_999, 'u1')).toThrow(expect.objectContaining({ code: 'settings_confirm_session' }))
    expect(pendingRows()[0]!.status).toBe('pending')
    pending.confirm('loginFailures', 11_000, 'u1')
    expect(store.accounts.getPendingSettings('confirmed')).toHaveLength(1)
    expect(audits.at(-1)).toMatchObject({ event: 'settings.confirm', fields: expect.objectContaining({ setting: 'loginFailures', actor: 'u1' }) })
    clock += 10 * FIVE
    pending.sweep()
    expect(effective('loginFailures')).toBe(7)
  })

  it('a session created in the same millisecond as the change may confirm', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    pending.confirm('loginFailures', 10_000, 'u1')
    expect(store.accounts.getPendingSettings('confirmed')).toHaveLength(1)
  })

  it('answers settings_no_pending for a key with nothing pending', () => {
    const { pending } = make()
    expect(() => pending.confirm('loginFailures', 99, 'u1')).toThrow(expect.objectContaining({ code: 'settings_no_pending' }))
  })

  it('after the deadline the sweep wins: the change is reverted and confirming says no_pending', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock += FIVE
    expect(() => pending.confirm('loginFailures', clock, 'u1')).toThrow(expect.objectContaining({ code: 'settings_no_pending' }))
    expect(effective('loginFailures')).toBe(5)
  })

  it('a failing audit leaves it pending', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    failAudit = true
    expect(() => pending.confirm('loginFailures', 11_000, 'u1')).toThrow(expect.objectContaining({ code: 'settings_audit_unavailable' }))
    expect(pendingRows()[0]!.status).toBe('pending')
  })
})

describe('cancel and supersede (FR-APR-008, 013)', () => {
  it('reverts at once and audits settings.cancel', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    expect(pending.cancel('loginFailures', 'u1')).toBe('reverted')
    expect(effective('loginFailures')).toBe(5)
    expect(store.accounts.getPendingSettings('cancelled')).toHaveLength(1)
    expect(audits.at(-1)).toMatchObject({ event: 'settings.cancel', fields: expect.objectContaining({ setting: 'loginFailures', old: '7', new: 'default', actor: 'u1' }) })
    expect(bestEffort).toEqual([])
  })

  it('a failing audit changes nothing; nothing pending answers no_pending', () => {
    const { writer, pending } = make()
    expect(() => pending.cancel('loginFailures', 'u1')).toThrow(expect.objectContaining({ code: 'settings_no_pending' }))
    writer.set('loginFailures', 7, null, 'u1')
    failAudit = true
    expect(() => pending.cancel('loginFailures', 'u1')).toThrow()
    expect(effective('loginFailures')).toBe(7)
    expect(pendingRows()[0]!.status).toBe('pending')
  })

  it('supersede closes the row without touching the value', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    pending.supersede('loginFailures')
    expect(store.accounts.getPendingSettings('superseded')).toHaveLength(1)
    expect(effective('loginFailures')).toBe(7)
  })
})

describe('timer, boot sweep and restart (FR-APR-010)', () => {
  it('the timer fires the sweep and reverts', () => {
    const { writer } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock += FIVE
    timerSet.at(-1)!.fn()
    expect(effective('loginFailures')).toBe(5)
  })

  it('arms the nearest remaining deadline and stops arming when none is left', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock += 60_000
    writer.set('adminSessionIdleMs', 20 * MINUTE_MS, null, 'u1')
    expect(timerSet.at(-1)!.ms).toBe(FIVE - 60_000)
    pending.cancel('loginFailures', 'u1')
    expect(timerSet.at(-1)!.ms).toBe(FIVE)
    pending.cancel('adminSessionIdleMs', 'u1')
    const armed = timerSet.length
    pending.schedule()
    expect(timerSet.length).toBe(armed)
  })

  it('a restart keeps the original deadline: a new manager re-arms with the remaining time', () => {
    make().writer.set('loginFailures', 7, null, 'u1')
    clock += 100_000
    timerSet = []
    const { pending } = make()
    expect(pending.sweep()).toBe(0)
    expect(timerSet.at(-1)!.ms).toBe(FIVE - 100_000)
    expect(effective('loginFailures')).toBe(7)
  })

  it('a change that expired while the process was down is reverted at boot', () => {
    make().writer.set('loginFailures', 7, null, 'u1')
    clock += 3 * FIVE
    const { pending } = make()
    expect(pending.sweep()).toBe(1)
    expect(effective('loginFailures')).toBe(5)
  })

  it('a timer sweep that throws is reported and the next timer is armed', () => {
    const { writer } = make()
    writer.set('loginFailures', 7, null, 'u1')
    clock += FIVE
    bestEffortThrows = true
    const armed = timerSet.length
    timerSet.at(-1)!.fn()
    expect(reported).toBe(1)
    expect(effective('loginFailures')).toBe(5)
    expect(timerSet.length).toBe(armed) // nothing pending is left, so no further timer
  })

  it('stop clears the timer', () => {
    const { writer, pending } = make()
    writer.set('loginFailures', 7, null, 'u1')
    const before = timerCleared
    pending.stop()
    expect(timerCleared).toBe(before + 1)
  })
})
