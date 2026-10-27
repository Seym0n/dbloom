import { ServerApiGrid } from '~/components/rows/server-api-grid'
import type { FilterNode } from '~/server/rows/types'
import type { RowsGridHooks } from '~/components/rows/grid-hooks'
import { liveFormsApi } from '~/components/rows/server-api-forms-live'
import { setFormsApi } from '~/components/rows/server-api-forms'
import { useRouter } from '@tanstack/react-router'
import { useRowEditing } from '~/components/rows/use-row-editing'

setFormsApi(liveFormsApi)

/**
 * The table tab: a title and the rows grid of module `rows` (SPEC 24). Everything the grid does, such as
 * server sort and paging, filter, search, columns, selection and the SQL that ran, lives in
 * `components/rows`. Package D passes its toolbar buttons, inline editor and dialogs through `hooks`.
 */
export function TableView({
  db,
  table,
  hooks,
  initialFilter,
  onExport,
}: {
  db: string
  table: string
  hooks?: RowsGridHooks
  initialFilter?: FilterNode
  onExport?: (db: string, table: string) => void
}) {
  const router = useRouter()
  /** A real link to a table filtered by key equalities; the router encodes each name once. */
  const linkTo = (toDb: string, toTable: string, pairs: [string, string][]) =>
    router.buildLocation({ to: '/', search: { db: toDb, table: toTable, key: pairs } }).href
  const editing = useRowEditing({
    db,
    table,
    ...(onExport ? { onExport } : {}),
    fkHref: (fk, values) =>
      linkTo(
        fk.refDb,
        fk.refTable,
        fk.refColumns.map((c) => [c, values[c] ?? ''] as [string, string]),
      ),
    groupHref: (group, values) =>
      linkTo(
        group.db,
        group.table,
        group.columns.map((c) => [c, values[c] ?? ''] as [string, string]),
      ),
  })
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="table-title">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-5 pb-4">
        <h1 id="table-title" className="text-[22px] font-semibold leading-7">
          <span className="text-muted">{db}.</span>
          {table}
        </h1>
      </header>
      <ServerApiGrid
        key={`${db}.${table}`}
        db={db}
        table={table}
        hooks={hooks ?? editing.hooks}
        initialFilter={initialFilter}
      />
      {editing.dialogs}
    </section>
  )
}
