import { useInfiniteQuery } from '@tanstack/react-query'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { authApi } from '~/lib/auth/api'
import { ErrorNote } from '../auth-frame'
import { Muted, Panel, Pill, Row, Section } from './account-ui'
import { WhenText } from './factors-section'

/** The user's own audit events of the last 90 days: event, outcome, time, subject, address, nothing else (SPEC/29 FR-AAU-008). */
export function ActivitySection() {
  const list = useInfiniteQuery({
    queryKey: ['account', 'activity'],
    queryFn: ({ pageParam }) => authApi().listOwnAuditEvents(pageParam ? { before: pageParam } : {}),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
    retry: false,
  })
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? []
  return (
    <Section title={t('audit.own.title')} lead={t('audit.own.lead')}>
      {list.isPending ? (
        <Muted>{t('account.loading')}</Muted>
      ) : list.isError ? (
        <Panel className="py-3">
          <ErrorNote message={t('account.loadFailed')} />
          <Button className="mt-2" onClick={() => void list.refetch()}>
            {t('account.retry')}
          </Button>
        </Panel>
      ) : rows.length === 0 ? (
        <Muted>{t('audit.own.empty')}</Muted>
      ) : (
        <>
          <Panel>
            <ul aria-label={t('audit.own.title')}>
              {rows.map((r) => (
                <li key={r.id}>
                  <Row>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span>{r.event}</span>
                        {r.outcome && <Pill tone={r.outcome === 'ok' ? 'neutral' : 'warning'}>{r.outcome}</Pill>}
                      </p>
                      <Muted>
                        <WhenText ts={r.at} />
                        {r.address ? ` · ${r.address}` : ''}
                        {r.subject ? ` · ${r.subject}` : ''}
                      </Muted>
                    </div>
                  </Row>
                </li>
              ))}
            </ul>
          </Panel>
          {list.hasNextPage && (
            <div>
              <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('audit.own.more')}
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
