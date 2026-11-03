import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Ban, History, KeyRound, LogOut, Trash2, Undo2, UserPlus } from 'lucide-react'
import { t } from '~/i18n'
import { BrandName } from '~/components/brand'
import { Button } from '~/components/ui/button'
import { ActionsMenu, type MenuItem } from '~/components/ui/menu'
import { Muted, Panel, Pill, Row, Section } from '~/components/auth/account/account-ui'
import { StepUpProvider, useStepUp } from '~/components/auth/account/step-up'
import { ErrorNote } from '~/components/auth/auth-frame'
import { ModalForm } from '~/components/auth/connections/dialog-shell'
import { authApi } from '~/lib/auth/api'
import { allowedUserActions, sortUsers } from '~/lib/auth/connections-logic'
import { describeError } from '~/lib/auth/messages'
import { useAction } from '~/lib/auth/use-action'
import type { InviteInfo, Role, UserSummary } from '~/server/auth/types'
import { NoticesPanel } from './notices-panel'
import { CreateUserDialog, formatWhen, InviteDialog, LinkShownDialog, RoleSelect } from './user-dialogs'

const USERS_KEY = ['auth', 'users'] as const
const INVITES_KEY = ['auth', 'invites'] as const

type Dialog =
  | { kind: 'create' }
  | { kind: 'delete'; user: UserSummary }
  | { kind: 'recovery'; user: UserSummary; link: string; expiresAt: number }

/** Administrator page: users, invites, recovery links (FR-AUT-004, 005, 015, 016, 028). Wrapped in the step-up dialog of the account pages. */
export function UsersPage({ meId }: { meId: string | undefined }) {
  return (
    <StepUpProvider>
      <main className="min-h-full bg-ground px-4 py-8">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8">
          <header className="flex flex-col gap-4">
            <BrandName />
            <Link to="/" className="press -ml-2 inline-flex h-8 w-fit items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-medium text-muted hover:bg-active hover:text-ink">
              <ArrowLeft size={14} aria-hidden />
              {t('auth.users.back')}
            </Link>
            <div>
              <h1 className="mb-1 text-[22px] font-semibold leading-7">{t('auth.users.title')}</h1>
              <p className="max-w-[60ch] text-sm text-muted">{t('auth.users.lead')}</p>
            </div>
          </header>
          <UsersSection meId={meId} />
          <NoticesPanel />
          <InvitesSection />
        </div>
      </main>
    </StepUpProvider>
  )
}

function UsersSection({ meId }: { meId: string | undefined }) {
  const client = useQueryClient()
  const { guard } = useStepUp()
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => authApi().listUsers(), retry: false })
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const act = useAction()
  const reload = () => client.invalidateQueries({ queryKey: USERS_KEY })

  async function run<T>(fn: () => Promise<T>, done: (value: T) => string | null) {
    setNote(null)
    const r = await act.run(() => guard(fn))
    if (!r.ok) return
    const message = done(r.value)
    if (message) setNote(message)
    await reload()
  }

  function menuFor(u: UserSummary): MenuItem[] {
    const allowed = allowedUserActions(u, meId)
    const items: MenuItem[] = [
      {
        key: 'activity',
        label: t('auth.users.activity'),
        icon: <History size={14} aria-hidden />,
        onSelect: () => void navigate({ to: '/admin/audit', search: { actor: u.id } }),
      },
    ]
    if (allowed.includes('revokeSessions'))
      items.push({
        key: 'sessions',
        label: t('auth.users.revokeSessions'),
        icon: <LogOut size={14} aria-hidden />,
        onSelect: () => void run(() => authApi().revokeUserSessions(u.id), (r) => t('auth.users.revoked', { count: r.revoked, name: u.username })),
      })
    if (allowed.includes('disable'))
      items.push({
        key: 'disable',
        label: t('auth.users.disable'),
        icon: <Ban size={14} aria-hidden />,
        onSelect: () => void run(() => authApi().setUserStatus(u.id, 'disabled'), () => t('auth.users.disabledNote', { name: u.username })),
      })
    if (allowed.includes('enable'))
      items.push({
        key: 'enable',
        label: t('auth.users.enable'),
        icon: <Undo2 size={14} aria-hidden />,
        onSelect: () => void run(() => authApi().setUserStatus(u.id, 'active'), () => t('auth.users.enabledNote', { name: u.username })),
      })
    if (allowed.includes('recovery'))
      items.push({
        key: 'recovery',
        label: t('auth.users.recovery'),
        icon: <KeyRound size={14} aria-hidden />,
        onSelect: () =>
          void run(
            () => authApi().issueRecovery(u.id),
            (r) => {
              setDialog({ kind: 'recovery', user: u, link: r.link, expiresAt: r.expiresAt })
              return null
            },
          ),
      })
    if (allowed.includes('delete'))
      items.push({ key: 'delete', label: t('auth.users.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => setDialog({ kind: 'delete', user: u }) })
    return items
  }

  const list = users.data ? sortUsers(users.data) : []
  return (
    <Section
      title={t('auth.users.people')}
      action={
        <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
          <UserPlus size={14} aria-hidden />
          {t('auth.users.create')}
        </Button>
      }
    >
      {note && (
        <p role="status" className="text-sm text-positive">
          {note}
        </p>
      )}
      <ErrorNote message={act.error?.message ?? (users.error ? describeError(users.error).message : null)} />
      {users.isPending && <Muted>{t('auth.users.loading')}</Muted>}
      {users.data && (
        <Panel>
          <ul aria-label={t('auth.users.listLabel')}>
            {list.map((u) => {
              const self = u.id === meId
              const factors = [u.factors.passkeys > 0 ? t('auth.users.factor.passkey', { count: u.factors.passkeys }) : null, u.factors.totp ? t('auth.users.factor.totp') : null].filter(Boolean)
              return (
                <li key={u.id}>
                  <Row>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="truncate">{u.displayName || u.username}</span>
                        <Pill>{t(`auth.users.role.${u.role}`)}</Pill>
                        {u.status === 'disabled' && <Pill tone="warning">{t('auth.users.statusDisabled')}</Pill>}
                        {self && <Pill>{t('auth.users.you')}</Pill>}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {u.username} · {u.lastSignInAt ? t('auth.users.lastSignIn', { time: formatWhen(u.lastSignInAt) }) : t('auth.users.neverSignedIn')} ·{' '}
                        {factors.length > 0 ? factors.join(', ') : t('auth.users.noFactor')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <RoleSelect
                        compact
                        label={t('auth.users.roleOf', { name: u.username })}
                        value={u.role}
                        disabled={self || act.busy}
                        onChange={(r: Role) => void run(() => authApi().setUserRole(u.id, r), () => t('auth.users.roleChanged', { name: u.username }))}
                      />
                      <ActionsMenu label={t('auth.users.actionsFor', { name: u.username })} items={menuFor(u)} />
                    </div>
                  </Row>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}

      {dialog?.kind === 'create' && <CreateUserDialog onClose={() => setDialog(null)} onCreated={() => void reload()} />}
      {dialog?.kind === 'delete' && (
        <DeleteUserDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null)
            setNote(t('auth.users.deletedNote', { name: dialog.user.username }))
            void reload()
          }}
        />
      )}
      {dialog?.kind === 'recovery' && (
        <LinkShownDialog
          title={t('auth.users.recoveryTitle', { name: dialog.user.username })}
          lead={t('auth.users.recoveryLead')}
          link={dialog.link}
          expiresAt={dialog.expiresAt}
          onClose={() => setDialog(null)}
        />
      )}
    </Section>
  )
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: UserSummary; onClose: () => void; onDeleted: () => void }) {
  const { guard } = useStepUp()
  const action = useAction()
  return (
    <ModalForm
      danger
      title={t('auth.users.deleteTitle', { name: user.username })}
      lead={t('auth.users.deleteLead')}
      onClose={onClose}
      busy={action.busy}
      submitLabel={t('auth.users.deleteConfirm')}
      error={action.error?.message ?? null}
      onSubmit={async () => {
        const r = await action.run(() => guard(() => authApi().deleteUser(user.id)))
        if (r.ok) onDeleted()
      }}
    />
  )
}

function InvitesSection() {
  const client = useQueryClient()
  const { guard } = useStepUp()
  const invites = useQuery({ queryKey: INVITES_KEY, queryFn: () => authApi().listInvites(), retry: false })
  const [issuing, setIssuing] = useState(false)
  const act = useAction()
  const reload = () => client.invalidateQueries({ queryKey: INVITES_KEY })

  async function revoke(invite: InviteInfo) {
    const r = await act.run(() => guard(() => authApi().revokeInvite(invite.id)))
    if (r.ok) await reload()
  }

  return (
    <Section
      title={t('auth.users.invites')}
      lead={t('auth.users.invitesLead')}
      action={
        <Button onClick={() => setIssuing(true)}>
          <UserPlus size={14} aria-hidden />
          {t('auth.users.invite')}
        </Button>
      }
    >
      <ErrorNote message={act.error?.message ?? (invites.error ? describeError(invites.error).message : null)} />
      {invites.data && invites.data.length === 0 && <Muted>{t('auth.users.invitesNone')}</Muted>}
      {invites.data && invites.data.length > 0 && (
        <Panel>
          <ul aria-label={t('auth.users.invitesLabel')}>
            {invites.data.map((i) => (
              <li key={i.id}>
                <Row>
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    {i.role && <Pill>{t(`auth.users.role.${i.role}`)}</Pill>}
                    <span className="text-muted">{t('auth.users.inviteExpires', { time: formatWhen(i.expiresAt) })}</span>
                  </p>
                  <Button disabled={act.busy} aria-label={t('auth.users.revokeInvite', { time: formatWhen(i.expiresAt) })} onClick={() => void revoke(i)}>
                    {t('auth.users.revoke')}
                  </Button>
                </Row>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {issuing && <InviteDialog onClose={() => setIssuing(false)} onIssued={() => void reload()} />}
    </Section>
  )
}
