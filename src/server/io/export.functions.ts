import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { z } from 'zod'
import { sessionMiddleware } from '../middleware'
import { exportEnvOf } from './export-env'
import {
  cancelJobImpl,
  deleteTemplateImpl,
  getIoCapabilitiesImpl,
  getIoPrefsImpl,
  getJobImpl,
  ioClientError,
  ioPrefsPatch,
  listTemplatesImpl,
  saveTemplateImpl,
  setIoPrefsImpl,
  startExportImpl,
  templateInput,
  templateKey,
  type IoPrefsView,
  type TemplateInput,
  type TemplateView,
} from './export-service'
import { exportRequest, type ExportRequest, type IoCapabilities, type IoFormat, type IoJob } from './types'

// Only server functions live here; logic is in export-service.ts. Every export calls createServerFn directly so the
// TanStack compiler can strip the handlers (and their node-only imports) from the client bundle. Inputs are the
// strict zod schemas of types.ts: an unknown field (`sql`, `where`, `path`) is refused (FR-IO-002).

const jobInput = z.object({ jobId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict()

const host = () => getRequestHeader('host') ?? undefined

/** Runs a handler and turns every failure into the plain `code: message` error the client shows. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw ioClientError(e)
  }
}

export const getIoCapabilities = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<IoCapabilities> =>
    guarded(() => getIoCapabilitiesImpl(exportEnvOf(context.session))),
  )

export const startExport = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ExportRequest) => exportRequest.parse(raw))
  .handler(({ context, data }): Promise<{ jobId: string }> =>
    guarded(() => startExportImpl(exportEnvOf(context.session, host()), data)),
  )

export const getJob = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: { jobId: string }) => jobInput.parse(raw))
  .handler(({ context, data }): Promise<IoJob> =>
    guarded(() => getJobImpl(exportEnvOf(context.session), data.jobId)),
  )

export const cancelJob = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: { jobId: string }) => jobInput.parse(raw))
  .handler(({ context, data }): Promise<IoJob> =>
    guarded(() => cancelJobImpl(exportEnvOf(context.session), data.jobId)),
  )

export const listTemplates = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<TemplateView[]> =>
    guarded(() => listTemplatesImpl(exportEnvOf(context.session))),
  )

export const saveTemplate = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: TemplateInput) => templateInput.parse(raw))
  .handler(({ context, data }): Promise<{ ok: true }> =>
    guarded(() => saveTemplateImpl(exportEnvOf(context.session), data)),
  )

export const deleteTemplate = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: { format: IoFormat; name: string }) => templateKey.parse(raw))
  .handler(({ context, data }): Promise<{ ok: true }> =>
    guarded(() => deleteTemplateImpl(exportEnvOf(context.session), data)),
  )

export const getIoPrefs = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<IoPrefsView> =>
    guarded(() => getIoPrefsImpl(exportEnvOf(context.session))),
  )

export const setIoPrefs = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: Partial<IoPrefsView>) => ioPrefsPatch.parse(raw))
  .handler(({ context, data }): Promise<IoPrefsView> =>
    guarded(() => setIoPrefsImpl(exportEnvOf(context.session), data)),
  )
