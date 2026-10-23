import { createServerFn } from '@tanstack/react-start'
import { audit } from './audit'
import { sessionMiddleware } from './middleware'
import {
  definitionImpl,
  envOf,
  executeImpl,
  listsImpl,
  parseExecuteInput,
  parsePreviewInput,
  previewImpl,
} from './structure/service'
import { z } from 'zod'
import type {
  ExecuteInput,
  ExecuteResult,
  PreviewInput,
  PreviewResult,
  StructureLists,
  TableDefinition,
} from './structure/types'

// Only server functions live here: everything with server-only imports is in structure/service.ts,
// so the client bundle never sees node:crypto.

export const getStructureLists = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<StructureLists> => listsImpl(envOf(context.session)))

export const previewStructure = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: PreviewInput) => parsePreviewInput(raw))
  .handler(({ context, data }): Promise<PreviewResult> => {
    audit('structure.preview', { user: context.session.target.username, action: data.action })
    return previewImpl(envOf(context.session), data)
  })

export const executeStructure = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ExecuteInput) => parseExecuteInput(raw))
  .handler(({ context, data }): Promise<ExecuteResult> => executeImpl(envOf(context.session), data))

export const getTableDefinition = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(z.object({ db: z.string().max(64), table: z.string().max(64) }))
  .handler(({ context, data }): Promise<{ def: TableDefinition; unsupportedColumns: string[] }> =>
    definitionImpl(envOf(context.session), data.db, data.table),
  )
