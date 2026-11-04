import { createServerFn } from '@tanstack/react-start'
import { createMiddleware } from '@tanstack/react-start'
import { getCookie, getRequestHeader } from '@tanstack/react-start/server'
import { CSRF_HEADER, SESSION_ENDED } from '~/lib/csrf'
import { csrfClientMiddleware, sameOriginMiddleware, setupGateMiddleware, SESSION_COOKIE } from './middleware'
import { assertNotInMaintenance } from './maintenance'
import { getRuntime } from './runtime'
import { isStateless, ownerKeyOf } from './sql/state'
import { getPrefsService } from './auth/prefs/runtime'
import { PrefsServiceError } from './auth/prefs/service'
import {
  PREFERENCES_FILE_NAME,
  getPrefsInput,
  importPrefsInput,
  resetPrefsInput,
  setPrefInput,
  type AuthUser,
  type PrefImportResult,
} from './auth/types'

// Only server functions live here; the logic is in auth/prefs/*. Every export calls createServerFn directly so the
// compiler can strip the handlers from the client bundle.

type PrefsContext = { ownerKey: string; user: AuthUser | null; stateless: boolean }

/** Account sessions in state `full`, or a direct session (owner key by target; stateless: the session id hash). */
const prefsMiddleware = createMiddleware({ type: 'function' })
  .middleware([sameOriginMiddleware, csrfClientMiddleware, setupGateMiddleware])
  .server(({ next }) => {
    const { sessions } = getRuntime()
    const token = getCookie(SESSION_COOKIE)
    const presented = getRequestHeader(CSRF_HEADER)
    const stateless = isStateless()
    const account = sessions.resolveAccount(token, { background: false })
    if (account) {
      if (!sessions.verifyCsrf(account, presented) || account.state !== 'full') throw new Error(SESSION_ENDED)
      assertNotInMaintenance(getRuntime(), account.user)
      const ctx: PrefsContext = { ownerKey: stateless ? account.idHash : account.ownerKey, user: account.user, stateless }
      return next({ context: { prefs: ctx } })
    }
    const session = sessions.resolve(token)
    if (!session || !sessions.verifyCsrf(session, presented)) throw new Error(SESSION_ENDED)
    const ctx: PrefsContext = { ownerKey: stateless ? session.idHash : ownerKeyOf(session.target), user: null, stateless }
    return next({ context: { prefs: ctx } })
  })

function run<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof PrefsServiceError) throw new Error(`${error.code}: ${error.message}`)
    throw new Error('save-failed: Preferences could not be saved')
  }
}

/** Preference values are JSON by construction (parsed from stored JSON). */
export type PrefJson = string | number | boolean | null | PrefJson[] | { [k: string]: PrefJson }
export type GetPrefsResponse = { values: Record<string, PrefJson>; updatedAt: number | null; stateless: boolean }

export const getPrefs = createServerFn({ method: 'POST' })
  .middleware([prefsMiddleware])
  .validator(getPrefsInput)
  .handler(({ context, data }): GetPrefsResponse =>
    run(() => {
      const svc = getPrefsService(context.prefs.stateless)
      return {
        values: svc.get(context.prefs.ownerKey, data.targetKey) as Record<string, PrefJson>,
        updatedAt: svc.lastSavedAt(context.prefs.ownerKey),
        stateless: context.prefs.stateless,
      }
    }),
  )

export const setPref = createServerFn({ method: 'POST' })
  .middleware([prefsMiddleware])
  .validator(setPrefInput)
  .handler(({ context, data }): { ok: true; updatedAt: number | null } =>
    run(() => {
      const svc = getPrefsService(context.prefs.stateless)
      svc.set(context.prefs.ownerKey, data.key, data.value, data.targetKey)
      return { ok: true, updatedAt: svc.lastSavedAt(context.prefs.ownerKey) }
    }),
  )

export const exportPrefs = createServerFn({ method: 'POST' })
  .middleware([prefsMiddleware])
  .handler(({ context }): { fileName: string; json: string } =>
    run(() => {
      const file = getPrefsService(context.prefs.stateless).export(context.prefs.ownerKey, context.prefs.user)
      return { fileName: PREFERENCES_FILE_NAME, json: JSON.stringify(file, null, 2) }
    }),
  )

export const importPrefs = createServerFn({ method: 'POST' })
  .middleware([prefsMiddleware])
  .validator(importPrefsInput)
  .handler(({ context, data }): PrefImportResult =>
    run(() => getPrefsService(context.prefs.stateless).import(context.prefs.ownerKey, data)),
  )

export const resetPrefs = createServerFn({ method: 'POST' })
  .middleware([prefsMiddleware])
  .validator(resetPrefsInput)
  .handler(({ context }): { ok: true } =>
    run(() => {
      getPrefsService(context.prefs.stateless).reset(context.prefs.ownerKey)
      return { ok: true }
    }),
  )
