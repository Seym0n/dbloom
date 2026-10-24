/**
 * Preview, confirmation and the whole "send a change" flow for rows (FR-ROW-019, 020, 021, SCN-040, 041):
 *
 *  - `RowPlanDialog`: the exact statements, the class badge and the reasons, the cascade and `all-columns`
 *    warnings, a typed confirmation for the hard class, and the token flow of the server. Focus starts on Cancel.
 *  - `PlanPreviewDialog`: "Show SQL" before anything runs (never executed, never sent back).
 *  - `useRowChanger`: `changeRows` -> done | confirm | conflict | gone | error, then `confirmRows`.
 *
 * It reuses the typed-name and acknowledge parts and the class badge of the structure module; the SQL block
 * and the copy button are small local copies because `preview-dialog.tsx` does not export them.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { ClassBadge } from '~/components/structure/class-badge'
import { TypedNameConfirm } from '~/components/structure/confirm-dialog'
import { cn } from '~/lib/utils'
import { t, type MessageKey } from '~/i18n'
import type {
  ChangeRowsResponse,
  RowChange,
  RowClassReason,
  RowPlanInfo,
  RowsError,
  RowTable,
} from '~/server/rows/types'
import {
  ConflictDialog,
  GoneDialog,
  overwriteChange,
  type ConflictResponse,
} from './conflict-dialog'
import { describeRowsRefusal, formsApi } from './server-api-forms'

export type ConfirmResponse = Extract<ChangeRowsResponse, { kind: 'confirm' }>
export type DoneResponse = Extract<ChangeRowsResponse, { kind: 'done' }>

export const changeRowCount = (change: RowChange) =>
  change.op === 'insert' ? change.rows.length : change.targets.length

const plural = new Intl.PluralRules('en')
export const rowsText = (count: number) =>
  t(plural.select(count) === 'one' ? 'rows.dialog.rows.one' : 'rows.dialog.rows.other', {
    count: new Intl.NumberFormat('en-US').format(count),
  })

// ---- Small parts -------------------------------------------------------------------------------------------------------

export function SqlBlock({ sql, label }: { sql: string; label?: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="max-h-40 overflow-auto rounded-[var(--radius-control)] bg-raised px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-ink select-text"
    >
      {sql}
    </pre>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      className="h-6 px-2 text-xs"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      <span aria-live="polite">{copied ? t('table.copied') : t('table.copy')}</span>
    </Button>
  )
}

export function Alert({
  children,
  tone = 'warning',
}: {
  children: ReactNode
  tone?: 'warning' | 'negative'
}) {
  return (
    <p
      role={tone === 'negative' ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm',
        tone === 'warning'
          ? 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]'
          : 'bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]',
      )}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

/** Moves the focus to an element once the native dialog is open (children mount before `showModal`). */
export function useFocusOnOpen(id: string) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById(id)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [id])
}

const REASON: Record<RowClassReason, MessageKey> = {
  'no-key': 'rows.dialog.reason.noKey',
  bulk: 'rows.dialog.reason.bulk',
  cascade: 'rows.dialog.reason.cascade',
  'no-rollback': 'rows.dialog.reason.noRollback',
  delete: 'rows.dialog.reason.delete',
  'engine-nontransactional': 'rows.dialog.reason.nonTransactional',
}

export const expiryMs = (at: number) => (at < 1e12 ? at * 1000 : at)

// ---- The plan: statements, reasons, warnings --------------------------------------------------------------------------------

export function PlanBody({ plan, tableName }: { plan: RowPlanInfo; tableName?: string }) {
  const more = plan.totalStatements - plan.statements.length
  return (
    <div className="flex flex-col gap-4">
      {plan.warnings.map((w) => (
        <Alert key={w.code}>{w.message}</Alert>
      ))}
      {plan.reasons.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {plan.reasons.map((r) => (
            <li key={r}>{t(REASON[r])}</li>
          ))}
        </ul>
      )}
      {plan.cascadeTables && plan.cascadeTables.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('rows.dialog.cascadeTitle')}</p>
          <ul className="list-disc pl-5 text-sm">
            {plan.cascadeTables.map((c) => (
              <li key={`${c.db}.${c.table}.${c.fk}`} className="font-mono text-xs">
                {c.db}.{c.table} ({c.fk})
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.identityKind === 'all-columns' && (
        <Alert>
          {t('rows.dialog.allColumns', {
            count: plan.matchCount ?? 1,
            table: tableName ?? '',
          })}
        </Alert>
      )}
      <ol className="flex flex-col gap-3" aria-label={t('rows.dialog.statements')}>
        {plan.statements.map((s, i) => (
          <li key={i} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs text-muted">
                {t('rows.dialog.step', { n: i + 1, total: plan.totalStatements })}
              </span>
              <ClassBadge value={s.class} />
              <span className="min-w-0 flex-1 text-sm break-words">{s.effect}</span>
              <CopyButton text={s.preview} label={t('rows.dialog.copyStep', { n: i + 1 })} />
            </div>
            <SqlBlock sql={s.preview} label={t('rows.dialog.sqlOf', { n: i + 1 })} />
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{t('rows.dialog.parameterised')}</summary>
              <SqlBlock sql={s.sql} />
            </details>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <p className="text-sm text-muted">{t('rows.dialog.andMore', { count: more })}</p>
      )}
    </div>
  )
}

// ---- Confirmation -------------------------------------------------------------------------------------------------------------

export type RowOperation = 'insert' | 'update' | 'delete'

export function RowPlanDialog({
  plan,
  operation,
  rowCount,
  tableName,
  busy,
  error,
  canRetry,
  onConfirm,
  onCancel,
  onRetry,
}: {
  plan: ConfirmResponse | null
  operation: RowOperation
  rowCount: number
  tableName: string
  busy: boolean
  error: string | null
  canRetry: boolean
  onConfirm: (plan: ConfirmResponse) => void
  onCancel: () => void
  onRetry: () => void
}) {
  const titleId = useId()
  return (
    <Dialog
      open={plan !== null}
      onClose={() => !busy && onCancel()}
      labelledBy={titleId}
      className="w-[min(720px,calc(100vw-32px))]"
    >
      {plan && (
        <PlanDialogBody
          key={plan.planId}
          plan={plan}
          operation={operation}
          rowCount={rowCount}
          tableName={tableName}
          busy={busy}
          error={error}
          canRetry={canRetry}
          titleId={titleId}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onRetry={onRetry}
        />
      )}
    </Dialog>
  )
}

const TITLE: Record<RowOperation, [MessageKey, MessageKey]> = {
  delete: ['rows.dialog.title.deleteSoft', 'rows.dialog.title.deleteHard'],
  update: ['rows.dialog.title.updateSoft', 'rows.dialog.title.updateHard'],
  insert: ['rows.dialog.title.insertSoft', 'rows.dialog.title.insertHard'],
}
const RUN: Record<RowOperation, MessageKey> = {
  delete: 'rows.dialog.run.delete',
  update: 'rows.dialog.run.update',
  insert: 'rows.dialog.run.insert',
}

function PlanDialogBody({
  plan,
  operation,
  rowCount,
  tableName,
  busy,
  error,
  canRetry,
  titleId,
  onConfirm,
  onCancel,
  onRetry,
}: {
  plan: ConfirmResponse
  operation: RowOperation
  rowCount: number
  tableName: string
  busy: boolean
  error: string | null
  canRetry: boolean
  titleId: string
  onConfirm: (plan: ConfirmResponse) => void
  onCancel: () => void
  onRetry: () => void
}) {
  const [typed, setTyped] = useState('')
  const [expired, setExpired] = useState(() => Date.now() > expiryMs(plan.expiresAt))
  const cancelId = useId()
  useFocusOnOpen(cancelId)
  useEffect(() => {
    const left = expiryMs(plan.expiresAt) - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setExpired(true), Math.min(left, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [plan.expiresAt])

  const hard = plan.maxClass === 'hard'
  const needsTyped = hard && plan.confirmRequired
  const confirmed = !needsTyped || typed === tableName
  const canRun = !busy && !expired && confirmed
  const resend = expired || canRetry

  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col">
      <header className="shrink-0 px-6 pt-5 pb-3">
        <h2 id={titleId} className="text-base font-semibold">
          {t(TITLE[operation][hard ? 1 : 0])}
        </h2>
        <p className="text-sm text-muted">
          {t(hard ? 'rows.dialog.bodyHard' : 'rows.dialog.bodySoft', { rows: rowsText(rowCount) })}
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        <PlanBody plan={plan} tableName={tableName} />
        {needsTyped && (
          <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-[var(--pill-negative-bg)] p-3 text-[var(--pill-negative-ink)]">
            <p className="text-sm font-medium">{t('rows.dialog.dataLoss')}</p>
            <TypedNameConfirm name={tableName} value={typed} onChange={setTyped} disabled={busy} />
          </div>
        )}
        {expired && !error && <Alert tone="negative">{t('rows.dialog.expired')}</Alert>}
        {error && <Alert tone="negative">{error}</Alert>}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-raised px-6 py-3">
        <Button id={cancelId} disabled={busy} onClick={onCancel}>
          {t('rows.dialog.cancel')}
        </Button>
        {resend ? (
          <Button variant="primary" disabled={busy} onClick={onRetry}>
            {t('rows.dialog.again')}
          </Button>
        ) : (
          <Button
            variant={hard ? 'outline' : 'primary'}
            className={cn(
              hard && 'border-negative text-negative hover:bg-[var(--pill-negative-bg)]',
            )}
            disabled={!canRun}
            onClick={() => onConfirm(plan)}
          >
            {busy ? t('rows.dialog.working') : t(RUN[operation], { rows: rowsText(rowCount) })}
          </Button>
        )}
      </footer>
    </div>
  )
}

// ---- Show SQL ---------------------------------------------------------------------------------------------------------------------

export function PlanPreviewDialog({
  open,
  loading,
  info,
  error,
  tableName,
  onClose,
}: {
  open: boolean
  loading: boolean
  info: RowPlanInfo | null
  error: string | null
  tableName: string
  onClose: () => void
}) {
  const titleId = useId()
  const closeId = useId()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className="w-[min(720px,calc(100vw-32px))]"
    >
      <PreviewBody
        loading={loading}
        info={info}
        error={error}
        tableName={tableName}
        titleId={titleId}
        closeId={closeId}
        onClose={onClose}
      />
    </Dialog>
  )
}

function PreviewBody({
  loading,
  info,
  error,
  tableName,
  titleId,
  closeId,
  onClose,
}: {
  loading: boolean
  info: RowPlanInfo | null
  error: string | null
  tableName: string
  titleId: string
  closeId: string
  onClose: () => void
}) {
  useFocusOnOpen(closeId)
  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col">
      <header className="shrink-0 px-6 pt-5 pb-3">
        <h2 id={titleId} className="text-base font-semibold">
          {t('rows.dialog.previewTitle')}
        </h2>
        <p className="text-sm text-muted">{t('rows.dialog.previewBody')}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4" aria-busy={loading}>
        {loading && <p className="text-sm text-muted">{t('rows.dialog.working')}</p>}
        {error && <Alert tone="negative">{error}</Alert>}
        {info && <PlanBody plan={info} tableName={tableName} />}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 bg-raised px-6 py-3">
        <Button id={closeId} variant="primary" onClick={onClose}>
          {t('rows.dialog.close')}
        </Button>
      </footer>
    </div>
  )
}

// ---- Failure ---------------------------------------------------------------------------------------------------------------------------

export type Failure = {
  message: string
  hint?: string
  errno?: number | null
  field?: string
  rowIndex?: number
  /** False when the connection dropped: it is not known whether the write applied (G5). */
  known?: boolean
  rolledBack?: number
  applied?: number
}

export function ErrorDialog({
  failure,
  onClose,
}: {
  failure: Failure | null
  onClose: () => void
}) {
  const titleId = useId()
  const closeId = useId()
  return (
    <Dialog
      open={failure !== null}
      onClose={onClose}
      labelledBy={titleId}
      className="w-[min(560px,calc(100vw-32px))]"
    >
      {failure && (
        <div className="flex flex-col">
          <ErrorBody failure={failure} titleId={titleId} closeId={closeId} onClose={onClose} />
        </div>
      )}
    </Dialog>
  )
}

function ErrorBody({
  failure,
  titleId,
  closeId,
  onClose,
}: {
  failure: Failure
  titleId: string
  closeId: string
  onClose: () => void
}) {
  useFocusOnOpen(closeId)
  return (
    <>
      <header className="px-6 pt-5 pb-3">
        <h2 id={titleId} className="text-base font-semibold">
          {t('rows.dialog.failedTitle')}
        </h2>
      </header>
      <div className="flex flex-col gap-3 px-6 pb-4">
        <Alert tone="negative">
          {failure.errno != null && (
            <span className="font-medium">
              {t('structure.result.errno', { errno: failure.errno })}{' '}
            </span>
          )}
          {failure.message}
        </Alert>
        {failure.hint && <p className="text-sm break-words">{failure.hint}</p>}
        {failure.known === false && <Alert>{t('rows.dialog.unknownOutcome')}</Alert>}
        {(failure.rolledBack ?? 0) > 0 && (
          <p className="text-sm text-muted">
            {t('rows.dialog.rolledBack', { count: failure.rolledBack ?? 0 })}
          </p>
        )}
        {(failure.applied ?? 0) > 0 && (
          <p className="text-sm text-muted">
            {t('rows.dialog.applied', { count: failure.applied ?? 0 })}
          </p>
        )}
      </div>
      <footer className="flex justify-end gap-2 bg-raised px-6 py-3">
        <Button id={closeId} variant="primary" onClick={onClose}>
          {t('rows.dialog.close')}
        </Button>
      </footer>
    </>
  )
}

// ---- The flow -------------------------------------------------------------------------------------------------------------------------

export type SettledReason = 'cancelled' | 'failed' | 'gone' | 'reloaded'

export type RowChangerOptions = {
  db: string
  table: string
  model: RowTable | null
  /** User preference: skip the confirmation of soft plans (ST-120). Hard plans ignore it. */
  acceptSoft?: boolean
  /** The change was applied (the final `done` answer). */
  onDone: (response: DoneResponse, change: RowChange) => void
  /**
   * An error answer or a refusal. When given, the caller shows it (the form marks the field); otherwise
   * the changer opens its own error dialog.
   */
  onError?: (failure: Failure, change: RowChange) => void
  /** "Reload row" in the conflict dialog. */
  onReload?: (conflict: ConflictResponse, change: RowChange) => void
  /** The flow ended without applying the change (cancel, closed error, reload). */
  onSettled?: (reason: SettledReason, change: RowChange) => void
}

const failureOf = (
  error: RowsError,
  r: Extract<ChangeRowsResponse, { kind: 'error' }>,
): Failure => ({
  message: error.message,
  hint: error.hint,
  errno: error.errno,
  field: error.field,
  rowIndex: error.rowIndex,
  known: r.known,
  rolledBack: r.outcomes.filter((o) => o.status === 'rolled-back').length,
  applied: r.outcomes.filter((o) => o.status === 'applied').length,
})

/**
 * Sends a change and walks the answers. Render `dialogs` once next to the caller; call `submit(change)`.
 * Nothing runs for a soft or hard plan before the user confirms in `RowPlanDialog`.
 */
export function useRowChanger(options: RowChangerOptions) {
  const ref = useRef(options)
  ref.current = options
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<{ resp: ConfirmResponse; change: RowChange } | null>(null)
  const [planError, setPlanError] = useState<{ message: string; retry: boolean } | null>(null)
  const [conflict, setConflict] = useState<{ resp: ConflictResponse; change: RowChange } | null>(
    null,
  )
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [gone, setGone] = useState<{ index: number; change: RowChange } | null>(null)
  const [failure, setFailure] = useState<{ failure: Failure; change: RowChange } | null>(null)

  const clear = useCallback(() => {
    setPlan(null)
    setPlanError(null)
    setConflict(null)
    setConflictError(null)
  }, [])

  const fail = useCallback(
    (f: Failure, change: RowChange) => {
      clear()
      if (ref.current.onError) ref.current.onError(f, change)
      else setFailure({ failure: f, change })
    },
    [clear],
  )

  const handle = useCallback(
    (r: ChangeRowsResponse, change: RowChange) => {
      switch (r.kind) {
        case 'done':
          clear()
          ref.current.onDone(r, change)
          return
        case 'confirm':
          setPlanError(null)
          setPlan({ resp: r, change })
          return
        case 'conflict':
          setPlan(null)
          setConflictError(null)
          setConflict({ resp: r, change })
          return
        case 'gone':
          clear()
          setGone({ index: r.index, change })
          return
        case 'error':
          fail(failureOf(r.error, r), change)
          return
      }
    },
    [clear, fail],
  )

  const submit = useCallback(
    async (change: RowChange, extra?: { overwrite?: boolean }) => {
      setBusy(true)
      try {
        const r = await formsApi().changeRows({
          db: ref.current.db,
          table: ref.current.table,
          change,
          overwrite: extra?.overwrite ?? false,
          acceptSoft: ref.current.acceptSoft ?? false,
        })
        handle(r, change)
      } catch (e) {
        fail({ message: describeRowsRefusal(e).message }, change)
      } finally {
        setBusy(false)
      }
    },
    [handle, fail],
  )

  async function confirm(resp: ConfirmResponse, change: RowChange) {
    setBusy(true)
    setPlanError(null)
    try {
      const r = await formsApi().confirmRows({
        planId: resp.planId,
        confirmToken: resp.confirmRequired ? resp.confirmToken : undefined,
      })
      handle(r, change)
    } catch (e) {
      const d = describeRowsRefusal(e)
      setPlanError({ message: d.message, retry: d.offerNewPreview })
    } finally {
      setBusy(false)
    }
  }

  const operation: RowOperation = (plan?.change ?? conflict?.change)?.op ?? 'update'

  const dialogs = (
    <>
      <RowPlanDialog
        plan={plan?.resp ?? null}
        operation={plan?.change.op ?? 'update'}
        rowCount={plan ? changeRowCount(plan.change) : 0}
        tableName={options.table}
        busy={busy}
        error={planError?.message ?? null}
        canRetry={planError?.retry ?? false}
        onConfirm={(resp) => plan && void confirm(resp, plan.change)}
        onCancel={() => {
          const change = plan?.change
          clear()
          if (change) ref.current.onSettled?.('cancelled', change)
        }}
        onRetry={() => {
          const change = plan?.change
          clear()
          if (change) void submit(change)
        }}
      />
      <ConflictDialog
        conflict={conflict?.resp ?? null}
        change={conflict?.change ?? null}
        model={options.model}
        total={conflict ? changeRowCount(conflict.change) : 1}
        busy={busy}
        error={conflictError}
        onReload={(resp) => {
          const change = conflict?.change
          clear()
          if (change) {
            ref.current.onReload?.(resp, change)
            ref.current.onSettled?.('reloaded', change)
          }
        }}
        onOverwrite={(resp) => {
          if (!conflict) return
          const next = options.model
            ? overwriteChange(conflict.change, resp, options.model)
            : conflict.change
          void submit(next, { overwrite: true })
        }}
        onClose={() => {
          const change = conflict?.change
          clear()
          if (change) ref.current.onSettled?.('cancelled', change)
        }}
      />
      <GoneDialog
        open={gone !== null}
        index={gone?.index ?? 0}
        total={gone ? changeRowCount(gone.change) : 1}
        onClose={() => {
          const change = gone?.change
          setGone(null)
          if (change) ref.current.onSettled?.('gone', change)
        }}
      />
      <ErrorDialog
        failure={failure?.failure ?? null}
        onClose={() => {
          const change = failure?.change
          setFailure(null)
          if (change) ref.current.onSettled?.('failed', change)
        }}
      />
    </>
  )

  return { submit, busy, dialogs, operation, pending: plan !== null || conflict !== null }
}
