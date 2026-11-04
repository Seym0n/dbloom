/**
 * Server functions of the assistant administrator page (SPEC/34 task 6): the markings of PII columns, the acknowledgements
 * and the endpoint status. Administrators only; changes need step-up and write the audit row first. No secret is part of
 * any answer. Imports stay thin on purpose: this file also becomes a browser chunk (`tests/assistant-admin.test.ts` pins them).
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { accountMiddleware } from './middleware'
import { throwAuthError } from './auth/error-transport'
import { assistantAdmin } from './assistant-admin-runtime'

const none = z.object({}).strict()
const targetKey = z.string().max(200)
export const addRuleInput = z.object({ targetKey, rule: z.string().min(1).max(300) }).strict()
export const removeRuleInput = z.object({ id: z.number().int().positive() }).strict()
export const ackInput = z.object({ targetKey }).strict()

export const getAssistantAdmin = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(none)
  .handler(({ context }) => {
    try {
      return assistantAdmin().overview(context.account)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const addPiiRule = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(addRuleInput)
  .handler(({ context, data }) => {
    try {
      return assistantAdmin().addRule(context.account, data)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const removePiiRule = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(removeRuleInput)
  .handler(({ context, data }) => {
    try {
      return assistantAdmin().removeRule(context.account, data.id)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const setPiiAck = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(ackInput)
  .handler(({ context, data }) => {
    try {
      return assistantAdmin().setAck(context.account, data)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const clearPiiAck = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(ackInput)
  .handler(({ context, data }) => {
    try {
      return assistantAdmin().clearAck(context.account, data)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })
