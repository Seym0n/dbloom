/** Package D composition from the runtime: connections, vault and profiles on the shared store, sessions, settings and throttle. */
import { getRuntime } from '../runtime'
import { createAccountServices, type AccountServices } from './connections'
import { getPrefsService } from './prefs/runtime'

let services: AccountServices | undefined

export function getAccountServices(): AccountServices {
  if (services) return services
  const runtime = getRuntime()
  services = createAccountServices({
    store: runtime.store.accounts,
    sessions: runtime.sessions,
    config: runtime.config,
    throttle: runtime.throttle,
    settings: runtime.settings,
    // The saved default collation of the user (FR-CFG-018); a failure to read it never blocks a connection.
    userCollation: (ownerKey) => {
      try {
        const value = getPrefsService(false).get(ownerKey).collation
        return typeof value === 'string' ? value : null
      } catch {
        return null
      }
    },
  })
  return services
}
