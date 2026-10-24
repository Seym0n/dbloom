import { createServerFn } from '@tanstack/react-start'
import {
  cancelCountImpl,
  changeRowsImpl,
  confirmRowsImpl,
  countRowsImpl,
  getPrefsImpl,
  getRowLimitsImpl,
  getRowsImpl,
  lookupImpl,
  openCellImpl,
  previewRowsImpl,
  readCellImpl,
  readRowImpl,
  referencingRowsImpl,
  rowsEnvOf,
  setPrefImpl,
} from './rows/service'
import { sessionMiddleware } from './middleware'
import {
  cancelCountInput,
  changeRowsInput,
  confirmRowsInput,
  countRowsInput,
  getPrefsInput,
  getRowsInput,
  lookupInput,
  openCellInput,
  previewRowsInput,
  readCellInput,
  readRowInput,
  referencingRowsInput,
  setPrefInput,
  type ChangeRowsResponse,
  type CountRowsResponse,
  type GetRowsResponse,
  type LookupResponse,
  type OpenCellResponse,
  type PrefKey,
  type PreviewRowsResponse,
  type ReadCellResponse,
  type ReadRowResponse,
  type ReferencingRowsResponse,
  type RowLimitsResponse,
} from './rows/types'

// Only server functions live here; logic is in rows/service.ts. Every export calls createServerFn directly so the
// TanStack compiler can strip the handlers (and their node-only imports) from the client bundle. Inputs are the
// strict zod schemas of rows/types.ts: an unknown field (`sql`, `where`, `orderBy`, `limit`, `class`) is refused.

export const getRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(getRowsInput)
  .handler(({ context, data }): Promise<GetRowsResponse> =>
    getRowsImpl(rowsEnvOf(context.session), data),
  )

export const countRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(countRowsInput)
  .handler(({ context, data }): Promise<CountRowsResponse> =>
    countRowsImpl(rowsEnvOf(context.session), data),
  )

export const cancelCount = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(cancelCountInput)
  .handler(({ context, data }): Promise<{ ok: true }> =>
    cancelCountImpl(rowsEnvOf(context.session), data),
  )

export const getRowLimits = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<RowLimitsResponse> =>
    getRowLimitsImpl(rowsEnvOf(context.session)),
  )

export const readRow = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(readRowInput)
  .handler(({ context, data }): Promise<ReadRowResponse> =>
    readRowImpl(rowsEnvOf(context.session), data),
  )

export const readCell = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(readCellInput)
  .handler(({ context, data }): Promise<ReadCellResponse> =>
    readCellImpl(rowsEnvOf(context.session), data),
  )

export const openCell = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(openCellInput)
  .handler(({ context, data }): Promise<OpenCellResponse> =>
    openCellImpl(rowsEnvOf(context.session), data),
  )

export const lookupRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(lookupInput)
  .handler(({ context, data }): Promise<LookupResponse> =>
    lookupImpl(rowsEnvOf(context.session), data),
  )

export const referencingRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(referencingRowsInput)
  .handler(({ context, data }): Promise<ReferencingRowsResponse> =>
    referencingRowsImpl(rowsEnvOf(context.session), data),
  )

export const previewRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(previewRowsInput)
  .handler(({ context, data }): Promise<PreviewRowsResponse> =>
    previewRowsImpl(rowsEnvOf(context.session), data),
  )

export const changeRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(changeRowsInput)
  .handler(({ context, data }): Promise<ChangeRowsResponse> =>
    changeRowsImpl(rowsEnvOf(context.session), data),
  )

export const confirmRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(confirmRowsInput)
  .handler(({ context, data }): Promise<ChangeRowsResponse> =>
    confirmRowsImpl(rowsEnvOf(context.session), data),
  )

/** Preference values are plain JSON; the contract types them `unknown`, which the server-function types refuse. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type PrefsWire = { values: Partial<Record<PrefKey, Json>>; stateless: boolean }

export const getRowPrefs = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(getPrefsInput)
  .handler(
    async ({ context, data }): Promise<PrefsWire> =>
      (await getPrefsImpl(rowsEnvOf(context.session), data)) as PrefsWire,
  )

export const setRowPref = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(setPrefInput)
  .handler(({ context, data }): Promise<{ ok: true }> =>
    setPrefImpl(rowsEnvOf(context.session), data),
  )
