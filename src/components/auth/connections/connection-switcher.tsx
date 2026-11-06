import { useId, useState } from 'react'
import { ChevronDown, Plus, Settings2, X } from 'lucide-react'
import { t } from '~/i18n'
import { ActionsMenu } from '~/components/ui/menu'
import { Select } from '~/components/ui/select'
import { ErrorNote } from '~/components/auth/auth-frame'
import { authApi } from '~/lib/auth/api'
import { connectionLabel } from '~/lib/auth/connections-logic'
import { useAction } from '~/lib/auth/use-action'
import type { ConnectionInfo } from '~/server/auth/types'
import { ConnectionsDialog } from './connection-home'

/**
 * Per-connection switching in the shell's sidebar (FR-AUT-018): the open connections and one menu (add, profiles and vault, close). Only rendered for account sessions; direct mode never sees it.
 */
export function ConnectionSwitcher({
  connections,
  activeId,
  onSwitch,
  onOpened,
  onClosed,
}: {
  connections: ConnectionInfo[]
  activeId: string
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
      <ActionsMenu
        label={t('auth.conn.menuLabel')}
        className="flex h-8 w-full items-center justify-between gap-2 px-2 text-sm text-muted pointer-coarse:h-9 pointer-coarse:w-full"
        trigger={
          <>
            <span>{t('auth.conn.menu')}</span>
            <ChevronDown size={14} aria-hidden />
          </>
        }
        items={[
          { key: 'add', label: t('auth.conn.add'), icon: <Plus size={14} aria-hidden />, onSelect: () => setDialog('open') },
          { key: 'manage', label: t('auth.conn.manageShort'), icon: <Settings2 size={14} aria-hidden />, onSelect: () => setDialog('manage') },
          {
            key: 'close',
            label: t('auth.conn.closeThis'),
            icon: <X size={14} aria-hidden />,
            disabled: close.busy,
            onSelect: async () => {
              const r = await close.run(() => authApi().closeConnection(activeId))
              if (r.ok) onClosed(activeId)
            },
          },
        ]}
      />
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
