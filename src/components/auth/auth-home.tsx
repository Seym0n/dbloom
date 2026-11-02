import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { LoginPage } from '~/components/login-page'
import { AppShell } from '~/components/shell/app-shell'
import type { AuthBoot } from '~/lib/auth/api'
import type { OpenSearch } from '~/routes/index'
import { AccountLogin } from './account-login'
import { AccountGate, useAccountSignOut } from './auth-gate'
import { AccountApp } from './connections/account-app'

/** Loader result of the front page: the boot state, or a marker while the mock layer waits for the browser. */
export type HomeData = AuthBoot | { kind: 'client' }

/** Front page: direct login and shell unchanged; account mode goes through sign-in and the session-state guard. */
export function AuthHome({ boot, open }: { boot: HomeData; open: OpenSearch }) {
  const router = useRouter()
  const signOut = useAccountSignOut()

  useEffect(() => {
    // The mock layer keeps its state in the browser, so the server render defers and the browser loads it.
    if (boot.kind === 'client') void router.invalidate()
  }, [boot.kind, router])

  switch (boot.kind) {
    case 'client':
    case 'setup_pending':
      return null
    case 'direct':
      return boot.session ? <AppShell session={boot.session} open={open} /> : <LoginPage />
    case 'account': {
      const { session } = boot
      if (!session) return <AccountLogin info={boot.info} onSignedIn={() => router.invalidate()} />
      return (
        <AccountGate session={session}>
          <AccountApp session={session} open={open} onSignOut={signOut} />
        </AccountGate>
      )
    }
  }
}
