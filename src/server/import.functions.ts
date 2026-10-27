import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { sessionMiddleware } from './middleware'
import { analyseImportImpl } from './io/analyse'
import {
  importEnvOf,
  listImportFolderImpl,
  resumeImportImpl,
  startImportImpl,
  toClientImportError,
} from './io/import-service'
import { analyseRequest, startImportRequest, type ImportAnalysis } from './io/types'

// Only server functions live here; the logic is in io/import-service.ts and io/analyse.ts. Inputs are the strict
// zod schemas of io/types.ts: a `sql` or `path` field in any request is refused (FR-IO-002). Errors reach the
// client as `code: message` with the closed codes of IoErrorCode.

export const analyseImport = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(analyseRequest)
  .handler(async ({ context, data }): Promise<ImportAnalysis> => {
    try {
      return await analyseImportImpl(importEnvOf(context.session), data, getRequest().signal)
    } catch (e) {
      throw toClientImportError(e)
    }
  })

export const startImport = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(startImportRequest)
  .handler(async ({ context, data }): Promise<{ jobId: string }> => {
    try {
      return await startImportImpl(importEnvOf(context.session), data)
    } catch (e) {
      throw toClientImportError(e)
    }
  })

export const resumeImport = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(z.object({ jobId: z.string().min(8).max(128) }).strict())
  .handler(async ({ context, data }): Promise<{ jobId: string }> => {
    try {
      return await resumeImportImpl(importEnvOf(context.session), data)
    } catch (e) {
      throw toClientImportError(e)
    }
  })

export const listImportFolder = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(async ({ context }): Promise<{ id: string; name: string; bytes: number }[]> => {
    try {
      return await listImportFolderImpl(importEnvOf(context.session))
    } catch (e) {
      throw toClientImportError(e)
    }
  })
