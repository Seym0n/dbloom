import { createFileRoute } from '@tanstack/react-router'
import { AccountLayout, loadAccount } from '~/components/auth/account/account-layout'
import { t } from '~/i18n'

export const Route = createFileRoute('/account')({
  head: () => ({ meta: [{ title: t('account.pageTitle') }] }),
  loader: () => loadAccount(),
  component: Account,
})

function Account() {
  return <AccountLayout data={Route.useLoaderData()} />
}
