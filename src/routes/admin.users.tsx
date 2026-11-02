import { useEffect } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { AuthFrame, AuthHeading } from '~/components/auth/auth-frame'
import { UsersPage } from '~/components/auth/users/users-page'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { setCsrfToken } from '~/lib/csrf'
import { loadHome } from '~/routes/index'

/** `/admin/users`: administrators only (FR-AUT-028). Everyone else is sent to the front page or told it is not for them. */
export const Route = createFileRoute('/admin/users')({
  head: () => ({ meta: [{ title: t('auth.users.pageTitle') }] }),
  loader: async () => {
    const boot = await loadHome()
    if (boot.kind === 'direct' || (boot.kind === 'account' && !boot.session)) throw redirect({ to: '/' })
    return boot
  },
  component: AdminUsers,
})

function AdminUsers() {
  const boot = Route.useLoaderData()
  const router = useRouter()
  useEffect(() => {
    // The mock layer keeps its state in the browser, so the server render defers and the browser loads it.
    if (boot.kind === 'client') void router.invalidate()
  }, [boot.kind, router])

  if (boot.kind !== 'account' || !boot.session) return null
  const { session } = boot
  if (typeof window !== 'undefined') setCsrfToken(session.csrf)
  if (session.state !== 'full' || session.user?.role !== 'admin') {
    return (
      <AuthFrame>
        <AuthHeading title={t('auth.users.forbidden')} lead={t('auth.users.forbiddenLead')} />
        <Button size="lg" onClick={() => void router.navigate({ to: '/' })}>
          {t('auth.users.back')}
        </Button>
      </AuthFrame>
    )
  }
  return <UsersPage meId={session.user.id} />
}
