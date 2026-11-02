import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { t } from '~/i18n'
import { AuthFrame, AuthHeading } from '~/components/auth/auth-frame'
import { TabList, panelId, tabId } from '~/components/auth/tab-list'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import type { ConnectionInfo } from '~/server/auth/types'
import { ConnectPanel } from './connect-panel'
import { ProfilesManager } from './profiles-manager'
import { VaultPanel } from './vault-panel'

/** Vault and saved profiles on one page (FR-AUT-021, 022). */
export function ManagePanel() {
  return (
    <div className="flex flex-col gap-8">
      <VaultPanel />
      <ProfilesManager />
    </div>
  )
}

/** The front page of a signed-in account without an open connection: replaces the "no connection yet" placeholder. */
export function ConnectionHome({ onOpened, onSignOut, isAdmin }: { onOpened: (info: ConnectionInfo) => void; onSignOut: () => void; isAdmin: boolean }) {
  const [managing, setManaging] = useState(false)
  return (
    <AuthFrame wide>
      {managing ? (
        <>
          <Button variant="ghost" className="-ml-2 mb-4" onClick={() => setManaging(false)}>
            <ArrowLeft size={14} aria-hidden />
            {t('auth.conn.back')}
          </Button>
          <AuthHeading title={t('auth.conn.manageTitle')} lead={t('auth.conn.manageLead')} />
          <ManagePanel />
        </>
      ) : (
        <>
          <AuthHeading title={t('auth.conn.title')} lead={t('auth.conn.lead')} />
          <ConnectPanel onOpened={onOpened} onManage={() => setManaging(true)} />
        </>
      )}
      <div className="mt-8 flex flex-wrap gap-2">
        {isAdmin && (
          <Link to="/admin/users" className="press inline-flex h-8 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted hover:bg-active hover:text-ink">
            {t('auth.users.link')}
          </Link>
        )}
        <Button variant="ghost" onClick={onSignOut}>
          {t('auth.signOut')}
        </Button>
      </div>
    </AuthFrame>
  )
}

/** "Add a connection" and "profiles and vault" for the shell, in one dialog. */
export function ConnectionsDialog({ onClose, onOpened, startOn = 'open' }: { onClose: () => void; onOpened: (info: ConnectionInfo) => void; startOn?: 'open' | 'manage' }) {
  const [tab, setTab] = useState<'open' | 'manage'>(startOn)
  return (
    <Dialog open onClose={onClose} labelledBy="connections-title" className="w-[min(620px,calc(100vw-32px))]">
      <div className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="connections-title" className="text-base font-semibold">
            {t('auth.conn.dialogTitle')}
          </h2>
          <Button size="default" onClick={onClose}>
            {t('auth.conn.close')}
          </Button>
        </div>
        <TabList
          label={t('auth.conn.dialogTabs')}
          idPrefix="connd"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'open', label: t('auth.conn.tabOpen') },
            { key: 'manage', label: t('auth.conn.tabManage') },
          ]}
        />
        <div role="tabpanel" id={panelId('connd', tab)} aria-labelledby={tabId('connd', tab)}>
          {tab === 'open' ? <ConnectPanel onOpened={onOpened} onManage={() => setTab('manage')} /> : <ManagePanel />}
        </div>
      </div>
    </Dialog>
  )
}
