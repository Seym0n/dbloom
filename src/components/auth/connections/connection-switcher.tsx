import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus, Settings2, Users, X, ScrollText } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Select } from '~/components/ui/select'
import { ErrorNote } from '~/components/auth/auth-frame'
import { authApi } from '~/lib/auth/api'
import { connectionLabel } from '~/lib/auth/connections-logic'
import { useAction } from '~/lib/auth/use-action'
import type { ConnectionInfo } from '~/server/auth/types'
import { ConnectionsDialog } from './connection-home'

/**
 * Per-connection switching in the shell's sidebar (FR-AUT-018): the open connections, add, close and the profile and vault
 * dialog. Only rendered for account sessions; direct mode never sees it.
 */
export function ConnectionSwitcher({
  connections,
  activeId,
  isAdmin,
  onSwitch,
  onOpened,
  onClosed,
}: {
  connections: ConnectionInfo[]
  activeId: string
  isAdmin: boolean
  onSwitch: (id: string) => void
  onOpened: (info: ConnectionInfo) => void
  onClosed: (id: string) => void
}) {
  const [dialog, setDialog] = useState<'open' | 'manage' | null>(null)
  const close = useAction()
  const selectId = useId()

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={t('auth.conn.switcherGroup')}>
      {connections.length > 1 && (
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-xs text-muted">
            {t('auth.conn.switcherLabel')}
          </label>
          <Select id={selectId} compact value={activeId} onChange={(e) => onSwitch(e.target.value)}>
            {connections.map((c) => (
              <option key={c.connectionId} value={c.connectionId}>
                {connectionLabel(c)} · {c.targetUser}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" onClick={() => setDialog('open')}>
          <Plus size={14} aria-hidden />
          {t('auth.conn.add')}
        </Button>
        <Button
          variant="ghost"
          disabled={close.busy}
          onClick={async () => {
            const r = await close.run(() => authApi().closeConnection(activeId))
            if (r.ok) onClosed(activeId)
          }}
        >
          <X size={14} aria-hidden />
          {t('auth.conn.closeThis')}
        </Button>
        <Button variant="ghost" onClick={() => setDialog('manage')}>
          <Settings2 size={14} aria-hidden />
          {t('auth.conn.manageShort')}
        </Button>
        {isAdmin && (
          <Link to="/admin/users" className="press inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted hover:bg-active hover:text-ink">
            <Users size={14} aria-hidden />
            {t('auth.users.link')}
          </Link>
        )}
        {isAdmin && (
          <Link to="/admin/audit" className="press inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted hover:bg-active hover:text-ink">
            <ScrollText size={14} aria-hidden />
            {t('audit.nav')}
          </Link>
        )}
      </div>
      <ErrorNote message={close.error?.message} />
      {dialog && (
        <ConnectionsDialog
          startOn={dialog}
          onClose={() => setDialog(null)}
          onOpened={(info) => {
            setDialog(null)
            onOpened(info)
          }}
        />
      )}
    </div>
  )
}
