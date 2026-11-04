import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { t } from '~/i18n'
import { BrandName } from '~/components/brand'
import { Button } from '~/components/ui/button'
import { Muted, Panel, Pill, Row, Section } from '~/components/auth/account/account-ui'
import { ErrorNote } from '~/components/auth/auth-frame'
import { PendingLink } from '~/components/auth/settings/pending-link'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import type { ExposureAnswer } from '~/server/exposure-service'

export const EXPOSURE_KEY = ['admin', 'exposure'] as const
const formatWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

/** Administrator page: the exposure report, its warnings with acknowledgement, and the status block (SPEC/31 FR-AEX-003, 005). */
export function ExposurePage() {
  const client = useQueryClient()
  const exposure = useQuery({ queryKey: EXPOSURE_KEY, queryFn: () => authApi().getExposure(), retry: false })
  const act = useAction()

  async function acknowledge(id: string) {
    const r = await act.run(() => authApi().acknowledgeExposure(id))
    if (r.ok) await client.invalidateQueries({ queryKey: EXPOSURE_KEY })
  }

  return (
    <main className="min-h-full bg-ground px-4 py-8">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8">
        <header className="flex flex-col gap-4">
          <BrandName />
          <Link to="/" className="press -ml-2 inline-flex h-8 w-fit items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-medium text-muted hover:bg-active hover:text-ink">
            <ArrowLeft size={14} aria-hidden />
            {t('exposure.back')}
          </Link>
          <div>
            <h1 className="mb-1 text-[22px] font-semibold leading-7">{t('exposure.title')}</h1>
            <p className="max-w-[60ch] text-sm text-muted">{t('exposure.lead')}</p>
          </div>
        </header>
        <PendingLink />
        {exposure.isPending ? (
          <Muted>{t('audit.loading')}</Muted>
        ) : exposure.isError ? (
          <Panel className="py-3">
            <ErrorNote message={t('exposure.loadFailed')} />
            <Button className="mt-2" onClick={() => void exposure.refetch()}>
              {t('exposure.retry')}
            </Button>
          </Panel>
        ) : (
          <Content data={exposure.data} busy={act.busy} error={act.error?.message} onAcknowledge={(id) => void acknowledge(id)} />
        )}
      </div>
    </main>
  )
}

function Content({ data, busy, error, onAcknowledge }: { data: ExposureAnswer; busy: boolean; error: string | undefined; onAcknowledge: (id: string) => void }) {
  const s = data.status
  const status: [string, string][] = [
    [t('exposure.status.ready'), s.ready ? t('exposure.status.yes') : t('exposure.status.no', { state: s.readyState })],
    [t('exposure.status.loginMode'), s.loginMode],
    [t('exposure.status.store'), t(`exposure.status.store.${s.store}`)],
    [t('exposure.status.schema'), s.schemaVersion === null ? '-' : String(s.schemaVersion)],
    [t('exposure.status.version'), s.version],
    [t('exposure.status.sink'), t('exposure.status.sinkValue', { sink: s.auditSink.sink, state: s.auditSink.state })],
  ]
  return (
    <>
      <Section title={t('exposure.warnings')} lead={t('exposure.warningsLead')}>
        <ErrorNote message={error} />
        {data.items.length === 0 ? (
          <Muted>{t('exposure.none')}</Muted>
        ) : (
          <Panel>
            <ul aria-label={t('exposure.warnings')}>
              {data.items.map((i) => (
                <li key={i.id}>
                  <Row>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span>{i.text}</span>
                        <Pill tone={i.acknowledged ? 'neutral' : 'warning'}>{t(`exposure.source.${i.source}`)}</Pill>
                      </p>
                      {i.acknowledged && <p className="text-xs text-muted">{t('exposure.acknowledged', { name: i.acknowledged.by, time: formatWhen(i.acknowledged.at) })}</p>}
                    </div>
                    {!i.acknowledged && (
                      <Button disabled={busy} aria-label={t('exposure.acknowledgeAria', { text: i.text })} onClick={() => onAcknowledge(i.id)}>
                        {t('exposure.acknowledge')}
                      </Button>
                    )}
                  </Row>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </Section>
      <Section title={t('exposure.report')} lead={t('exposure.asOf', { time: formatWhen(data.asOf) })}>
        <Panel className="py-3">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            {data.lines.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </Section>
      <Section title={t('exposure.status')}>
        <Panel className="py-3">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            {status.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </Section>
    </>
  )
}
