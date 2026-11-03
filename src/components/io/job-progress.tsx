import type { ReactNode } from 'react'
import { Ban, Check, CircleAlert, PauseCircle, RotateCw } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { MAX_REJECT_DETAILS } from '~/server/io/types'
import type { IoJob, JobProgress, JobState } from '~/server/io/types'
import {
  describeIoError,
  formatBytes,
  formatDuration,
  fraction,
  percentText,
  STATE_KEYS,
  stateTone,
} from './job-model'

/** Determinate when the total is known; otherwise a quiet pulse that stops under reduced motion. */
export function ProgressBar({
  value,
  label,
  valueText,
  thin,
}: {
  value: number | undefined
  label: string
  valueText?: string
  thin?: boolean
}) {
  const pct = value === undefined ? undefined : Math.round(value * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(pct !== undefined ? { 'aria-valuenow': pct } : {})}
      aria-valuetext={valueText ?? (pct !== undefined ? `${pct}%` : t('io.progress.working'))}
      className={cn('w-full overflow-hidden rounded-full bg-active', thin ? 'h-1' : 'h-2')}
    >
      <div
        className={cn(
          'h-full rounded-full bg-accent transition-[width] duration-200 ease-out motion-reduce:transition-none',
          pct === undefined && 'w-full animate-pulse opacity-40 motion-reduce:animate-none',
        )}
        style={pct !== undefined ? { width: `${pct}%` } : undefined}
      />
    </div>
  )
}

const TONE_CLASS = {
  neutral: 'bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]',
  warning: 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]',
  negative: 'bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]',
  positive: 'bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]',
} as const

/** State of a job as a pill with a glyph and a word, so colour is never the only signal. */
export function StateBadge({ state }: { state: JobState }) {
  const tone = stateTone(state)
  const Icon =
    state === 'done'
      ? Check
      : state === 'failed' || state === 'cancelled' || state === 'interrupted'
        ? Ban
        : state === 'paused'
          ? PauseCircle
          : CircleAlert
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[tone],
      )}
    >
      {state === 'running' || state === 'queued' ? (
        <RotateCw size={12} aria-hidden className="motion-safe:animate-spin" />
      ) : (
        <Icon size={12} aria-hidden />
      )}
      {t(STATE_KEYS[state])}
    </span>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate text-sm font-medium text-ink">{value}</dd>
    </div>
  )
}

export function progressStats(p: JobProgress): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  out.push({
    label: t('io.progress.bytes'),
    value: p.totalBytes
      ? t('io.progress.bytesOf', { done: formatBytes(p.bytes), total: formatBytes(p.totalBytes) })
      : formatBytes(p.bytes),
  })
  if (p.rows !== undefined)
    out.push({ label: t('io.progress.rows'), value: p.rows.toLocaleString('en') })
  if (p.statements !== undefined)
    out.push({ label: t('io.progress.statements'), value: p.statements.toLocaleString('en') })
  return out
}

/** Overall progress and, where the job knows its objects, the current one (UI-ISS-001). */
export function JobProgressView({
  job,
  onCancel,
  onResume,
  cancelling,
  resuming,
}: {
  job: IoJob
  onCancel?: () => void
  onResume?: () => void
  cancelling?: boolean
  resuming?: boolean
}) {
  const f = fraction(job.progress)
  const o = job.progress.object
  const live = job.state === 'queued' || job.state === 'running'
  return (
    <section aria-label={t('io.progress.title')} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{t('io.progress.title')}</h3>
        <StateBadge state={job.state} />
        <span className="ml-auto text-xs text-muted" aria-hidden>
          {percentText(job.progress)}
        </span>
      </div>
      <ProgressBar value={f} label={t('io.progress.overall')} />
      {o && o.total > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="truncate text-sm text-muted">
            {t('io.progress.object', { index: o.index, total: o.total })}{' '}
            <span className="font-medium text-ink">{o.name}</span>
          </p>
          <ProgressBar
            value={Math.max(0, Math.min(1, (o.index - 1) / o.total))}
            label={t('io.progress.objects')}
            valueText={t('io.progress.object', { index: o.index, total: o.total })}
            thin
          />
        </div>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {progressStats(job.progress).map((s) => (
          <Stat key={s.label} {...s} />
        ))}
      </dl>
      {job.state === 'paused' && (
        <div className="flex flex-col gap-2 rounded-lg bg-raised p-3">
          <p className="text-sm">
            {job.result?.resume
              ? t('io.paused.body', {
                  statements: job.result.resume.statementNumber.toLocaleString('en'),
                  bytes: formatBytes(job.result.resume.decodedOffset),
                })
              : t('io.paused.bodyShort')}
          </p>
          {onResume && (
            <Button variant="primary" className="self-start" disabled={resuming} onClick={onResume}>
              {t('io.paused.resume')}
            </Button>
          )}
        </div>
      )}
      {live && onCancel && (
        <Button className="self-start" disabled={cancelling} onClick={onCancel}>
          {cancelling ? t('io.progress.cancelling') : t('io.progress.cancel')}
        </Button>
      )}
    </section>
  )
}

/** Outcome of a finished job. Server and file text is shown as text nodes only (FR-IO-023). */
export function JobResultView({ job, links }: { job: IoJob; links?: ReactNode }) {
  const r = job.result
  const state = job.state
  const title =
    state === 'done'
      ? job.kind === 'export'
        ? t('io.result.exportDone')
        : t('io.result.importDone')
      : state === 'done_with_skips'
        ? t('io.result.doneSkips')
        : state === 'done_with_rejects'
          ? t('io.result.doneRejects')
          : state === 'cancelled'
            ? t('io.result.cancelled')
            : state === 'interrupted'
              ? t('io.result.interrupted')
              : t('io.result.failed')
  return (
    <section role="status" aria-live="polite" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <StateBadge state={state} />
      </div>
      {r && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {r.fileName && <Stat label={t('io.result.file')} value={r.fileName} />}
          {r.statements && (
            <>
              <Stat label={t('io.result.run')} value={r.statements.run.toLocaleString('en')} />
              <Stat
                label={t('io.result.skipped')}
                value={r.statements.skipped.toLocaleString('en')}
              />
              <Stat
                label={t('io.result.failedCount')}
                value={r.statements.failed.toLocaleString('en')}
              />
            </>
          )}
          {r.rows !== undefined && (
            <Stat label={t('io.progress.rows')} value={r.rows.toLocaleString('en')} />
          )}
          <Stat label={t('io.result.duration')} value={formatDuration(r.durationMs)} />
        </dl>
      )}
      {r?.error && <ErrorBlock error={r.error} />}
      {r && r.skipped.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium">
            {t('io.result.skippedObjects', { n: r.skipped.length })}
          </h4>
          <ul className="flex flex-col gap-1 text-sm">
            {r.skipped.map((s, i) => (
              <li key={`${s.object}-${i}`}>
                <span className="font-medium">{s.object}</span>{' '}
                <span className="text-muted">{s.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r && r.rejectedCount > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium">
            {t('io.result.rejected', { n: r.rejectedCount })}
          </h4>
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-sm">
            {r.rejected.slice(0, MAX_REJECT_DETAILS).map((p, i) => (
              <li key={`${p.row}-${i}`}>
                <span className="font-medium">
                  {t('io.result.row', { row: p.row })}
                  {p.column ? `, ${p.column}` : ''}
                </span>{' '}
                <span className="text-muted">{p.message}</span>
              </li>
            ))}
          </ul>
          {r.rejectedCount > MAX_REJECT_DETAILS && (
            <p className="mt-1 text-xs text-muted">
              {t('io.result.moreRejected', { n: r.rejectedCount - MAX_REJECT_DETAILS })}
            </p>
          )}
        </div>
      )}
      {r && r.notes.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium">
            {t('io.result.notes', { n: r.notes.length })}
          </h4>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm text-muted">
            {r.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {links && <div className="flex flex-wrap items-center gap-2">{links}</div>}
    </section>
  )
}

function ErrorBlock({ error }: { error: NonNullable<IoJob['result']>['error'] & object }) {
  const facts: string[] = []
  if (error.statementNumber !== undefined)
    facts.push(t('io.error.statementNo', { n: error.statementNumber }))
  if (error.line !== undefined) facts.push(t('io.error.line', { n: error.line }))
  if (error.byteOffset !== undefined) facts.push(t('io.error.offset', { n: error.byteOffset }))
  if (error.errno !== undefined) facts.push(t('io.error.errno', { n: error.errno }))
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-[var(--pill-negative-bg)] p-3 text-[var(--pill-negative-ink)]">
      <p className="text-sm font-medium">{describeIoError(error)}</p>
      {facts.length > 0 && <p className="text-xs">{facts.join(' · ')}</p>}
      {error.serverMessage && <p className="text-sm">{error.serverMessage}</p>}
      {error.statementText && (
        <pre className="max-h-40 overflow-auto rounded bg-surface p-2 text-xs whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
          {error.statementText}
        </pre>
      )}
    </div>
  )
}
