import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { audit } from './audit'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageRows } from './db/rows'
import { listDatabases, listTables, resolveTable } from './db/schema'
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
    const { pool, target } = context.session
    const table = await resolveTable(pool, data.db, data.table)
    const result = await pageRows(pool, table, data)
    audit('table.open', { user: target.username, db: data.db, table: data.table })
    return { ...result, kind: table.kind, estimatedRows: table.estimatedRows }
  })
