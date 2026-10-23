import { useEffect, useId, useMemo, useState } from 'react'
import { Ban, Check, Minus } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { numberFormat } from '~/components/grid/cell-view'
import type { SqlRunResponse, SqlStatementResult, SqlWarning } from '~/server/sql/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { SqlView, type Product } from './editor'
import { formatDuration } from './helpers'
import { CopyButton, Notice, Pill } from './parts'
import { ResultGrid } from './result-grid'

export type DoneResponse = Extract<SqlRunResponse, { kind: 'done' }>

type Result = SqlStatementResult

function statusOf(r: Result): 'rows' | 'ok' | 'failed' | 'not-run' {
  return r.status
}

function StatusGlyph({ result }: { result: Result }) {
  const s = statusOf(result)
  if (s === 'failed') return <Ban size={12} aria-hidden className="text-negative" />
  if (s === 'not-run') return <Minus size={12} aria-hidden className="text-faint" />
  return <Check size={12} aria-hidden className="text-positive" />
}

function QueryStrip({
  sql,
  product,
  onReveal,
}: {
  sql: string
  product?: Product
  onReveal: () => void
}) {
  return (
    <div className="flex items-start gap-3 border-t border-rule pt-2">
      <span className="shrink-0 pt-1 text-xs text-muted">{t('sql.strip.label')}</span>
      <div
        className="max-h-16 min-w-0 flex-1 overflow-auto"
        tabIndex={0}
        aria-label={t('sql.strip.aria')}
      >
        <SqlView text={sql} product={product} />
      </div>
      <CopyButton text={sql} label={t('sql.strip.copy')} />
      <Button variant="ghost" className="h-6 px-2 text-xs" onClick={onReveal}>
        {t('sql.strip.show')}
      </Button>
    </div>
  )
}

function Warnings({ items }: { items: SqlWarning[] }) {
  if (items.length === 0) return null
  return (
    <details className="rounded-[var(--radius-control)] bg-[var(--pill-warning-bg)] px-3 py-2 text-sm text-[var(--pill-warning-ink)]">
      <summary className="cursor-pointer select-none">
        {t('sql.result.warnings', { count: items.length })}
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((w, i) => (
          <li key={i} className="break-words">
            <span className="font-medium">
              {w.level} {w.code}
            </span>{' '}
            {w.message}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">{children}</p>
  )
}

function Panel({
  result,
  product,
  onReveal,
}: {
  result: Result
  product?: Product
  onReveal: (r: Result) => void
}) {
  if (result.status === 'not-run') {
    return (
      <div className="flex flex-col gap-3">
        <Meta>
          <Pill tone="neutral">
            <Minus size={12} aria-hidden />
            {t('sql.result.notRun')}
          </Pill>
        </Meta>
        <QueryStrip sql={result.sql} product={product} onReveal={() => onReveal(result)} />
      </div>
    )
  }

  if (result.status === 'failed') {
    const { error, position } = { error: result.error, position: result.error.position }
    return (
      <div className="flex flex-col gap-3">
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-[var(--radius-control)] bg-[var(--pill-negative-bg)] px-3 py-2 text-[var(--pill-negative-ink)]"
        >
          <p className="text-sm font-semibold break-words">
            {error.errno !== null
              ? t('sql.result.error', { errno: error.errno })
              : t('sql.result.errorPlain')}
            <span className="font-normal"> {error.message}</span>
          </p>
          {error.hint && <p className="text-sm break-words">{error.hint}</p>}
          {position && (
            <p className="text-sm">
              {t('sql.result.position', { line: position.line, column: position.column })}{' '}
              <button type="button" className="press underline" onClick={() => onReveal(result)}>
                {t('sql.result.showPosition')}
              </button>
            </p>
          )}
        </div>
        <Meta>
          <span>{formatDuration(result.durationMs)}</span>
        </Meta>
        <QueryStrip sql={result.sql} product={product} onReveal={() => onReveal(result)} />
      </div>
    )
  }

  if (result.status === 'ok') {
    return (
      <div className="flex flex-col gap-3">
        <Meta>
          <span className="font-medium text-ink">
            {t('sql.result.affected', { count: numberFormat.format(result.affectedRows) })}
          </span>
          {result.insertId !== undefined && result.insertId !== '0' && (
            <span>{t('sql.result.insertId', { id: result.insertId })}</span>
          )}
          <span>{formatDuration(result.durationMs)}</span>
        </Meta>
        {result.info && <p className="text-sm break-words text-muted">{result.info}</p>}
        <Warnings items={result.warnings} />
        <QueryStrip sql={result.sql} product={product} onReveal={() => onReveal(result)} />
      </div>
    )
  }

  const cut = result.truncated
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Meta>
        <span className="font-medium text-ink">
          {cut
            ? t('sql.result.rowsCut', { count: numberFormat.format(result.rowCount) })
            : t('sql.result.rows', { count: numberFormat.format(result.rowCount) })}
        </span>
        <span>{formatDuration(result.durationMs)}</span>
      </Meta>
      {cut && (
        <Notice role="status">
          {cut.reason === 'rows'
            ? t('sql.result.truncatedRows', {
                shown: numberFormat.format(result.rowCount),
                limit: numberFormat.format(cut.limit),
              })
            : t('sql.result.truncatedBytes', { shown: numberFormat.format(result.rowCount) })}
        </Notice>
      )}
      <Warnings items={result.warnings} />
      {result.rows.length === 0 ? (
        <p className="rounded-[var(--radius-control)] border border-dashed border-control px-3 py-2 text-sm text-muted">
          {t('sql.result.noRows')}
        </p>
      ) : (
        <ResultGrid columns={result.columns} rows={result.rows} />
      )}
      <QueryStrip sql={result.sql} product={product} onReveal={() => onReveal(result)} />
    </div>
  )
}

/**
 * Results of one statement are adjacent and share its `index`: a CALL gives one entry per result set and
 * one for the final OK packet. One group per statement, in order.
 */
export function groupByIndex(results: Result[]): Result[][] {
  const groups: Result[][] = []
  for (const r of results) {
    const last = groups[groups.length - 1]
    if (last && last[0]!.index === r.index) last.push(r)
    else groups.push([r])
  }
  return groups
}

/** Short summary line of a run: how many statements, how many failed or did not run. */
function summary(groups: Result[][]): string {
  const failed = groups.filter((g) => g.some((r) => r.status === 'failed')).length
  const notRun = groups.filter((g) => g.every((r) => r.status === 'not-run')).length
  const parts = [t('sql.run.statements', { count: groups.length })]
  if (failed > 0) parts.push(t('sql.run.failed', { count: failed }))
  if (notRun > 0) parts.push(t('sql.run.notRun', { count: notRun }))
  return parts.join(' · ')
}

/**
 * One panel per statement, tabs when there is more than one. A failed statement shows only its error
 * (FR-ISS-135); the statements around it keep their own results and show as executed or not run.
 */
export function ResultPanels({
  response,
  product,
  dimmed,
  onReveal,
}: {
  response: DoneResponse
  product?: Product
  dimmed?: boolean
  onReveal: (r: Result) => void
}) {
  const groups = useMemo(() => groupByIndex(response.results), [response])
  const firstFailed = groups.findIndex((g) => g.some((r) => r.status === 'failed'))
  const [selected, setSelected] = useState(firstFailed >= 0 ? firstFailed : 0)
  const id = useId()
  useEffect(() => {
    setSelected(firstFailed >= 0 ? firstFailed : 0)
  }, [response, firstFailed])
  const current = groups[Math.min(selected, groups.length - 1)]
  if (!current) return null

  function onKey(e: React.KeyboardEvent) {
    const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!move) return
    e.preventDefault()
    const next = (selected + move + groups.length) % groups.length
    setSelected(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }

  return (
    <section
      aria-label={t('sql.results.label')}
      className={cn('flex min-h-0 flex-col gap-3', dimmed && 'opacity-70')}
      aria-busy={dimmed}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{t('sql.results.title')}</h2>
        <p className="text-sm text-muted" aria-live="polite">
          {summary(groups)}
        </p>
      </div>
      {response.notes.map((n, i) => (
        <Notice key={i} tone="neutral" role="status">
          {n}
        </Notice>
      ))}
      {groups.length > 1 && (
        <div
          role="tablist"
          aria-label={t('sql.results.tabs')}
          className="flex gap-1 overflow-x-auto"
          onKeyDown={onKey}
        >
          {groups.map((g, i) => (
            <button
              key={i}
              id={`${id}-tab-${i}`}
              role="tab"
              type="button"
              aria-selected={i === selected}
              aria-controls={`${id}-panel`}
              tabIndex={i === selected ? 0 : -1}
              onClick={() => setSelected(i)}
              className={cn(
                'press flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm pointer-coarse:h-11',
                i === selected
                  ? 'bg-active font-medium text-ink'
                  : 'text-muted hover:bg-active/60 hover:text-ink',
              )}
            >
              <StatusGlyph result={g.find((r) => r.status === 'failed') ?? g[0]!} />
              {t('sql.results.tab', { n: i + 1 })}
            </button>
          ))}
        </div>
      )}
      <div
        id={`${id}-panel`}
        role={groups.length > 1 ? 'tabpanel' : undefined}
        className="flex min-h-0 flex-col gap-4"
      >
        {current.map((r, k) => (
          <Panel key={k} result={r} product={product} onReveal={onReveal} />
        ))}
      </div>
    </section>
  )
}

export function RunErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <Notice tone="negative">{message}</Notice>
      {onRetry && (
        <Button onClick={onRetry} className="h-7">
          {t('sql.err.retry')}
        </Button>
      )}
    </div>
  )
}
