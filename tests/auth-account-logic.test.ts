import { describe, expect, it } from 'vitest'
import {
  PREF_META,
  applyTheme,
  groupPrefs,
  importReasonKey,
  isLastFactor,
  isStepUpRequired,
  isoDate,
  parseDraft,
  parseTags,
  prefMeta,
  recoveryLevel,
  relativeWhen,
  saveProblem,
  stepUpMethods,
  targetKeyOf,
  toDraft,
} from '../src/lib/auth/account-logic'
import { MOCK_PREF_DEFAULTS, mockValid } from '../src/lib/auth/mock-prefs'
import { t } from '../src/i18n'

const passkey = { id: 'a', name: 'n', backedUp: false, uvInitial: true, createdAt: 0, lastUsedAt: null }

describe('preference metadata', () => {
  it('has a label for every known key', () => {
    for (const key of Object.keys(PREF_META)) expect(t(`prefs.${key}` as never), key).not.toBe(undefined)
  })

  it('covers the same keys as the mock defaults', () => {
    expect(Object.keys(MOCK_PREF_DEFAULTS).sort()).toEqual(Object.keys(PREF_META).sort())
  })

  it('every mock default is valid for its own metadata', () => {
    for (const [key, value] of Object.entries(MOCK_PREF_DEFAULTS)) expect(mockValid(key, value), key).toBe(true)
  })

  it('infers a kind for a key a newer server adds', () => {
    expect(prefMeta('x.flag', true).kind).toBe('boolean')
    expect(prefMeta('x.n', 3).kind).toBe('number')
    expect(prefMeta('x.s', 'a').kind).toBe('text')
    expect(prefMeta('x.l', ['a']).kind).toBe('tags')
    expect(prefMeta('x.o', {}).kind).toBe('json')
  })

  it('groups by category in registry order, unknown keys last, empty groups dropped', () => {
    const groups = groupPrefs({ 'rows.pageSize': 50, zzz: 1, theme: 'system', navWidth: 244, 'io.dragDrop': true })
    expect(groups.map((g) => g.category)).toEqual(['features', 'navigation', 'main', 'import'])
    expect(groups.find((g) => g.category === 'main')!.keys).toEqual(['rows.pageSize', 'zzz'])
  })
})

describe('draft parsing', () => {
  const nav = PREF_META.navWidth!
  it('parses and range-checks integers', () => {
    expect(parseDraft(nav, '300')).toEqual({ ok: true, value: 300 })
    expect(parseDraft(nav, '100')).toEqual({ ok: false, reason: 'range' })
    expect(parseDraft(nav, '801')).toEqual({ ok: false, reason: 'range' })
    expect(parseDraft(nav, '3.5')).toEqual({ ok: false, reason: 'number' })
    expect(parseDraft(nav, 'abc')).toEqual({ ok: false, reason: 'number' })
    expect(parseDraft(nav, '  ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('allows decimals for plain numbers', () => {
    expect(parseDraft(PREF_META['io.uploadMiB']!, '12.5')).toEqual({ ok: true, value: 12.5 })
  })

  it('turns a list text into unique trimmed entries', () => {
    expect(parseTags('a, b,,a\n c ')).toEqual(['a', 'b', 'c'])
    expect(parseDraft(PREF_META.hiddenDatabases!, 'mysql, sys')).toEqual({ ok: true, value: ['mysql', 'sys'] })
  })

  it('an empty collation means none', () => {
    expect(parseDraft(PREF_META.collation!, ' ')).toEqual({ ok: true, value: null })
    expect(parseDraft(PREF_META.collation!, 'utf8mb4_bin')).toEqual({ ok: true, value: 'utf8mb4_bin' })
  })

  it('reports invalid JSON', () => {
    expect(parseDraft(PREF_META['rows.fkDisplay']!, '{')).toEqual({ ok: false, reason: 'json' })
    expect(parseDraft(PREF_META['rows.fkDisplay']!, '{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('round-trips a stored value through the draft text', () => {
    for (const [key, value] of Object.entries(MOCK_PREF_DEFAULTS)) {
      const meta = prefMeta(key, value)
      if (meta.kind === 'boolean' || meta.kind === 'select') continue
      expect(parseDraft(meta, toDraft(meta, value)), key).toEqual({ ok: true, value })
    }
  })
})

describe('save problems', () => {
  it('reads the prefs server errors', () => {
    expect(saveProblem(new Error('invalid-value: Invalid value'))).toBe('invalid')
    expect(saveProblem(new Error('save-failed: Preferences could not be saved'))).toBe('save')
    expect(saveProblem(new Error('session_ended'))).toBe('ended')
    expect(saveProblem(new Error('boom'))).toBe('other')
    expect(saveProblem(undefined)).toBe('other')
  })

  it('maps import reasons to messages', () => {
    expect(importReasonKey({ reason: 'unknown_key' })).toBe('account.import.reason.unknown_key')
    expect(importReasonKey({ reason: 'something new' })).toBe('account.import.reason.invalid_value')
  })
})

describe('security helpers', () => {
  it('recognises the step-up error in every transport form', () => {
    expect(isStepUpRequired(new Error(JSON.stringify({ code: 'stepup_required' })))).toBe(true)
    expect(isStepUpRequired(new Error('stepup_required'))).toBe(true)
    expect(isStepUpRequired(new Error('mfa_failed'))).toBe(false)
  })

  it('offers passkey, then TOTP, else the password', () => {
    expect(stepUpMethods({ passkeys: [passkey], totp: true })).toEqual(['passkey', 'totp'])
    expect(stepUpMethods({ passkeys: [], totp: true })).toEqual(['totp'])
    expect(stepUpMethods({ passkeys: [passkey], totp: false })).toEqual(['passkey'])
    expect(stepUpMethods({ passkeys: [], totp: false })).toEqual(['password'])
  })

  it('warns at two recovery codes or fewer', () => {
    expect(recoveryLevel(10)).toBe('ok')
    expect(recoveryLevel(3)).toBe('ok')
    expect(recoveryLevel(2)).toBe('low')
    expect(recoveryLevel(1)).toBe('low')
    expect(recoveryLevel(0)).toBe('none')
  })

  it('knows the last factor', () => {
    expect(isLastFactor({ passkeys: [passkey], totp: false })).toBe(true)
    expect(isLastFactor({ passkeys: [], totp: true })).toBe(true)
    expect(isLastFactor({ passkeys: [passkey], totp: true })).toBe(false)
  })

  it('builds the target key the server derives', () => {
    expect(targetKeyOf({ host: 'DB.Example.org', port: 3306, user: 'app' })).toBe('db.example.org:3306|app')
  })
})

describe('time and theme', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  it('gives the age in the largest fitting unit', () => {
    expect(relativeWhen(now - 20_000, now)).toEqual({ unit: 'now', n: 0 })
    expect(relativeWhen(now - 5 * 60_000, now)).toEqual({ unit: 'minute', n: 5 })
    expect(relativeWhen(now - 3 * 3_600_000, now)).toEqual({ unit: 'hour', n: 3 })
    expect(relativeWhen(now - 2 * 86_400_000, now)).toEqual({ unit: 'day', n: 2 })
    expect(relativeWhen(now - 9 * 86_400_000, now).unit).toBe('date')
    expect(relativeWhen(now + 60_000, now).unit).toBe('now')
    expect(isoDate(now)).toBe('2026-11-02')
  })

  it('applies a chosen theme and clears it for the system choice', () => {
    const root = { dataset: {} as DOMStringMap }
    applyTheme('dark', root)
    expect(root.dataset.theme).toBe('dark')
    applyTheme('system', root)
    expect(root.dataset.theme).toBeUndefined()
  })
})
