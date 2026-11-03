import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { t, type MessageKey } from '~/i18n'
import { Button } from '~/components/ui/button'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import type { SessionInfo } from '~/server/auth/types'
import { ErrorNote } from '../auth-frame'
import { Muted, Panel, Pill, Row, Section } from './account-ui'
import { WhenText } from './factors-section'

const SESSIONS_KEY = ['account', 'sessions'] as const
const NOTICES_KEY = ['account', 'notices'] as const

/** Active sessions of the user with "sign out this session" (FR-AUT-017). */
export function SessionsSection({ announce }: { announce: (message: string) => void }) {
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => authApi().listSessions(), retry: false })
  const [revoking, setRevoking] = useState<string | null>(null)
  const action = useAction()

  async function revoke(session: SessionInfo) {
    setRevoking(session.ref)
    const r = await action.run(() => authApi().revokeSession(session.ref))
    setRevoking(null)
    if (!r.ok) return
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY })
    announce(t('account.sessions.revoked'))
  }

  return (
    <Section title={t('account.sessions.title')} lead={t('account.sessions.lead')}>
      {sessions.isPending ? (
        <Muted>{t('account.loading')}</Muted>
      ) : sessions.isError ? (
        <Panel className="py-3">
          <ErrorNote message={t('account.loadFailed')} />
          <Button className="mt-2" onClick={() => void sessions.refetch()}>
            {t('account.retry')}
          </Button>
        </Panel>
      ) : (
        <Panel>
          <ul aria-label={t('account.sessions.title')}>
            {sessions.data.map((session) => (
              <li key={session.ref}>
                <Row>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>{session.clientHint || t('account.sessions.unknownClient')}</span>
                      {session.current && <Pill>{t('account.sessions.current')}</Pill>}
                    </p>
                    <Muted>
                      {session.address} · {t('account.sessions.lastActive')} <WhenText ts={session.lastSeenAt} />
                    </Muted>
                  </div>
                  {!session.current && (
                    <Button
                      disabled={action.busy && revoking === session.ref}
                      aria-label={t('account.sessions.revokeAria', { client: session.clientHint, address: session.address })}
                      onClick={() => void revoke(session)}
                    >
                      {t('account.sessions.revoke')}
                    </Button>
                  )}
                </Row>
              </li>
            ))}
          </ul>
          <ErrorNote message={action.error?.message} />
        </Panel>
      )}
    </Section>
  )
}

/** Notices of the user (factor added or removed, password changed, a session ended by the limit). Hidden while there are none. */
export function NoticesSection() {
  const notices = useQuery({ queryKey: NOTICES_KEY, queryFn: () => authApi().listNotices(), retry: false })
  if (!notices.data || notices.data.length === 0) return null
  const sorted = [...notices.data].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <Section title={t('account.notices.title')} lead={t('account.notices.lead')}>
      <Panel>
        <ul aria-label={t('account.notices.title')}>
          {sorted.map((notice) => (
            <li key={notice.id}>
              <Row>
                <p className="min-w-0">
                  {t(`account.notice.${notice.kind}` as MessageKey)}
                  {notice.detail ? ` ${notice.detail}` : ''}
                </p>
                <Muted>
                  <WhenText ts={notice.createdAt} />
                </Muted>
              </Row>
            </li>
          ))}
        </ul>
      </Panel>
    </Section>
  )
}
