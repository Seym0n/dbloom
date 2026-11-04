/**
 * Exposure page, server side (SPEC/31 FR-AEX-003, 005): the report with warnings and status for administrators, and the
 * acknowledgement. No secret and no key value is part of any answer. Imports stay thin on purpose: this file also becomes
 * a browser chunk (`tests/exposure-functions.test.ts` pins the list).
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { accountMiddleware } from './middleware'
import { throwAuthError } from './auth/error-transport'
import { exposureService } from './exposure-runtime'

const none = z.object({}).strict()
export const acknowledgeExposureInput = z.object({ id: z.string().min(1).max(100).regex(/^[A-Za-z0-9:_.-]+$/) }).strict()

export const getExposure = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(none)
  .handler(({ context }) => {
    try {
      return exposureService().get(context.account)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const acknowledgeExposure = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(acknowledgeExposureInput)
  .handler(({ context, data }) => {
    try {
      exposureService().acknowledge(context.account, data.id)
      return { ok: true as const }
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })
