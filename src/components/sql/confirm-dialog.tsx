import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Dialog } from '~/components/ui/dialog'
import { Label } from '~/components/ui/label'
import type {
  ClassificationReason,
  SqlPlanStatement,
  SqlRunOptions,
  SqlRunResponse,
} from '~/server/sql/types'
import { cn } from '~/lib/utils'
import { t, type MessageKey } from '~/i18n'
import { confirmPosition, expiryMs } from './helpers'
import { Notice, SqlClassBadge } from './parts'
import { estimateAffected } from './server-api'

export type ConfirmPlan = Extract<SqlRunResponse, { kind: 'confirm' }>

const REASON: Record<ClassificationReason, MessageKey> = {
  'no-where': 'sql.reason.noWhere',
  'constant-where': 'sql.reason.constantWhere',
  'limit-only': 'sql.reason.limitOnly',
  drop: 'sql.reason.drop',
  truncate: 'sql.reason.truncate',
  'alter-drop': 'sql.reason.alterDrop',
  narrowing: 'sql.reason.narrowing',
  account: 'sql.reason.account',
  'global-set': 'sql.reason.globalSet',
  'load-data': 'sql.reason.loadData',
  'into-outfile': 'sql.reason.intoOutfile',
  admin: 'sql.reason.admin',
  unparsed: 'sql.reason.unparsed',
  'unknown-keyword': 'sql.reason.unknownKeyword',
  'multi-statement-explain': 'sql.reason.multiExplain',
  'parser-off': 'sql.reason.parserOff',
  budget: 'sql.reason.budget',
}

const ESTIMATE_REASONS = new Set<ClassificationReason>(['no-where', 'constant-where', 'limit-only'])

function Estimate({ statement, db }: { statement: SqlPlanStatement; db?: string }) {
  const wanted = statement.reasons.some((r) => ESTIMATE_REASONS.has(r))
  // `fullSql` is the whole text; it is absent above 64 KiB, and an estimate of a cut text would be wrong.
  const text = statement.fullSql
  const q = useQuery({
    queryKey: ['sql', 'estimate', db ?? '', text ?? ''],
    enabled: wanted && text !== undefined,
    retry: false,
    staleTime: 60_000,
    queryFn: () => estimateAffected({ data: { ...(db ? { db } : {}), text: text ?? '' } }),
  })
  const rows = q.data?.estimatedRows
  if (rows == null) return null
  return (
    <span className="text-xs text-muted">
      {t('sql.confirm.estimate', { count: new Intl.NumberFormat('en-US').format(rows) })}
    </span>
  )
}

/**
 * Confirmation for statements the server classed soft or hard (FR-SQL-008). The text comes from the plan's
 * statements; the server holds the plan and, for hard statements, the token this dialog sends back.
 * Escape and the backdrop cancel; nothing runs until the button is pressed.
 */
export function SqlConfirmDialog({
  plan,
  options,
  db,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  plan: ConfirmPlan | null
  options: SqlRunOptions
  db?: string
  busy: boolean
  error: string | null
  onConfirm: (plan: ConfirmPlan) => void
  onCancel: () => void
}) {
  const titleId = useId()
  return (
    <Dialog
      open={plan !== null}
      onClose={() => !busy && onCancel()}
      labelledBy={titleId}
      className="w-[min(680px,calc(100vw-32px))]"
    >
      {plan && (
        <Body
          key={plan.planId}
          plan={plan}
          options={options}
          db={db}
          busy={busy}
          error={error}
          titleId={titleId}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </Dialog>
  )
}

function Body({
  plan,
  options,
  db,
  busy,
  error,
  titleId,
  onConfirm,
  onCancel,
}: {
  plan: ConfirmPlan
  options: SqlRunOptions
  db?: string
  busy: boolean
  error: string | null
  titleId: string
  onConfirm: (plan: ConfirmPlan) => void
  onCancel: () => void
}) {
  const [ack, setAck] = useState(false)
  const [expired, setExpired] = useState(() => Date.now() > expiryMs(plan.expiresAt))
  const ackId = useId()
  const hard = plan.maxClass === 'hard'
  useEffect(() => {
    const left = expiryMs(plan.expiresAt) - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setExpired(true), Math.min(left, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [plan.expiresAt])
  const position = (s: SqlPlanStatement) =>
    confirmPosition(s.index, plan.statements.length, plan.totalStatements)
  const needsAck = hard && plan.confirmRequired
  const canRun = !busy && !expired && (!needsAck || ack)

  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col">
      <header className="shrink-0 px-6 pt-5 pb-3">
        <h2 id={titleId} className="text-base font-semibold">
          {hard ? t('sql.confirm.titleHard') : t('sql.confirm.titleSoft')}
        </h2>
        <p className="text-sm text-muted">
          {hard ? t('sql.confirm.bodyHard') : t('sql.confirm.bodySoft')}
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        <ol className="flex flex-col gap-3">
          {plan.statements.map((s) => (
            <li key={s.index} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {position(s) && (
                  <span className="text-xs text-muted">
                    {t('sql.confirm.statement', position(s)!)}
                  </span>
                )}
                <SqlClassBadge value={s.class} />
                {s.reasons.map((r) => (
                  <span key={r} className="text-sm">
                    {t(REASON[r])}
                  </span>
                ))}
                <Estimate statement={s} db={db} />
              </div>
              <pre
                tabIndex={0}
                className="max-h-40 overflow-auto rounded-[var(--radius-control)] bg-raised px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-ink select-text"
              >
                {s.sql}
              </pre>
            </li>
          ))}
        </ol>

        <Notice tone="neutral">
          {options.singleTransaction ? t('sql.confirm.transaction') : t('sql.confirm.autocommit')}
        </Notice>
        {options.disableForeignKeyChecks && <Notice>{t('sql.confirm.fkOff')}</Notice>}

        {needsAck && (
          <div className="flex items-start gap-2 rounded-[var(--radius-card)] bg-[var(--pill-negative-bg)] p-3 text-[var(--pill-negative-ink)]">
            <Checkbox
              id={ackId}
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            <Label htmlFor={ackId} className="font-normal text-[var(--pill-negative-ink)]">
              {t('sql.confirm.acknowledge')}
            </Label>
          </div>
        )}
        {expired && <Notice tone="negative">{t('sql.confirm.expired')}</Notice>}
        {error && <Notice tone="negative">{error}</Notice>}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-raised px-6 py-3">
        <Button disabled={busy} onClick={onCancel}>
          {t('sql.confirm.cancel')}
        </Button>
        <Button
          variant={hard ? 'outline' : 'primary'}
          className={cn(hard && 'border-negative text-negative hover:bg-[var(--pill-negative-bg)]')}
          disabled={!canRun}
          onClick={() => onConfirm(plan)}
        >
          {busy ? t('sql.running') : hard ? t('sql.confirm.runHard') : t('sql.confirm.run')}
        </Button>
      </footer>
    </div>
  )
}
