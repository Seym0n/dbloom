import { AuditUnavailable, auditRequired } from './audit'
import { createAuthSettingsResolver } from './auth/settings'
import { createSettingsWriter, SettingsError } from './auth/settings-write'
import { getSignInServices } from './auth/signin-runtime'
import { createSettingsService, type SettingsService } from './settings-service'
import { getRuntime } from './runtime'
import { loginModeOf } from './session-context'

let service: SettingsService | undefined

/**
 * The settings service of this process, wired to the runtime. Server only: kept out of `settings.functions.ts` so the
 * client build does not pull the runtime in. The audit row is the required kind (NFR-TGT-145): when it cannot be written
 * the change is refused with `settings_audit_unavailable`.
 */
export function settingsService(): SettingsService {
  if (service) return service
  const rt = getRuntime()
  const accounts = rt.store.accounts
  const resolver = createAuthSettingsResolver(accounts, process.env)
  const writer = createSettingsWriter({
    store: accounts,
    audit: (event, fields) => {
      try {
        auditRequired(event, fields)
      } catch (error) {
        if (error instanceof AuditUnavailable) throw new SettingsError('settings_audit_unavailable')
        throw error
      }
    },
  })
  service = createSettingsService({
    store: accounts,
    writer,
    describe: () => resolver.describe(),
    stepUp: { requireRecentFactor: (ctx, purpose) => getSignInServices().stepUp.requireRecentFactor(ctx, purpose) },
    mode: () => (rt.statelessPrefs !== undefined ? 'stateless' : loginModeOf(rt)),
  })
  return service
}
