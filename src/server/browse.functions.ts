import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './db/rows'
import { listDatabases, listTables } from './db/schema'
import { getRowsImpl, rowsEnvOf } from './rows/service'
import { sessionMiddleware } from './middleware'

export const getDatabases = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }) => listDatabases(context.session.pool))

export const getTables = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(z.object({ db: z.string().max(64) }))
  .handler(({ context, data }) => listTables(context.session.pool, data.db))

export const getTableRows = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator(
    z.object({
      db: z.string().max(64),
      table: z.string().max(64),
      page: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      sort: z.string().max(64).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    // The skeleton function delegates to the rows service (FR-ROW-006); the legacy fields stay, the new ones are additive.
    const res = await getRowsImpl(rowsEnvOf(context.session), {
      db: data.db,
      table: data.table,
      page: data.page,
      pageSize: data.pageSize,
      sort: data.sort ? [{ column: data.sort, direction: data.direction ?? 'asc' }] : [],
    })
    return {
      columns: res.columns,
      kinds: res.kinds,
      rows: res.rows,
      sql: res.sqlShown,
      kind: res.table.kind,
      estimatedRows: res.table.estimatedRows,
      page: res.page,
      hasNext: res.hasNext,
      hasPrev: res.hasPrev,
      total: res.total,
      timings: res.timings,
      identity: res.identity,
      permissions: res.permissions,
      timeZone: res.timeZone,
    }
  })
