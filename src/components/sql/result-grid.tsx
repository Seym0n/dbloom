import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { CellView } from '~/components/grid/cell-view'
import type { Cell } from '~/server/db/rows'
import type { SqlColumnMeta } from '~/server/sql/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { columnWidths, isNumericColumn, nextSort, sortRows, type SortState } from './helpers'

const ROW_HEIGHT = 32

/**
 * Virtualised result grid. Rows are arrays, so duplicate or odd column names cannot collide
 * (FR-ISS-124). Sorting happens in the browser on the loaded rows and never touches the query text
 * (FR-ISS-144). Every cell is rendered by CellView as text, never as HTML (FR-SQL-030).
 */
export function ResultGrid({ columns, rows }: { columns: SqlColumnMeta[]; rows: Cell[][] }) {
  const [sort, setSort] = useState<SortState>()
  const scroller = useRef<HTMLDivElement>(null)
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort])
  const widths = useMemo(
    () =>
      columnWidths(
        columns.map((c) => c.name),
        rows,
      ),
    [columns, rows],
  )
  const total = widths.reduce((a, b) => a + b, 0)
  const template = widths.map((w) => `${w}px`).join(' ')

  const virtual = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  return (
    <div
      ref={scroller}
      tabIndex={0}
      role="grid"
      aria-label={t('sql.grid.label')}
      aria-rowcount={sorted.length + 1}
      aria-colcount={columns.length}
      className="max-h-[min(60vh,520px)] min-h-0 overflow-auto rounded-[var(--radius-control)] border border-rule"
    >
      <div style={{ width: Math.max(total, 0), minWidth: '100%' }}>
        <div
          role="row"
          className="sticky top-0 z-10 grid border-b border-border bg-surface"
          style={{ gridTemplateColumns: template }}
        >
          {columns.map((col, c) => {
            const numeric = isNumericColumn(col.type)
            const active = sort?.column === c ? sort.direction : undefined
            return (
              <div
                key={c}
                role="columnheader"
                aria-sort={
                  active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'
                }
                className="min-w-0"
              >
                <button
                  type="button"
                  onClick={() => setSort((s) => nextSort(s, c))}
                  title={col.table ? `${col.table}.${col.name}` : col.name}
                  className={cn(
                    'press flex h-9 w-full items-center gap-1 px-3 text-xs whitespace-nowrap text-muted hover:text-ink pointer-coarse:h-11',
                    numeric && 'justify-end',
                  )}
                >
                  <span className="truncate">{col.name}</span>
                  {active === 'asc' && (
                    <ArrowUp size={12} aria-hidden className="shrink-0 text-ink" />
                  )}
                  {active === 'desc' && (
                    <ArrowDown size={12} aria-hidden className="shrink-0 text-ink" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
        <div role="rowgroup" className="relative" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const row = sorted[item.index] ?? []
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                className="absolute top-0 left-0 grid border-b border-rule hover:bg-raised"
                style={{
                  gridTemplateColumns: template,
                  height: ROW_HEIGHT,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {columns.map((col, c) => (
                  <div
                    key={c}
                    role="gridcell"
                    className={cn(
                      'min-w-0 truncate px-3 text-sm leading-8',
                      isNumericColumn(col.type) && 'text-right font-mono text-[13px]',
                    )}
                  >
                    <CellView cell={row[c] ?? null} />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
