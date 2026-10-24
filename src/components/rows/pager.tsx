import { useId } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, LoaderCircle } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Select } from '~/components/ui/select'
import type { RowsTotal } from '~/server/rows/types'
import { numberFormat } from '~/components/grid/cell-view'
import { t } from '~/i18n'
import {
  describeTotal,
  formatMs,
  lastPageIndex,
  pageCount,
  rowRange,
  type TotalText,
} from './grid-model'

export type CountView =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'timeout' }
  | { status: 'cancelled' }
  | { status: 'failed' }
  | { status: 'done'; durationMs: number }

export function totalLabel(total: TotalText): string {
  switch (total.key) {
    case 'exact':
      return t('rows.grid.totalExact', { count: numberFormat.format(total.value) })
    case 'estimate':
      return t('rows.grid.totalEstimate', { count: numberFormat.format(total.value) })
    case 'lowerBound':
      return t('rows.grid.totalLowerBound', { count: numberFormat.format(total.value) })
    case 'unknown':
      return t('rows.grid.totalUnknown')
  }
}

/**
 * Range and total on the left, "Count" next to it, page size and page buttons on the right. "Last page" is
 * on only with an exact total and says why otherwise; "Count" turns into "Cancel" while it runs
 * (FR-ROW-007). The line is an aria-live region so a new total is announced.
 */
export function Pager({
  page,
  pageSize,
  pageSizes,
  rowsOnPage,
  hasNext,
  hasPrev,
  total,
  count,
  pageMs,
  busy,
  deepOffset,
  onPage,
  onPageSize,
  onCount,
  onCancelCount,
}: {
  page: number
  pageSize: number
  pageSizes: readonly number[]
  rowsOnPage: number
  hasNext: boolean
  hasPrev: boolean
  total: RowsTotal
  count: CountView
  pageMs?: number
  busy: boolean
  deepOffset?: boolean
  onPage: (page: number) => void
  onPageSize: (size: number) => void
  onCount: () => void
  onCancelCount: () => void
}) {
  const id = useId()
  const range = rowRange(page, pageSize, rowsOnPage)
  const last = lastPageIndex(total, pageSize)
  const pages = pageCount(total, pageSize)
  const text = describeTotal(total)
  const exact = total.kind === 'exact'
  const lastDisabled = last === undefined || page >= last
  const counting = count.status === 'running'

  return (
    <div className="flex flex-col gap-1.5 px-6 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm text-muted" aria-live="polite" aria-atomic="true">
          {range && (
            <span>
              {t('rows.grid.range', {
                from: numberFormat.format(range.from),
                to: numberFormat.format(range.to),
              })}
              {' · '}
            </span>
          )}
          <span className="text-ink">{totalLabel(text)}</span>
        </p>

        {!exact && (
          <Button
            className="h-7 px-2.5 text-xs pointer-coarse:h-11"
            onClick={counting ? onCancelCount : onCount}
            aria-describedby={`${id}-count`}
          >
            {counting && (
              <LoaderCircle
                size={12}
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {counting ? t('rows.grid.countCancel') : t('rows.grid.count')}
          </Button>
        )}
        <p id={`${id}-count`} className="text-xs text-muted" aria-live="polite">
          {count.status === 'running' && t('rows.grid.counting')}
          {count.status === 'timeout' && t('rows.grid.countTimeout')}
          {count.status === 'cancelled' && t('rows.grid.countCancelled')}
          {count.status === 'failed' && t('rows.grid.countFailed')}
          {count.status === 'idle' &&
            !exact &&
            total.kind === 'estimate' &&
            t('rows.grid.countHint')}
        </p>

        <p className="text-xs text-muted">
          {pageMs !== undefined && t('rows.grid.timePage', { time: formatMs(pageMs) })}
          {count.status === 'done' &&
            ` · ${t('rows.grid.timeCount', { time: formatMs(count.durationMs) })}`}
        </p>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted">
            {t('table.pageSize')}
            <Select
              compact
              className="w-auto pointer-coarse:h-11"
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <nav aria-label={t('rows.grid.paging')} className="flex items-center gap-1">
            <Button
              size="icon"
              className="pointer-coarse:h-11 pointer-coarse:w-11"
              aria-label={t('rows.grid.first')}
              disabled={page === 0 || busy}
              onClick={() => onPage(0)}
            >
              <ChevronsLeft size={14} aria-hidden />
            </Button>
            <Button
              size="icon"
              className="pointer-coarse:h-11 pointer-coarse:w-11"
              aria-label={t('table.previous')}
              disabled={(page === 0 && !hasPrev) || busy}
              onClick={() => onPage(Math.max(0, page - 1))}
            >
              <ChevronLeft size={14} aria-hidden />
            </Button>
            <span className="min-w-16 px-1 text-center text-sm text-muted" aria-live="polite">
              {pages === undefined
                ? t('rows.grid.page', { page: numberFormat.format(page + 1) })
                : t('rows.grid.pageOf', {
                    page: numberFormat.format(page + 1),
                    pages: numberFormat.format(pages),
                  })}
            </span>
            <Button
              size="icon"
              className="pointer-coarse:h-11 pointer-coarse:w-11"
              aria-label={t('table.next')}
              disabled={!hasNext || busy}
              onClick={() => onPage(page + 1)}
            >
              <ChevronRight size={14} aria-hidden />
            </Button>
            <Button
              size="icon"
              className="pointer-coarse:h-11 pointer-coarse:w-11"
              aria-label={t('rows.grid.last')}
              aria-describedby={lastDisabled && last === undefined ? `${id}-last` : undefined}
              title={last === undefined ? t('rows.grid.lastNeedsCount') : undefined}
              disabled={lastDisabled || busy}
              onClick={() => last !== undefined && onPage(last)}
            >
              <ChevronsRight size={14} aria-hidden />
            </Button>
            <span id={`${id}-last`} className="sr-only">
              {t('rows.grid.lastNeedsCount')}
            </span>
          </nav>
        </div>
      </div>
      {deepOffset && (
        <p className="text-xs text-[var(--pill-warning-ink)]" role="note">
          {t('rows.grid.deepOffset')}
        </p>
      )}
    </div>
  )
}
