import { useMemo, useState } from 'react'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { StepUpProvider } from '~/components/auth/account/step-up'
import { IdleWarning } from '~/components/auth/idle-warning'
import { SessionEndedDialog } from '~/components/session-ended-dialog'
import { AppShell } from '~/components/shell/app-shell'
import type { AccountSessionView } from '~/lib/auth/api'
import { setCsrfToken } from '~/lib/csrf'
import { createQueryClient } from '~/lib/session-state'
import {
  getStoredConnectionId,
  pickActive,
  setStoredConnectionId,
} from '~/lib/auth/connections-logic'
import type { OpenSearch } from '~/routes/index'
import { ConnectionHome } from './connection-home'
import { ConnectionSwitcher } from './connection-switcher'

/**
 * Account session in the `full` state: the connection picker while nothing is open, else the shell on the active
 * connection. The active id lives in session storage under `x-dbloom-connection`, which every server call sends.
 * The shell is keyed by connection, so switching starts it clean and cached results of the old server are dropped.
 */
export function AccountApp(props: {
  session: AccountSessionView
  open: OpenSearch
  onSignOut: () => void
}) {
  return (
    <StepUpProvider>
      <AccountAppInner {...props} />
      <IdleWarning idleExpiresAt={props.session.idleExpiresAt} />
    </StepUpProvider>
  )
}

function AccountAppInner({
  session,
  open,
  onSignOut,
}: {
  session: AccountSessionView
  open: OpenSearch
  onSignOut: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [stored, setStored] = useState<string | null>(getStoredConnectionId)
  const active = pickActive(session.connections, stored)
  const isAdmin = session.user?.role === 'admin'
  // One query cache per connection: nothing fetched for one server can show up under another (found by e2e: a shared
  // cache showed the previous server's databases after "Add connection").
  const connectionKey = active?.connectionId
  const shellClient = useMemo(() => createQueryClient(), [connectionKey])
  // After a reload the server render knew the session and this tab did not: the token goes out with every call.
  if (typeof window !== 'undefined') setCsrfToken(session.csrf)

  // Written while rendering so the shell's first requests already carry the right connection.
  if (typeof window !== 'undefined' && getStoredConnectionId() !== (active?.connectionId ?? null))
    setStoredConnectionId(active?.connectionId ?? null)

  const select = (id: string | null) => {
    setStoredConnectionId(id)
    setStored(id)
    queryClient.clear()
  }

  if (!active) {
    return (
      <>
        {/* The picker needs the neutral dialog too: when the idle limit passes here the page must say so. */}
        <SessionEndedDialog defaults={{ server: '', username: '' }} onSignedIn={() => undefined} onAccountSignIn={onSignOut} />
        <ConnectionHome
          isAdmin={isAdmin}
          banner={session.banner}
          maintenance={session.maintenance}
          onSignOut={onSignOut}
          onOpened={(info) => {
            select(info.connectionId)
            void router.invalidate()
          }}
        />
      </>
    )
  }

  return (
    <QueryClientProvider client={shellClient}>
      <AppShell
        key={active.connectionId}
        session={{
          csrf: session.csrf,
          readOnly: active.readOnly,
          target: { host: active.host, port: active.port, username: active.targetUser },
        }}
        open={open}
        account={{ onSignOut, name: session.user?.displayName || session.user?.username || '' }}
        connectionSlot={
          <ConnectionSwitcher
            connections={session.connections}
            activeId={active.connectionId}
            isAdmin={isAdmin}
            onSwitch={(id) => select(id)}
            onOpened={(info) => {
              select(info.connectionId)
              void router.invalidate()
            }}
            onClosed={(id) => {
              if (id === active.connectionId) select(null)
              else queryClient.clear()
              void router.invalidate()
            }}
          />
        }
      />
    </QueryClientProvider>
  )
}
