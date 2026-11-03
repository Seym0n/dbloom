import { getRuntime } from '../runtime'
import { getSignInServices } from '../auth/signin-runtime'
import { loginModeOf } from '../session-context'
import { createAuditService, type AuditService } from './service'

/** The audit service of this process, wired to the runtime. Server only: kept out of `audit.functions.ts` so the client build does not pull the runtime in. */
let service: AuditService | undefined
export const auditService = (): AuditService => {
  if (service) return service
  const runtime = getRuntime()
  service = createAuditService({
    db: runtime.store.db,
    store: runtime.store.accounts,
    mode: () => loginModeOf(runtime),
    stepUp: { requireRecentFactor: (ctx, purpose) => getSignInServices().stepUp.requireRecentFactor(ctx, purpose) },
    retentionDays: () => runtime.settings().auditRetentionDays,
  })
  return service
}
