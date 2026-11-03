import { getRequest } from '@tanstack/react-start/server'
import { setAuditContext } from '../audit'

/**
 * Audit context of the current request: the effective client address that the gate stored on the request context
 * (FR-SVR-005). Kept apart from `current.ts` so the runtime can import it without a cycle (`current.ts` imports the
 * runtime, and a cycle makes the build bundle the runtime twice).
 */
export function installAuditContext(): void {
  setAuditContext(() => {
    const request = getRequest() as { context?: { dbloom?: { clientAddress?: string } } }
    const address = request.context?.dbloom?.clientAddress
    return address ? { address } : undefined
  })
}
