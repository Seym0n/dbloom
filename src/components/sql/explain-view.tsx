import { useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import type { SqlExplainResponse } from '~/server/sql/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { formatDuration } from './helpers'
import { Notice } from './parts'
import { buildPlan, prettyRaw, type PlanNode } from './plan-adapter'

export type ExplainFormat = 'json' | 'tree' | 'text'
const FORMATS: ExplainFormat[] = ['json', 'tree', 'text']

function Node({ node }: { node: PlanNode }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-[var(--radius-control)] bg-raised px-3 py-1.5">
        <span className="min-w-0 text-sm font-medium break-words">{node.label}</span>
        {node.facts.map((f) => (
          <span key={f} className="font-mono text-xs text-muted">
            {f}
          </span>
        ))}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-4 flex flex-col gap-1 border-l border-rule pl-3">
          {node.children.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Explain and analyse output (FR-SQL-021): a tree built from the JSON or tree text, and always the raw
 * server text. Refresh runs the same request again. Everything is rendered as text.
 */
export function ExplainView({
  statement,
  result,
  loading,
  error,
  mode,
  format,
  onFormat,
  onRefresh,
  onClose,
}: {
  statement: string
  result: SqlExplainResponse | null
  loading: boolean
  error: string | null
  mode: 'explain' | 'analyse'
  format: ExplainFormat
  onFormat: (f: ExplainFormat) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const [view, setView] = useState<'tree' | 'raw'>('tree')
  const plan = useMemo(() => (result ? buildPlan(result.raw) : []), [result])
  const showTree = view === 'tree' && plan.length > 0

  return (
    <section
      aria-label={t('sql.explain.label')}
      className={cn('flex min-h-0 flex-col gap-3', loading && 'opacity-70')}
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">
          {mode === 'analyse' ? t('sql.explain.titleAnalyse') : t('sql.explain.title')}
        </h2>
        {result && <span className="text-sm text-muted">{formatDuration(result.durationMs)}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('sql.explain.format')} className="flex gap-1">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={format === f}
                onClick={() => onFormat(f)}
                className={cn(
                  'press h-7 rounded-[var(--radius-control)] px-2 text-xs pointer-coarse:h-11',
                  format === f
                    ? 'bg-active font-medium text-ink'
                    : 'text-muted hover:bg-active/60 hover:text-ink',
                )}
              >
                {t(`sql.explain.format.${f}`)}
              </button>
            ))}
          </div>
          <Button className="h-7" disabled={loading} onClick={onRefresh}>
            <RefreshCw size={12} aria-hidden />
            {t('sql.explain.refresh')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('sql.explain.close')}
            onClick={onClose}
          >
            <X size={14} aria-hidden />
          </Button>
        </div>
      </div>
      <p className="truncate font-mono text-xs text-muted" title={statement}>
        {statement}
      </p>
      {mode === 'analyse' && <Notice tone="neutral">{t('sql.explain.analyseNote')}</Notice>}
      {error && <Notice tone="negative">{error}</Notice>}
      {loading && !result && (
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="h-8 rounded bg-active" />
          <div className="ml-4 h-8 rounded bg-active" />
        </div>
      )}
      {result && (
        <>
          <div role="tablist" aria-label={t('sql.explain.view')} className="flex gap-1">
            {(['tree', 'raw'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                type="button"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'press h-8 rounded-[var(--radius-control)] px-3 text-sm pointer-coarse:h-11',
                  view === v
                    ? 'bg-active font-medium text-ink'
                    : 'text-muted hover:bg-active/60 hover:text-ink',
                )}
              >
                {t(v === 'tree' ? 'sql.explain.tree' : 'sql.explain.raw')}
              </button>
            ))}
          </div>
          {view === 'tree' && plan.length === 0 && (
            <p className="text-sm text-muted">{t('sql.explain.noTree')}</p>
          )}
          {showTree ? (
            <ul className="flex max-h-[min(50vh,420px)] flex-col gap-1 overflow-auto" tabIndex={0}>
              {plan.map((n, i) => (
                <Node key={i} node={n} />
              ))}
            </ul>
          ) : (
            <pre
              tabIndex={0}
              className="max-h-[min(50vh,420px)] overflow-auto rounded-[var(--radius-control)] bg-raised px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-ink select-text"
            >
              {prettyRaw(result.raw)}
            </pre>
          )}
        </>
      )}
    </section>
  )
}
