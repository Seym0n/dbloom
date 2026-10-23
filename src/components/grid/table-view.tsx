import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Check, Copy } from 'lucide-react'
import { getTableRows } from '~/server/browse.functions'
import type { Cell } from '~/server/db/rows'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'

const PAGE_SIZES = [25, 50, 100, 250, 500]
const features = tableFeatures({})
const helper = createColumnHelper<typeof features, Cell[]>()
const number = new Intl.NumberFormat('en-US')

function CellView({ cell }: { cell: Cell }) {
  if (cell === null) return <span className="text-faint">NULL</span>
  if (typeof cell === 'string') return <>{cell}</>
  if ('binary' in cell) {
    return (
      <span className="font-mono text-xs text-muted">
        0x{cell.binary.toUpperCase()}
        {cell.size > 32 ? '…' : ''}{' '}
        <span className="text-faint">({number.format(cell.size)} B)</span>
      </span>
    )
  }
  return (
    <>
      {cell.cut}
      <span className="text-faint">… ({number.format(cell.length)} chars)</span>
    </>
  )
}

function SqlStrip({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-3 border-t border-rule px-6 py-3">
      <span className="shrink-0 pt-0.5 text-xs text-muted">{t('table.sql')}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={sql}>
        {sql}
      </code>
      <Button
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(sql).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? t('table.copied') : t('table.copy')}
      </Button>
    </div>
  )
}

export function TableView({ db, table }: { db: string; table: string }) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | undefined>()

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: ['rows', db, table, page, pageSize, sort],
    queryFn: () =>
      getTableRows({
        data: { db, table, page, pageSize, sort: sort?.column, direction: sort?.direction },
      }),
    placeholderData: keepPreviousData,
  })

  const columns = helper.columns(
    (data?.columns ?? []).map((name, index) =>
      helper.accessor((row) => row[index] ?? null, { id: `c${index}`, header: name }),
    ),
  )
  const grid = useTable({ features, columns, data: data?.rows ?? EMPTY })

  function toggleSort(column: string) {
    setPage(0)
    setSort((current) =>
      current?.column !== column
        ? { column, direction: 'asc' }
        : current.direction === 'asc'
          ? { column, direction: 'desc' }
          : undefined,
    )
  }

  if (isError) {
    return (
      <div className="p-6 text-sm text-muted">
        {t('table.error')}{' '}
        <button type="button" className="text-ink underline" onClick={() => void refetch()}>
          {t('table.retry')}
        </button>
      </div>
    )
  }

  const from = page * pageSize + 1
  const to = page * pageSize + (data?.rows.length ?? 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="table-title">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-5 pb-4">
        <h1 id="table-title" className="text-[22px] font-semibold leading-7">
          <span className="text-muted">{db}.</span>
          {table}
        </h1>
        {data?.kind === 'view' && (
          <span className="rounded bg-[var(--pill-neutral-bg)] px-2 text-xs leading-5 text-[var(--pill-neutral-ink)]">
            {t('table.view')}
          </span>
        )}
        <p className="text-sm text-muted">
          {data?.estimatedRows == null
            ? t('table.rowsUnknown')
            : t('table.rows', { count: number.format(data.estimatedRows) })}
        </p>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          {t('table.pageSize')}
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(0)
            }}
            className="h-8 rounded-[var(--radius-control)] border border-control bg-surface px-2 text-ink"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className={cn('min-h-0 flex-1 overflow-auto', isFetching && 'opacity-70')}>
        {isPending ? (
          <div className="flex flex-col gap-3 px-6 pt-2" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-5 rounded bg-active" />
            ))}
          </div>
        ) : data.rows.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted">{t('table.empty')}</p>
        ) : (
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              {grid.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const name = String(header.column.columnDef.header)
                    const kind = data?.kinds[header.index] ?? 'text'
                    const sorted = sort?.column === name ? sort.direction : undefined
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
                        }
                        className={cn(
                          'sticky top-0 border-b border-border bg-surface px-3 py-0 text-xs font-normal first:pl-6 last:pr-6',
                          kind === 'number' ? 'text-right' : 'text-left',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(name)}
                          className={cn(
                            'press flex h-9 w-full items-center gap-1 whitespace-nowrap text-muted hover:text-ink',
                            kind === 'number' && 'justify-end',
                          )}
                        >
                          {name}
                          {sorted === 'asc' && (
                            <ArrowUp size={12} aria-hidden className="text-ink" />
                          )}
                          {sorted === 'desc' && (
                            <ArrowDown size={12} aria-hidden className="text-ink" />
                          )}
                        </button>
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {grid.getRowModel().rows.map((row) => (
                <tr key={row.id} className="hover:bg-raised">
                  {row.getAllCells().map((cell, index) => (
                    <td
                      key={cell.id}
                      className={cn(
                        'max-w-[420px] truncate border-b border-rule px-3 py-0 first:pl-6 last:pr-6',
                        data?.kinds[index] === 'number' && 'text-right font-mono text-[13px]',
                        data?.kinds[index] === 'temporal' && 'font-mono text-[13px]',
                      )}
                      style={{ height: 40 }}
                    >
                      <CellView cell={cell.getValue() as Cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer>
        {data && <SqlStrip sql={data.sql} />}
        <div className="flex items-center gap-3 border-t border-rule px-6 py-2.5">
          <p className="text-sm text-muted" aria-live="polite">
            {data && data.rows.length > 0
              ? t('table.range', { from: number.format(from), to: number.format(to) })
              : ''}
          </p>
          <div className="ml-auto flex gap-2">
            <Button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              {t('table.previous')}
            </Button>
            <Button
              disabled={!data || data.rows.length < pageSize}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('table.next')}
            </Button>
          </div>
        </div>
      </footer>
    </section>
  )
}

const EMPTY: Cell[][] = []
