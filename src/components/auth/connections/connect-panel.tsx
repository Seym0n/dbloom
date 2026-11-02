import { useState } from 'react'
import { Plug } from 'lucide-react'
import { t } from '~/i18n'
import { TabList, panelId, tabId } from '~/components/auth/tab-list'
import { ErrorNote } from '~/components/auth/auth-frame'
import { Button } from '~/components/ui/button'
import { authApi } from '~/lib/auth/api'
import { setStoredConnectionId, vaultView } from '~/lib/auth/connections-logic'
import { useAction } from '~/lib/auth/use-action'
import type { ConnectionInfo, OpenConnectionInput } from '~/server/auth/types'
import { connectErrorMessage, TypedConnectForm } from './typed-form'
import { useProfiles, useRefreshVault, useVaultStatus } from './use-vault'
import { VaultFlowDialog, type VaultFlow } from './vault-dialogs'

type Tab = 'profiles' | 'typed'

/** Opens a connection and makes it the one the shell talks to (`x-dbloom-connection`). */
export function useOpenConnection(onOpened: (info: ConnectionInfo) => void) {
  const action = useAction()
  const open = async (input: OpenConnectionInput) => {
    const r = await action.run(() => authApi().openConnection(input))
    if (!r.ok) return
    setStoredConnectionId(r.value.connectionId)
    onOpened(r.value)
  }
  return { open, busy: action.busy, error: action.error, clear: action.clear }
}

/** Saved profiles or typed credentials (FR-AUT-018 to 020); used by the front page and by the shell's add-connection dialog. */
export function ConnectPanel({ onOpened, onManage }: { onOpened: (info: ConnectionInfo) => void; onManage?: () => void }) {
  const [tab, setTab] = useState<Tab>('profiles')
  const { open, busy, error, clear } = useOpenConnection(onOpened)
  return (
    <div className="flex flex-col gap-5">
      <TabList
        label={t('auth.conn.tabsLabel')}
        idPrefix="conn"
        value={tab}
        onChange={(k) => {
          clear()
          setTab(k)
        }}
        tabs={[
          { key: 'profiles', label: t('auth.conn.tabProfiles') },
          { key: 'typed', label: t('auth.conn.tabTyped') },
        ]}
      />
      <div role="tabpanel" id={panelId('conn', tab)} aria-labelledby={tabId('conn', tab)}>
        {tab === 'typed' ? (
          <TypedConnectForm busy={busy} error={error} onSubmit={open} />
        ) : (
          <ProfileOpenList busy={busy} error={connectErrorMessage(error)} onOpen={(profileId) => open({ source: 'profile', profileId })} onManage={onManage} />
        )}
      </div>
    </div>
  )
}

function ProfileOpenList({ busy, error, onOpen, onManage }: { busy: boolean; error: string | null; onOpen: (id: string) => void; onManage?: (() => void) | undefined }) {
  const vault = useVaultStatus()
  const view = vault.data ? vaultView(vault.data) : null
  const profiles = useProfiles(view === 'unlocked' || view === 'locked')
  const refresh = useRefreshVault()
  const [flow, setFlow] = useState<VaultFlow | null>(null)

  if (vault.isPending) return <p className="text-sm text-muted">{t('auth.vault.loading')}</p>
  if (view === 'disabled') return <p className="text-sm text-muted">{t('auth.profile.disabled')}</p>

  return (
    <div className="flex flex-col gap-4">
      {view === 'absent' && (
        <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] bg-raised p-4">
          <p className="text-sm">{t('auth.profile.vaultAbsent')}</p>
          <Button variant="primary" onClick={() => setFlow('create')}>
            {t('auth.vault.create')}
          </Button>
        </div>
      )}
      {view === 'locked' && (
        <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] bg-raised p-4">
          <p className="text-sm">{t('auth.profile.vaultLocked')}</p>
          <Button variant="primary" onClick={() => setFlow('unlock')}>
            {t('auth.vault.unlock')}
          </Button>
        </div>
      )}
      {view && view !== 'absent' && (
        <>
          {profiles.data && profiles.data.length === 0 && (
            <div>
              <p className="text-sm font-medium">{t('auth.profile.none')}</p>
              <p className="text-sm text-muted">{t('auth.profile.noneLead')}</p>
            </div>
          )}
          {profiles.data && profiles.data.length > 0 && (
            <ul aria-label={t('auth.profile.listLabel')} className="flex flex-col gap-2">
              {profiles.data.map((p) => (
                <li key={p.id} className="flex items-center gap-3 rounded-[var(--radius-card)] bg-raised px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted">
                      {p.targetUser ? `${p.targetUser}@` : ''}
                      {p.host}:{p.port}
                    </p>
                  </div>
                  <Button aria-label={t('auth.profile.openNamed', { name: p.name })} disabled={busy || view === 'locked'} onClick={() => onOpen(p.id)}>
                    <Plug size={14} aria-hidden />
                    {t('auth.conn.connect')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <ErrorNote message={error} />
      {onManage && (
        <Button variant="ghost" className="self-start" onClick={onManage}>
          {t('auth.conn.manage')}
        </Button>
      )}
      {flow && (
        <VaultFlowDialog
          key={flow}
          flow={flow}
          onClose={() => setFlow(null)}
          onDone={() => {
            setFlow(null)
            void refresh()
          }}
          onSwitch={setFlow}
        />
      )}
    </div>
  )
}
