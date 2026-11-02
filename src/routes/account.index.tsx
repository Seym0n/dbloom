import { Navigate, createFileRoute } from '@tanstack/react-router'
import { useAccountContext } from '~/components/auth/account/account-layout'
import { SecurityPage } from '~/components/auth/account/security-page'

export const Route = createFileRoute('/account/')({
  component: AccountSecurity,
})

/** Account security; a direct session has no account, so its only page is Preferences. */
function AccountSecurity() {
  const { session } = useAccountContext()
  if (!session) return <Navigate to="/account/preferences" replace />
  return <SecurityPage session={session} />
}
