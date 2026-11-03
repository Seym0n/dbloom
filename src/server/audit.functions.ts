/**
 * Audit log, read side (SPEC/29 FR-AAU-007, 008): list and sink status for administrators, own events for any signed-in
 * user. There is deliberately no write, update or delete function here (FR-AAU-006); `tests/audit-functions.test.ts`
 * checks the exports.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { accountMiddleware } from './middleware'
import { throwAuthError } from './auth/error-transport'
import { EXPORT_FORMATS } from './audit/formats'
import { auditService } from './audit/runtime'

const page = { before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }
const text = z.string().max(200).optional()

export const listAuditInput = z
  .object({
    ...page,
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    eventPrefix: text,
    actor: text,
    outcome: text,
    text,
  })
  .strict()
const { from, to, eventPrefix, actor, outcome, text: subjectText } = listAuditInput.shape
export const startAuditExportInput = z.object({ from, to, eventPrefix, actor, outcome, text: subjectText, format: z.enum(EXPORT_FORMATS as unknown as [string, ...string[]]) }).strict()
const ownInput = z.object(page).strict()
const none = z.object({}).strict()

export const listAuditEvents = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(listAuditInput)
  .handler(({ context, data }) => {
    try {
      const { before, limit, ...filter } = data
      return auditService().list(context.account, filter, { before, limit })
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const listOwnAuditEvents = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(ownInput)
  .handler(({ context, data }) => {
    try {
      return auditService().own(context.account, data)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const getAuditStatus = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(none)
  .handler(({ context }) => {
    try {
      return auditService().status(context.account)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

/** Step-up and the `audit.export` row happen here; the stream itself comes from `/api/audit/export/$token`. */
export const startAuditExport = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(startAuditExportInput)
  .handler(({ context, data }) => {
    try {
      const { format, ...filter } = data
      return auditService().startExport(context.account, filter, format as 'csv' | 'ndjson')
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })
