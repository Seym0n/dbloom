import { ServerApiGrid } from '~/components/rows/server-api-grid'
import type { RowsGridHooks } from '~/components/rows/grid-hooks'

/**
 * The table tab: a title and the rows grid of module `rows` (SPEC 24). Everything the grid does, such as
 * server sort and paging, filter, search, columns, selection and the SQL that ran, lives in
 * `components/rows`. Package D passes its toolbar buttons, inline editor and dialogs through `hooks`.
 */
export function TableView({
  db,
  table,
  hooks,
}: {
  db: string
  table: string
  hooks?: RowsGridHooks
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="table-title">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-5 pb-4">
        <h1 id="table-title" className="text-[22px] font-semibold leading-7">
          <span className="text-muted">{db}.</span>
          {table}
        </h1>
      </header>
      <ServerApiGrid key={`${db}.${table}`} db={db} table={table} hooks={hooks} />
    </section>
  )
}
