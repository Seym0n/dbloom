import { useEffect } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { AuthFrame, AuthHeading } from '~/components/auth/auth-frame'
import { SettingsPage } from '~/components/auth/settings/settings-page'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { setCsrfToken } from '~/lib/csrf'
import { loadHome } from '~/routes/index'

/** `/admin/settings`: administrators only (SPEC/32 FR-ASE-013). Direct and stateless installs have no administrators and go to the front page. */
export const Route = createFileRoute('/admin/settings')({
  head: () => ({ meta: [{ title: t('settings.pageTitle') }] }),
  loader: async () => {
    const boot = await loadHome()
    if (boot.kind === 'direct' || (boot.kind === 'account' && !boot.session)) throw redirect({ to: '/' })
    return boot
  },
  component: AdminSettings,
})

function AdminSettings() {
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
        <AuthHeading title={t('settings.forbidden')} lead={t('settings.forbiddenLead')} />
        <Button size="lg" onClick={() => void router.navigate({ to: '/' })}>
          {t('settings.back')}
        </Button>
      </AuthFrame>
    )
  }
  return <SettingsPage />
}
