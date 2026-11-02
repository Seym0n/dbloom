import { createFileRoute } from '@tanstack/react-router'
import { useAccountContext } from '~/components/auth/account/account-layout'
import { PrefsPage } from '~/components/auth/account/prefs-page'

export const Route = createFileRoute('/account/preferences')({
  component: AccountPreferences,
})

function AccountPreferences() {
  const { target } = useAccountContext()
  return <PrefsPage target={target} />
}
