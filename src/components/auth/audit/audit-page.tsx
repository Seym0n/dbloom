import { useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Download } from 'lucide-react'
import { t } from '~/i18n'
import { BrandName } from '~/components/brand'
import { ExposureBanner } from '~/components/auth/exposure/exposure-banner'
import { PendingLink } from '~/components/auth/settings/pending-link'
import { SiteNotices } from '~/components/auth/settings/site-notices'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { Muted, Panel, Pill, Row, Section } from '~/components/auth/account/account-ui'
import { StepUpProvider, useStepUp } from '~/components/auth/account/step-up'
import { ErrorNote, FormField } from '~/components/auth/auth-frame'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import type { AuditFilter, AuditRow } from '~/server/audit/query'
import type { ExportFormat } from '~/server/audit/formats'

const DAY_MS = 86_400_000
const formatWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

type Draft = { from: string; to: string; event: string; actor: string; outcome: string; text: string }
const EMPTY: Draft = { from: '', to: '', event: '', actor: '', outcome: '', text: '' }

/** `YYYY-MM-DD` of a date input as local midnight; the end date includes the whole day. */
function filterOf(d: Draft): AuditFilter {
  const f: AuditFilter = {}
  if (d.from) f.from = new Date(`${d.from}T00:00:00`).getTime()
  if (d.to) f.to = new Date(`${d.to}T00:00:00`).getTime() + DAY_MS
  if (d.event) f.eventPrefix = d.event
  if (d.actor.trim()) f.actor = d.actor.trim()
  if (d.outcome) f.outcome = d.outcome
  if (d.text.trim()) f.text = d.text.trim()
  return f
}

function actorLabel(r: AuditRow): string {
  if (r.actorKind === 'cli') return t('audit.actor.cli')
  if (r.actorName || r.actorId) return r.actorName ?? r.actorId ?? ''
  return r.actorKind === 'anonymous' ? t('audit.actor.anonymous') : t('audit.actor.system')
}

/** Administrator page: the audit log, newest first, read only (SPEC/29 FR-AAU-007, 008). */
export function AuditPage({ mode, initialActor }: { mode: 'account' | 'direct'; initialActor?: string }) {
  return (
    <StepUpProvider>
      <main className="min-h-full bg-ground px-4 py-8">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6">
          <header className="flex flex-col gap-4">
            <BrandName />
            <Link to="/" className="press -ml-2 inline-flex h-8 w-fit items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-medium text-muted hover:bg-active hover:text-ink">
              <ArrowLeft size={14} aria-hidden />
              {t('audit.back')}
            </Link>
            <div>
              <h1 className="mb-1 text-[22px] font-semibold leading-7">{t('audit.title')}</h1>
              <p className="max-w-[60ch] text-sm text-muted">{t('audit.lead')}</p>
            </div>
          </header>
          {mode === 'account' && <ExposureBanner />}
          {mode === 'account' && <PendingLink />}
          {mode === 'account' && <SiteNotices />}
          {mode === 'direct' ? <DirectNotice /> : <AuditLog {...(initialActor ? { initialActor } : {})} />}
        </div>
      </main>
    </StepUpProvider>
  )
}

function DirectNotice() {
  return (
    <Panel className="py-4">
      <h2 className="font-semibold">{t('audit.notice.title')}</h2>
      <Muted className="mt-1">{t('audit.notice.lead')}</Muted>
    </Panel>
  )
}

function AuditLog({ initialActor }: { initialActor?: string }) {
  const [draft, setDraft] = useState<Draft>(initialActor ? { ...EMPTY, actor: initialActor } : EMPTY)
  const [applied, setApplied] = useState<AuditFilter>(initialActor ? { actor: initialActor } : {})
  const [open, setOpen] = useState<AuditRow | null>(null)
  const status = useQuery({ queryKey: ['audit', 'status'], queryFn: () => authApi().getAuditStatus(), retry: false })
  const list = useInfiniteQuery({
    queryKey: ['audit', 'list', applied],
    queryFn: ({ pageParam }) => authApi().listAuditEvents({ ...applied, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
    retry: false,
  })
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data])
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <>
      <StatusBanner status={status.data} />
      <Section title={t('audit.filters')}>
        <form
          className="grid grid-cols-1 gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            setOpen(null)
            setApplied(filterOf(draft))
          }}
        >
          <FormField label={t('audit.from')}>{(p) => <Input type="date" value={draft.from} onChange={(e) => set('from')(e.target.value)} {...p} />}</FormField>
          <FormField label={t('audit.to')}>{(p) => <Input type="date" value={draft.to} onChange={(e) => set('to')(e.target.value)} {...p} />}</FormField>
          <FormField label={t('audit.event')}>
            {(p) => (
              <Select value={draft.event} onChange={(e) => set('event')(e.target.value)} {...p}>
                <option value="">{t('audit.eventAny')}</option>
                {(status.data?.events ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={t('audit.actor')} hint={t('audit.actorHint')}>
            {(p) => <Input value={draft.actor} onChange={(e) => set('actor')(e.target.value)} {...p} />}
          </FormField>
          <FormField label={t('audit.outcome')}>
            {(p) => (
              <Select value={draft.outcome} onChange={(e) => set('outcome')(e.target.value)} {...p}>
                <option value="">{t('audit.outcomeAny')}</option>
                {['ok', 'failed', 'refused', 'cancelled', 'timeout'].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={t('audit.text')}>{(p) => <Input value={draft.text} onChange={(e) => set('text')(e.target.value)} {...p} />}</FormField>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button type="submit" variant="primary">
              {t('audit.apply')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDraft(EMPTY)
                setApplied({})
                setOpen(null)
              }}
            >
              {t('audit.reset')}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t('audit.results')} action={<ExportButtons filter={applied} />}>
        {list.isPending ? (
          <Muted>{t('audit.loading')}</Muted>
        ) : list.isError ? (
          <Panel className="py-3">
            <ErrorNote message={t('audit.loadFailed')} />
            <Button className="mt-2" onClick={() => void list.refetch()}>
              {t('audit.retry')}
            </Button>
          </Panel>
        ) : rows.length === 0 ? (
          <Muted>{t('audit.empty')}</Muted>
        ) : (
          <>
            {open && <Detail row={open} onClose={() => setOpen(null)} />}
            <Panel>
              <ul aria-label={t('audit.results')}>
                {rows.map((r) => (
                  <li key={r.id}>
                    <Row>
                      <button
                        type="button"
                        aria-label={t('audit.row.open', { id: r.id })}
                        aria-expanded={open?.id === r.id}
                        onClick={() => setOpen(open?.id === r.id ? null : r)}
                        className="press -mx-2 flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-[var(--radius-control)] px-2 py-1 text-left hover:bg-active"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{r.event}</span>
                          {r.outcome && <Pill tone={r.outcome === 'ok' ? 'neutral' : 'warning'}>{r.outcome}</Pill>}
                        </span>
                        <Muted>
                          {formatWhen(r.at)} · {t('audit.row.by', { actor: actorLabel(r) })}
                          {r.subject ? ` · ${r.subject}` : ''}
                        </Muted>
                      </button>
                    </Row>
                  </li>
                ))}
              </ul>
            </Panel>
            {list.hasNextPage && (
              <div>
                <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t('audit.more')}
                </Button>
              </div>
            )}
          </>
        )}
      </Section>
    </>
  )
}

function StatusBanner({ status }: { status: Awaited<ReturnType<ReturnType<typeof authApi>['getAuditStatus']>> | undefined }) {
  if (!status) return null
  const notes: string[] = []
  if (status.sink.sink === 'file' && status.sink.state === 'degraded')
    notes.push(t('audit.sink.degraded', { buffered: status.sink.buffered, drops: status.sink.drops, error: status.sink.lastError ?? '?' }))
  if (status.tableFailures > 0) notes.push(t('audit.table.down', { count: status.tableFailures }))
  if (status.sink.sink === 'file' && status.sink.state === 'ok') return <p className="text-sm text-muted">{t('audit.sink.ok')}</p>
  if (notes.length === 0) return null
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-border bg-[var(--pill-warning-bg)] px-4 py-3 text-sm text-[var(--pill-warning-ink)]">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  )
}

function Detail({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  const items: [string, string][] = [
    [t('audit.detail.time'), formatWhen(row.at)],
    [t('audit.detail.event'), row.event],
    [t('audit.detail.outcome'), row.outcome ?? t('audit.detail.none')],
    [t('audit.detail.actor'), actorLabel(row)],
    [t('audit.detail.kind'), row.actorKind],
    [t('audit.detail.subject'), row.subject ?? t('audit.detail.none')],
    [t('audit.detail.address'), row.address ?? t('audit.detail.none')],
  ]
  return (
    <section aria-label={t('audit.detail.title', { id: row.id })} className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-semibold">{t('audit.detail.title', { id: row.id })}</h3>
        <Button onClick={onClose}>{t('audit.detail.close')}</Button>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
        <dt className="text-muted">{t('audit.detail.fields')}</dt>
        <dd>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-raised p-2 text-xs">{JSON.stringify(row.fields, null, 2)}</pre>
        </dd>
      </dl>
    </section>
  )
}

function ExportButtons({ filter }: { filter: AuditFilter }) {
  const { guard } = useStepUp()
  const act = useAction()
  const [note, setNote] = useState<string | null>(null)

  async function run(format: ExportFormat) {
    setNote(null)
    const r = await act.run(() => guard(() => authApi().startAuditExport({ ...filter, format })))
    if (!r.ok) return
    const { token, rows, truncated } = r.value
    setNote(truncated ? t('audit.export.truncated', { rows }) : t('audit.export.started', { rows }))
    if (!token.startsWith('mock-')) window.location.assign(`/api/audit/export/${encodeURIComponent(token)}`)
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2" role="group" aria-label={t('audit.export')}>
        <Button disabled={act.busy} onClick={() => void run('csv')}>
          <Download size={14} aria-hidden />
          {t('audit.export.csv')}
        </Button>
        <Button disabled={act.busy} onClick={() => void run('ndjson')}>
          <Download size={14} aria-hidden />
          {t('audit.export.ndjson')}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-positive empty:sr-only">
        {note}
      </p>
      <ErrorNote message={act.error?.message} />
    </div>
  )
}
