import type { Theme } from '../types'
import { MemoryPrefsBackend, type PrefsBackend } from './backend'
import { createDefaultPrefsRegistry } from './registry'
import { createPrefsService, type PrefsServiceExt } from './service'

/**
 * Process-wide preferences service. The runtime calls `configurePrefsService(createSqlitePrefsBackend(db))` once the
 * store is open; stateless mode (`DBLOOM_STORE=none`) passes `{ stateless: true }` with the backend it shares with the
 * rows and io memory stores (owner key = session id hash), or falls back to a private memory backend.
 */
export const prefsRegistry = createDefaultPrefsRegistry()

let service: PrefsServiceExt | undefined
let memory: PrefsServiceExt | undefined

export function configurePrefsService(backend: PrefsBackend, opts: { stateless?: boolean } = {}): PrefsServiceExt {
  const created = createPrefsService(backend, prefsRegistry)
  if (opts.stateless) memory = created
  else service = created
  return created
}

export function getPrefsService(stateless: boolean): PrefsServiceExt {
  if (stateless) return (memory ??= createPrefsService(new MemoryPrefsBackend(), prefsRegistry))
  if (!service) throw new Error('prefs: service not configured')
  return service
}

/** Theme and language for `getSessionInfo` (applied before first paint, FR-AUT-024). */
export function appearanceOf(svc: Pick<PrefsServiceExt, 'get'>, ownerKey: string): { theme: Theme; language: string } {
  const v = svc.get(ownerKey)
  return { theme: v.theme as Theme, language: v.language as string }
}
