/**
 * Read and acknowledge side of the exposure page (SPEC/31 FR-AEX-003, 005). Role check first, then the state object of
 * `exposure-state.ts`; nothing here writes except through `acknowledge`.
 */
import type { ExposureState, ExposureView } from './exposure-state'
import { AuthError, type AccountContext, type AccountStore } from './auth/types'

/** Status block: the readiness-style facts an administrator wants next to the report. No secret, no path. */
export type StatusBlock = {
  ready: boolean
  readyState: string
  loginMode: string
  store: 'ok' | 'none' | 'unavailable'
  schemaVersion: number | null
  version: string
  auditSink: { sink: string; state: string; buffered?: number; drops?: number }
}

export type ExposureAnswer = ExposureView & { status: StatusBlock }

export type ExposureServiceDeps = {
  state: ExposureState
  store: Pick<AccountStore, 'getUser'>
  status: () => StatusBlock
}

export interface ExposureService {
  get(ctx: AccountContext): ExposureAnswer
  acknowledge(ctx: AccountContext, warningId: string): void
}

export function createExposureService(d: ExposureServiceDeps): ExposureService {
  /** Active administrator of a `full` session whose row still says so; else `auth_failed`. */
  const adminOf = (ctx: AccountContext) => {
    const actor = ctx.user
    const row = actor ? d.store.getUser(actor.id) : undefined
    if (ctx.state !== 'full' || !actor || actor.role !== 'admin' || !row || row.role !== 'admin' || row.status !== 'active') throw new AuthError('auth_failed')
    return { id: actor.id, name: row.displayName || row.username }
  }
  return {
    get(ctx) {
      adminOf(ctx)
      return { ...d.state.view(), status: d.status() }
    },
    acknowledge(ctx, warningId) {
      d.state.acknowledge(adminOf(ctx), warningId)
    },
  }
}
