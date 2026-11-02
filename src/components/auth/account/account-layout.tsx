import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { Link, Outlet, redirect, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { authApi, type AccountSessionView, type AuthBoot } from '~/lib/auth/api'
import { targetKeyOf } from '~/lib/auth/account-logic'
import { setCsrfToken } from '~/lib/csrf'
import { AccountGate, useAccountSignOut } from '../auth-gate'
import type { PrefsTarget } from './prefs-page'

/** Loader result of `/account`: the boot state, or a marker while the mock layer waits for the browser. */
export type AccountData = AuthBoot | { kind: 'client' }

/** Setup goes to /setup, a missing session to the front page (sign-in); the mock layer defers to the browser like the front page. */
export async function loadAccount(): Promise<AccountData> {
  if (typeof window === 'undefined' && import.meta.env.VITE_DBLOOM_AUTH_MOCK === 'true') return { kind: 'client' }
  const boot = await authApi().getAuthBoot()
  if (boot.kind === 'setup_pending') throw redirect({ to: '/setup' })
  if (!boot.session) throw redirect({ to: '/' })
  return boot
}

type AccountContextValue = { mode: 'account' | 'direct'; session: AccountSessionView | null; target: PrefsTarget | null }
const AccountContext = createContext<AccountContextValue | null>(null)

export function useAccountContext(): AccountContextValue {
  const value = useContext(AccountContext)
  if (!value) throw new Error('useAccountContext outside the account layout')
  return value
}

const linkClass = 'press inline-flex h-8 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted hover:text-ink'
const activeClass = 'bg-active text-ink'

/** Frame of the account pages: back link to the app, who is signed in, the two pages, and the page itself. */
export function AccountLayout({ data }: { data: AccountData }) {
  const router = useRouter()
  const signOut = useAccountSignOut()

  useEffect(() => {
    if (data.kind === 'client') void router.invalidate()
  }, [data.kind, router])

  if (data.kind === 'client' || data.kind === 'setup_pending' || !data.session) return null
  // The loader ran on the server for a direct page load: this tab has no token yet, and every account call sends it.
  if (typeof window !== 'undefined') setCsrfToken(data.session.csrf)

  if (data.kind === 'direct') {
    const { host, port, username } = data.session.target
    const value: AccountContextValue = { mode: 'direct', session: null, target: { key: targetKeyOf({ host, port, user: username }), label: `${username}@${host}:${port}` } }
    return (
      <AccountContext.Provider value={value}>
        <Shell identity={null} onSignOut={null} showSecurity={false} />
      </AccountContext.Provider>
    )
  }

  const { session } = data
  const connection = session.connections[0]
  const value: AccountContextValue = {
    mode: 'account',
    session,
    target: connection ? { key: targetKeyOf({ host: connection.host, port: connection.port, user: connection.targetUser }), label: `${connection.targetUser}@${connection.host}:${connection.port}` } : null,
  }
  return (
    <AccountContext.Provider value={value}>
      <AccountGate session={session}>
        <Shell identity={session.user?.displayName || session.user?.username || null} onSignOut={signOut} showSecurity />
      </AccountGate>
    </AccountContext.Provider>
  )
}

function Shell({ identity, onSignOut, showSecurity }: { identity: string | null; onSignOut: (() => void) | null; showSecurity: boolean }): ReactNode {
  return (
    <div className="min-h-full bg-ground">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 px-4 py-2">
          <Link to="/" className="press inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] pr-2 text-sm font-medium text-ink">
            <ArrowLeft size={16} aria-hidden />
            {t('account.back')}
          </Link>
          {identity && (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-muted">{identity}</span>
              {onSignOut && (
                <Button variant="ghost" onClick={onSignOut}>
                  {t('auth.signOut')}
                </Button>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 py-6 pb-16">
        <nav aria-label={t('account.nav')} className="flex gap-1">
          {showSecurity && (
            <Link to="/account" activeOptions={{ exact: true }} className={linkClass} activeProps={{ className: `${linkClass} ${activeClass}` }}>
              {t('account.nav.security')}
            </Link>
          )}
          <Link to="/account/preferences" className={linkClass} activeProps={{ className: `${linkClass} ${activeClass}` }}>
            {t('account.nav.preferences')}
          </Link>
        </nav>
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
