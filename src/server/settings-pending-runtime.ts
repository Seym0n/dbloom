/**
 * Process-wide pending-settings manager (SPEC/33 FR-APR-010). `runtime.ts` starts it at boot, which runs the first sweep:
 * a change that expired while the process was down is reverted before anyone is served, and the timer is armed for the
 * rest. Kept on `globalThis` like the other process-wide wiring (the build can bundle a module twice).
 */
import { audit, auditRequired, AuditUnavailable } from './audit'
import { SettingsError } from './auth/settings-write'
import type { AccountStore } from './auth/types'
import { log } from './log'
import { createPendingSettings, type PendingSettings } from './settings-pending'

const KEY = Symbol.for('dbloom.settings.pending')
const holder = () => globalThis as { [KEY]?: PendingSettings }

/** Starts the manager for `accounts` (once) and runs the boot sweep. */
export function startPendingSettings(accounts: AccountStore): PendingSettings {
  const existing = holder()[KEY]
  if (existing) return existing
  const manager = createPendingSettings({
    store: accounts,
    audit: (event, fields) => {
      try {
        auditRequired(event, fields)
      } catch (error) {
        if (error instanceof AuditUnavailable) throw new SettingsError('settings_audit_unavailable')
        throw error
      }
    },
    auditBestEffort: (event, fields) => {
      try {
        audit(event, fields)
      } catch (error) {
        log.warn('settings.revert_audit_failed', { error: error instanceof Error ? error.message : 'failed' })
      }
    },
    onError: (error) => log.warn('settings.pending_sweep_failed', { error: error instanceof Error ? error.message : 'failed' }),
  })
  holder()[KEY] = manager
  try {
    manager.sweep()
  } catch (error) {
    log.warn('settings.pending_sweep_failed', { error: error instanceof Error ? error.message : 'failed' })
    manager.schedule()
  }
  return manager
}

export const pendingSettings = (): PendingSettings | undefined => holder()[KEY]

/** Test hook: forgets the manager and stops its timer. */
export function stopPendingSettings(): void {
  holder()[KEY]?.stop()
  delete holder()[KEY]
}
