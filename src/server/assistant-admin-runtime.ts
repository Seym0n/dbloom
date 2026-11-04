/**
 * Runtime wiring of the administrator side of the assistant (SPEC/34 task 6). Server only: kept out of
 * `assistant-admin.functions.ts` so the client build does not pull the runtime in.
 */
import { auditRequiredIn } from './audit'
import { createAssistantAdminService, type AssistantAdminService } from './assistant/admin-service'
import { getSignInServices } from './auth/signin-runtime'
import { assistantEnv } from './assistant-runtime'
import { getRuntime } from './runtime'
import { loginModeOf } from './session-context'
import { isStateless } from './sql/state'

let service: AssistantAdminService | undefined

export function assistantAdmin(): AssistantAdminService {
  if (service) return service
  const rt = getRuntime()
  const db = rt.store.db
  service = createAssistantAdminService({
    store: () => (isStateless() ? undefined : rt.store.assistant),
    accounts: rt.store.accounts,
    env: assistantEnv,
    stepUp: { requireRecentFactor: (ctx, purpose) => getSignInServices().stepUp.requireRecentFactor(ctx, purpose) },
    mode: () => (rt.statelessPrefs !== undefined ? 'stateless' : loginModeOf(rt)),
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    auditIn: (event, fields) => auditRequiredIn(db, event, fields),
  })
  return service
}
