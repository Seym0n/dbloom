/**
 * SPEC/33 FR-APR-006 to 010: lifecycle of a guarded settings change. The writer applies the change and inserts the
 * `pending_settings` row in one transaction; this manager confirms, cancels and reverts it.
 *
 * The deadline is an absolute time in the store, so a restart neither loses nor hardens a pending change: the boot sweep
 * reverts what is overdue and `schedule()` re-arms the timer for the rest. The sweep also runs at the start of every
 * settings call, so a missed timer (a suspended process) cannot leave an expired change in force. A revert needs no
 * session and no step-up; its audit row is best-effort on purpose (the safety net must not depend on the audit sink).
 */
import { notifySettingsChanged } from './settings-runtime'
import { SettingsError } from './auth/settings-write'
import type { AccountStore, AuthSettingKey, PendingSetting } from './auth/types'

type AuditFields = Record<string, string | number | boolean | undefined>
export type PendingAuditEvent = 'settings.confirm' | 'settings.cancel' | 'settings.revert'

export type PendingTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export type PendingDeps = {
  store: AccountStore
  now?: () => number
  /** Required audit write (confirm, cancel): must throw when the row cannot be committed; then nothing changes. */
  audit: (event: PendingAuditEvent, fields: AuditFields) => void
  /** Best-effort audit write (revert by deadline). Must not throw. */
  auditBestEffort: (event: PendingAuditEvent, fields: AuditFields) => void
  /** Called after a stored value changed; defaults to the process-wide cache invalidation. */
  changed?: () => void
  timers?: PendingTimers
  /** A timer that failed to run its sweep. */
  onError?: (error: unknown) => void
}

export type RevertOutcome = 'reverted' | 'superseded' | 'gone'

export interface PendingSettings {
  /** Reverts every change whose deadline has passed, then re-arms the timer. Returns how many were reverted. */
  sweep(): number
  /** Arms the timer for the nearest pending deadline (also called by the writer after a guarded commit). */
  schedule(): void
  /** `sessionCreatedAt` is the creation time of the confirming session; it must not be older than the change. */
  confirm(key: AuthSettingKey, sessionCreatedAt: number, actor: string): void
  /** Reverts at once ("Revert now"). */
  cancel(key: AuthSettingKey, actor: string): RevertOutcome
  /** The owner changed the key through the CLI: the pending row no longer describes the stored value. */
  supersede(key: AuthSettingKey): void
  list(): PendingSetting[]
  stop(): void
}

const MAX_TIMER_MS = 2 ** 31 - 1

export function createPendingSettings(deps: PendingDeps): PendingSettings {
  const { store } = deps
  const now = deps.now ?? Date.now
  const changed = deps.changed ?? notifySettingsChanged
  const timers: PendingTimers = deps.timers ?? {
    set: (fn, ms) => {
      const h = setTimeout(fn, ms)
      h.unref()
      return h
    },
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let handle: unknown

  const find = (key: AuthSettingKey) => store.getPendingSettings('pending').find((p) => p.key === key)

  /** Restores the target of `p` unless the stored row changed after the guarded change. */
  function revert(p: PendingSetting, status: 'reverted' | 'cancelled', report: (old: string, to: string | null) => void): RevertOutcome {
    const row = store.getSettings().find((r) => r.key === p.key)
    const intact = p.newUpdatedAt === 0 ? row === undefined : row?.updatedAt === p.newUpdatedAt
    if (!intact) return store.resolvePending(p.key, 'superseded') ? 'superseded' : 'gone'
    let done = false
    store.transaction(() => {
      if (!store.resolvePending(p.key, status)) return
      done = true
      if (p.revertTo === null) store.deleteSetting(p.key)
      else store.setSetting({ key: p.key, value: p.revertTo, updatedAt: Math.max(now(), (row?.updatedAt ?? 0) + 1), updatedBy: 'system' })
    })
    if (!done) return 'gone'
    changed()
    report(p.newValue, p.revertTo)
    return 'reverted'
  }

  function sweep(): number {
    let n = 0
    for (const p of store.getPendingSettings('pending')) {
      if (p.deadlineAt > now()) continue
      const outcome = revert(p, 'reverted', (old, to) =>
        deps.auditBestEffort('settings.revert', { setting: p.key, old, new: to ?? 'default', actor: 'system', requestedBy: p.actor }),
      )
      if (outcome === 'reverted') n++
    }
    schedule()
    return n
  }

  function schedule(): void {
    if (handle !== undefined) timers.clear(handle)
    handle = undefined
    const next = store.getPendingSettings('pending')[0] // ordered by deadline
    if (!next) return
    const delay = Math.min(Math.max(1, next.deadlineAt - now()), MAX_TIMER_MS)
    handle = timers.set(() => {
      handle = undefined
      try {
        sweep()
      } catch (error) {
        deps.onError?.(error)
        schedule()
      }
    }, delay)
  }

  return {
    sweep,
    schedule,
    confirm(key, sessionCreatedAt, actor) {
      sweep()
      const p = find(key)
      if (!p) throw new SettingsError('settings_no_pending')
      if (sessionCreatedAt < p.createdAt) throw new SettingsError('settings_confirm_session')
      deps.audit('settings.confirm', { setting: key, new: p.newValue, actor })
      if (!store.resolvePending(key, 'confirmed')) throw new SettingsError('settings_no_pending')
      schedule()
    },
    cancel(key, actor) {
      const p = find(key)
      if (!p) throw new SettingsError('settings_no_pending')
      deps.audit('settings.cancel', { setting: key, old: p.newValue, new: p.revertTo ?? 'default', actor })
      const outcome = revert(p, 'cancelled', () => undefined)
      schedule()
      return outcome
    },
    supersede(key) {
      store.resolvePending(key, 'superseded')
      schedule()
    },
    list: () => store.getPendingSettings('pending'),
    stop() {
      if (handle !== undefined) timers.clear(handle)
      handle = undefined
    },
  }
}
