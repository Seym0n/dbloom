import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AuditUnavailable, auditRegistered, auditRequired } from '../audit'
import { exportFilename, exportStream, planExport, type ExportFormat, type ExportPlan } from './export'
import { AUDIT_EVENTS } from './events'
import { auditSinkStatus } from './file-sink'
import { queryAudit, queryOwnEvents, type AuditFilter, type AuditRow, type OwnAuditRow, type Page } from './query'
import { sinkFailures } from './sink'
import { AuthError, type AccountContext, type AccountStore, type LoginMode, type StepUp } from '../auth/types'

export type AuditStatus = {
  /** `account`: rows are in the table. Other modes: stdout and the external sink only. */
  mode: LoginMode
  table: boolean
  /** Failed table writes since start; above zero the viewer banner says the table is unwritable. */
  tableFailures: number
  sink: ReturnType<typeof auditSinkStatus>
  events: readonly string[]
}

export type AuditServiceDeps = {
  db: DatabaseSync
  store: Pick<AccountStore, 'getUser'>
  mode: () => LoginMode
  stepUp: Pick<StepUp, 'requireRecentFactor'>
  /** Effective retention in days; bounds what an export may contain. */
  retentionDays: () => number
  now?: () => number
}

export interface AuditService {
  list(ctx: AccountContext, filter: AuditFilter, opts: { before?: number; limit?: number }): Page<AuditRow>
  own(ctx: AccountContext, opts: { before?: number; limit?: number }): Page<OwnAuditRow>
  status(ctx: AccountContext): AuditStatus
  /** Step-up, then the required `audit.export` row, then a one-time download token (FR-AAU-008). */
  startExport(ctx: AccountContext, filter: AuditFilter, format: ExportFormat): { token: string; rows: number; truncated: boolean; filename: string }
  /** Consumes the token and returns the stream; the session must be the one that started the export. */
  openExport(ctx: AccountContext, token: string): { stream: ReadableStream<Uint8Array>; format: ExportFormat; filename: string }
}

const TOKEN_TTL_MS = 60_000

/** Read side of the audit log. No write or delete operation exists here (FR-AAU-006). */
export function createAuditService(d: AuditServiceDeps): AuditService {
  const now = () => (d.now ?? Date.now)()
  /** Active administrator of a `full` session whose row still says so; else `auth_failed`. */
  const adminOf = (ctx: AccountContext) => {
    const actor = ctx.user
    const row = actor ? d.store.getUser(actor.id) : undefined
    if (ctx.state !== 'full' || !actor || actor.role !== 'admin' || !row || row.role !== 'admin' || row.status !== 'active') throw new AuthError('auth_failed')
  }
  const userOf = (ctx: AccountContext) => {
    const actor = ctx.user
    const row = actor ? d.store.getUser(actor.id) : undefined
    if (ctx.state !== 'full' || !actor || !row || row.status !== 'active') throw new AuthError('auth_failed')
    return actor
  }
  const tokens = new Map<string, { idHash: string; userId: string; plan: ExportPlan; format: ExportFormat; filename: string; expires: number }>()
  const tableOn = () => d.mode() === 'account' && auditRegistered()
  return {
    list(ctx, filter, opts) {
      adminOf(ctx)
      if (!tableOn()) throw new AuditUnavailable('not available in this mode')
      return queryAudit(d.db, filter, opts)
    },
    own(ctx, opts) {
      const actor = userOf(ctx)
      if (!tableOn()) return { rows: [], next: null }
      return queryOwnEvents(d.db, actor.id, now(), opts)
    },
    status(ctx) {
      adminOf(ctx)
      return { mode: d.mode(), table: tableOn(), tableFailures: sinkFailures().store ?? 0, sink: auditSinkStatus(), events: AUDIT_EVENTS }
    },
    startExport(ctx, filter, format) {
      adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'audit.export')
      if (!tableOn()) throw new AuditUnavailable('not available in this mode')
      const t = now()
      const plan = planExport(d.db, filter, t, d.retentionDays())
      // Written before any row leaves, and required: no row, no export (also when the stream is cancelled later).
      auditRequired('audit.export', {
        actor: ctx.user!.id, outcome: 'ok', format, rows: plan.rows, truncated: plan.truncated, filter: JSON.stringify(plan.filter),
      })
      for (const [k, v] of tokens) if (v.expires < t) tokens.delete(k)
      const token = randomBytes(24).toString('base64url')
      const filename = exportFilename(format, t)
      tokens.set(token, { idHash: ctx.idHash, userId: ctx.user!.id, plan, format, filename, expires: t + TOKEN_TTL_MS })
      return { token, rows: plan.rows, truncated: plan.truncated, filename }
    },
    openExport(ctx, token) {
      adminOf(ctx)
      const entry = tokens.get(token)
      tokens.delete(token)
      if (!entry || entry.expires < now() || entry.idHash !== ctx.idHash || entry.userId !== ctx.user!.id) throw new AuthError('auth_failed')
      return { stream: exportStream(d.db, entry.plan, entry.format), format: entry.format, filename: entry.filename }
    },
  }
}
