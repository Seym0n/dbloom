/**
 * Settings page, server side (SPEC/32 FR-ASE-005, 013): read, preview, change and reset for administrators. Writes need
 * step-up and write the audit row first. No secret is part of any answer. Imports stay thin on purpose: this file also
 * becomes a browser chunk (`tests/settings-functions.test.ts` pins the list).
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { accountMiddleware } from './middleware'
import { throwAuthError } from './auth/error-transport'
import { settingsService } from './settings-admin-runtime'

const none = z.object({}).strict()
const key = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9]*$/)
const basedOn = z.number().int().nonnegative().nullable()
const value = z.union([z.string().max(600), z.number(), z.boolean(), z.array(z.string().max(32)).max(8)])

export const setSettingInput = z.object({ key, value, basedOn }).strict()
export const resetSettingInput = z.object({ key, basedOn }).strict()
export const previewSettingInput = z.object({ key, value }).strict()

export const getSettings = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(none)
  .handler(({ context }) => {
    try {
      return settingsService().get(context.account)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const previewSetting = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(previewSettingInput)
  .handler(({ context, data }) => {
    try {
      return settingsService().preview(context.account, data.key, data.value)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const setSetting = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(setSettingInput)
  .handler(({ context, data }) => {
    try {
      return settingsService().set(context.account, data.key, data.value, data.basedOn)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })

export const resetSetting = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(resetSettingInput)
  .handler(({ context, data }) => {
    try {
      return settingsService().reset(context.account, data.key, data.basedOn)
    } catch (error) {
      return throwAuthError(error, 'auth_failed')
    }
  })
