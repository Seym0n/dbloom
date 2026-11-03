import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { t, type MessageKey } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Muted, Panel, Pill, Row, Section } from '~/components/auth/account/account-ui'
import { ErrorNote } from '~/components/auth/auth-frame'
import { authApi } from '~/lib/auth/api'
import { describeError } from '~/lib/auth/messages'
import { useAction } from '~/lib/auth/use-action'
import type { UserNotice } from '~/server/auth/types'
import { formatWhen } from './user-dialogs'

const NOTICES_KEY = ['account', 'notices'] as const
/** Detector notices get a warning pill; the others are plain information. */
const ALERT_KINDS = new Set(['failed_burst', 'new_location'])

/** Security notices of the signed-in administrator: unread first, dismiss one by one, read ones behind "show earlier" (SPEC/30 FR-AUS-003). */
export function NoticesPanel() {
  const client = useQueryClient()
  const notices = useQuery({ queryKey: NOTICES_KEY, queryFn: () => authApi().listNotices(), retry: false })
  const [showRead, setShowRead] = useState(false)
  const act = useAction()
  const sorted = [...(notices.data ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  const unread = sorted.filter((n) => n.readAt === null)
  const read = sorted.filter((n) => n.readAt !== null)

  async function dismiss(n: UserNotice) {
    const r = await act.run(() => authApi().dismissNotice(n.id))
    if (r.ok) await client.invalidateQueries({ queryKey: NOTICES_KEY })
  }

  const item = (n: UserNotice, canDismiss: boolean) => (
    <li key={n.id}>
      <Row>
        <div className="min-w-0 flex-1 basis-56">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span>{t(`account.notice.${n.kind}` as MessageKey)}</span>
            {ALERT_KINDS.has(n.kind) && <Pill tone="warning">{t('auth.users.notices.alert')}</Pill>}
          </p>
          <p className="text-xs text-muted">
            {formatWhen(n.createdAt)}
            {n.detail ? ` · ${n.detail}` : ''}
          </p>
        </div>
        {canDismiss && (
          <Button disabled={act.busy} aria-label={t('auth.users.notices.dismissAria', { time: formatWhen(n.createdAt) })} onClick={() => void dismiss(n)}>
            {t('auth.users.notices.dismiss')}
          </Button>
        )}
      </Row>
    </li>
  )

  return (
    <Section title={t('auth.users.notices.title')} lead={t('auth.users.notices.lead')}>
      <ErrorNote message={act.error?.message ?? (notices.error ? describeError(notices.error).message : null)} />
      {notices.isPending ? (
        <Muted>{t('auth.users.loading')}</Muted>
      ) : unread.length === 0 ? (
        <Muted>{t('auth.users.notices.empty')}</Muted>
      ) : (
        <Panel>
          <ul aria-label={t('auth.users.notices.listLabel')}>{unread.map((n) => item(n, true))}</ul>
        </Panel>
      )}
      {read.length > 0 && (
        <>
          <div>
            <Button aria-expanded={showRead} onClick={() => setShowRead((v) => !v)}>
              {showRead ? t('auth.users.notices.hideEarlier') : t('auth.users.notices.showEarlier', { count: read.length })}
            </Button>
          </div>
          {showRead && (
            <Panel>
              <ul aria-label={t('auth.users.notices.earlierLabel')}>{read.map((n) => item(n, false))}</ul>
            </Panel>
          )}
        </>
      )}
    </Section>
  )
}
