import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { isSessionEnded, setSessionEnded } from '~/lib/session-state'
import { executeStructure, previewStructure } from '~/server/structure.functions'
import type { ExecuteResult, PreviewInput, PreviewResult } from '~/server/structure/types'
import { cn } from '~/lib/utils'
import { t, type MessageKey } from '~/i18n'
import { ClassBadge, ResultBadge } from './class-badge'
import { AcknowledgeConfirm, TypedNameConfirm } from './confirm-dialog'
import { refreshAfterStructure } from './invalidate'
import { describeRefusal } from './refusal'

export type PreviewRequest = { input: PreviewInput; nonce: number }

const EXECUTE_LABEL: Record<PreviewInput['action'], MessageKey> = {
  createDatabase: 'structure.exec.createDatabase',
  dropDatabase: 'structure.exec.dropDatabase',
  createTable: 'structure.exec.createTable',
  alterTable: 'structure.exec.alterTable',
  renameTable: 'structure.exec.renameTable',
  truncateTable: 'structure.exec.truncateTable',
  dropTable: 'structure.exec.dropTable',
}

const messageOf = (error: unknown) => describeRefusal(error).message
const isReadOnlyRefusal = (error: unknown) => describeRefusal(error).code === 'read-only'
const isExpiredRefusal = (error: unknown) => describeRefusal(error).offerNewPreview

function CopyButton({ text, label }: { text: string; label: string }) {
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

function SqlBlock({ sql }: { sql: string }) {
  return (
    <pre
      tabIndex={0}
      className="max-h-48 overflow-auto rounded-[var(--radius-control)] bg-raised px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-ink select-text"
    >
      {sql}
    </pre>
  )
}

function Alert({
  children,
  tone = 'warning',
}: {
  children: React.ReactNode
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

type Live = { busy: boolean; result: ExecuteResult | null }

function PreviewBody({
  request,
  readOnly,
  live,
  titleId,
  onClose,
  onApplied,
  onNewPreview,
  successAction,
}: {
  request: PreviewRequest
  readOnly?: boolean
  live: { current: Live }
  titleId: string
  onClose: () => void
  onApplied?: (input: PreviewInput, result: ExecuteResult) => void
  onNewPreview: () => void
  successAction?: { label: string; onClick: () => void }
}) {
  const queryClient = useQueryClient()
  const started = useRef(false)
  const [typed, setTyped] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [readOnlyHit, setReadOnlyHit] = useState(false)
  const [expired, setExpired] = useState(false)

  const preview = useMutation({
    mutationFn: (input: PreviewInput): Promise<PreviewResult> => previewStructure({ data: input }),
    onError: (error) => {
      if (isSessionEnded(error)) setSessionEnded(true)
    },
  })
  const execute = useMutation({
    mutationFn: (variables: { planId: string; confirmToken?: string }): Promise<ExecuteResult> =>
      executeStructure({ data: variables }),
    onError: (error) => {
      if (isSessionEnded(error)) setSessionEnded(true)
      else if (isReadOnlyRefusal(error)) setReadOnlyHit(true)
      else if (isExpiredRefusal(error)) setExpired(true)
    },
    onSuccess: (result) => {
      if (result.results.some((r) => r.status === 'executed')) {
        void refreshAfterStructure(queryClient, request.input)
        onApplied?.(request.input, result)
      }
    },
  })

  useEffect(() => {
    if (started.current) return
    started.current = true
    preview.mutate(request.input)
  }, [preview, request.input])

  const plan = preview.data
  const result = execute.data
  const executing = execute.isPending
  const isReadOnly = Boolean(readOnly) || readOnlyHit
  const confirmOk = !plan?.confirmRequired
    ? true
    : plan.confirmName
      ? typed === plan.confirmName
      : acknowledged
  const expiresMs = plan ? (plan.expiresAt < 1e12 ? plan.expiresAt * 1000 : plan.expiresAt) : 0
  const canExecute = Boolean(plan) && !isReadOnly && confirmOk && !executing && !result && !expired
  const hard = Boolean(plan?.confirmRequired)
  live.current = { busy: executing, result: result ?? null }

  function run() {
    if (!plan) return
    if (Date.now() > expiresMs) {
      setExpired(true)
      return
    }
    execute.mutate({
      planId: plan.planId,
      confirmToken: plan.confirmRequired ? plan.confirmToken : undefined,
    })
  }

  const failed = result !== undefined && !result.ok
  const statementCount = plan?.statements.length ?? 0

  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col">
      <header className="shrink-0 px-6 pt-5 pb-3">
        <h2 id={titleId} className="text-base font-semibold">
          {result?.ok
            ? t('structure.done.title')
            : failed
              ? t('structure.failed.title')
              : t('structure.preview.title')}
        </h2>
        <p className="text-sm text-muted">{t('structure.preview.commits')}</p>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-4"
        aria-busy={preview.isPending || executing}
      >
        {preview.isPending && (
          <div className="flex flex-col gap-3" aria-hidden>
            <div className="h-5 w-40 rounded bg-active" />
            <div className="h-16 rounded bg-active" />
          </div>
        )}

        {preview.isError && (
          <div className="flex flex-col gap-3">
            <Alert tone="negative">{messageOf(preview.error)}</Alert>
          </div>
        )}

        {plan && !result && (
          <div className="flex flex-col gap-4">
            {plan.warnings.map((w) => (
              <Alert key={w.code}>{w.message}</Alert>
            ))}
            {statementCount > 1 && <Alert>{t('structure.preview.sequence')}</Alert>}
            <ol className="flex flex-col gap-3">
              {plan.statements.map((s, i) => (
                <li key={i} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs text-muted">
                      {t('structure.preview.step', { n: i + 1, total: statementCount })}
                    </span>
                    <ClassBadge value={s.class} />
                    <span className="min-w-0 flex-1 text-sm break-words">{s.effect}</span>
                    <CopyButton
                      text={s.sql}
                      label={t('structure.preview.copyStep', { n: i + 1 })}
                    />
                  </div>
                  <SqlBlock sql={s.sql} />
                </li>
              ))}
            </ol>
            {statementCount > 1 && (
              <div className="flex justify-end">
                <CopyButton
                  text={plan.statements.map((s) => `${s.sql};`).join('\n')}
                  label={t('structure.preview.copyAll')}
                />
              </div>
            )}
            {hard && (
              <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-[var(--pill-negative-bg)] p-3 text-[var(--pill-negative-ink)]">
                <p className="text-sm font-medium">{t('structure.confirm.dataLoss')}</p>
                {plan.confirmName ? (
                  <TypedNameConfirm
                    name={plan.confirmName}
                    value={typed}
                    onChange={setTyped}
                    disabled={executing}
                  />
                ) : (
                  <AcknowledgeConfirm
                    checked={acknowledged}
                    onChange={setAcknowledged}
                    disabled={executing}
                  />
                )}
              </div>
            )}
            {expired && !execute.isError && (
              <Alert tone="negative">{t('structure.preview.expired')}</Alert>
            )}
            {isReadOnly && <Alert>{t('structure.readOnlyReason')}</Alert>}
          </div>
        )}

        {execute.isError && !readOnlyHit && (
          <Alert tone="negative">{messageOf(execute.error)}</Alert>
        )}

        {result && (
          <div className="flex flex-col gap-4">
            <p className="text-sm" aria-live="polite">
              {result.ok
                ? t('structure.done.body', { count: result.results.length })
                : t('structure.failed.body')}
            </p>
            <ol className="flex flex-col gap-3">
              {result.results.map((r, i) => (
                <li key={i} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">
                      {t('structure.preview.step', { n: i + 1, total: result.results.length })}
                    </span>
                    <ResultBadge status={r.status} />
                    {r.status !== 'not-run' && (
                      <span className="text-xs text-muted">
                        {t('structure.result.duration', { ms: r.durationMs })}
                      </span>
                    )}
                    <CopyButton
                      text={r.sql}
                      label={t('structure.preview.copyStep', { n: i + 1 })}
                    />
                  </div>
                  <SqlBlock sql={r.sql} />
                  {r.status === 'failed' && (
                    <div
                      role="alert"
                      className="flex flex-col gap-1 rounded-[var(--radius-control)] bg-[var(--pill-negative-bg)] px-3 py-2 text-sm text-[var(--pill-negative-ink)]"
                    >
                      <p className="break-words">
                        {r.error.errno !== null && (
                          <span className="font-medium">
                            {t('structure.result.errno', { errno: r.error.errno })}{' '}
                          </span>
                        )}
                        {r.error.message}
                      </p>
                      {r.error.hint && <p className="break-words">{r.error.hint}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-raised px-6 py-3">
        {(failed || expired || preview.isError) && (
          <Button onClick={onNewPreview}>{t('structure.preview.again')}</Button>
        )}
        {result?.ok && successAction && (
          <Button
            onClick={() => {
              successAction.onClick()
              onClose()
            }}
          >
            {successAction.label}
          </Button>
        )}
        <Button disabled={executing} onClick={() => onClose()}>
          {result ? t('structure.close') : t('structure.cancel')}
        </Button>
        {plan && !result && (
          <Button
            variant={hard ? 'outline' : 'primary'}
            className={cn(
              hard && 'border-negative text-negative hover:bg-[var(--pill-negative-bg)]',
            )}
            disabled={!canExecute}
            aria-describedby={!canExecute && isReadOnly ? `${titleId}-why` : undefined}
            onClick={run}
          >
            {executing ? t('structure.executing') : t(EXECUTE_LABEL[request.input.action])}
          </Button>
        )}
        {isReadOnly && plan && !result && (
          <span id={`${titleId}-why`} className="basis-full text-right text-xs text-muted">
            {t('structure.readOnlyReason')}
          </span>
        )}
      </footer>
    </div>
  )
}

/**
 * Preview, confirmation and result of one structure change. Mount it once and pass `request`;
 * a new `nonce` starts a new preview. It runs previewStructure, shows exactly the statements the server
 * will run, and calls executeStructure with the plan id (and the token for hard plans).
 */
export function PreviewDialog({
  request,
  readOnly,
  onClose,
  onApplied,
  onNewPreview,
  successAction,
}: {
  request: PreviewRequest | null
  readOnly?: boolean
  /** Called when the dialog closes; `result` is the execute result if the plan ran. */
  onClose: (result: ExecuteResult | null) => void
  /** Called once as soon as at least one statement ran (tabs, caches). */
  onApplied?: (input: PreviewInput, result: ExecuteResult) => void
  /** Replaces the default "preview the same input again" (the designer rebuilds from fresh state). */
  onNewPreview?: () => void
  successAction?: { label: string; onClick: () => void }
}) {
  const [again, setAgain] = useState(0)
  const titleId = useId()
  const live = useRef<Live>({ busy: false, result: null })
  useEffect(() => {
    if (!request) setAgain(0)
  }, [request])
  // Escape and backdrop clicks are ignored while a plan is running; the run cannot be abandoned half way.
  const close = () => {
    if (live.current.busy) return
    const result = live.current.result
    live.current = { busy: false, result: null }
    onClose(result)
  }

  return (
    <Dialog
      open={request !== null}
      onClose={close}
      labelledBy={titleId}
      className="w-[min(760px,calc(100vw-32px))]"
    >
      {request && (
        <PreviewBody
          key={`${request.nonce}-${again}`}
          request={request}
          readOnly={readOnly}
          live={live}
          titleId={titleId}
          onClose={close}
          onApplied={onApplied}
          onNewPreview={onNewPreview ?? (() => setAgain((n) => n + 1))}
          successAction={successAction}
        />
      )}
    </Dialog>
  )
}
