import { useEffect } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { AuthFrame, AuthHeading } from '~/components/auth/auth-frame'
import { ExposurePage } from '~/components/auth/exposure/exposure-page'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { setCsrfToken } from '~/lib/csrf'
import { loadHome } from '~/routes/index'

/** `/admin/exposure`: administrators only (SPEC/31 FR-AEX-003). Direct and stateless installs have no administrators and go to the front page. */
export const Route = createFileRoute('/admin/exposure')({
  head: () => ({ meta: [{ title: t('exposure.pageTitle') }] }),
  loader: async () => {
    const boot = await loadHome()
    if (boot.kind === 'direct' || (boot.kind === 'account' && !boot.session)) throw redirect({ to: '/' })
    return boot
  },
  component: AdminExposure,
})

function AdminExposure() {
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
        <AuthHeading title={t('exposure.forbidden')} lead={t('exposure.forbiddenLead')} />
        <Button size="lg" onClick={() => void router.navigate({ to: '/' })}>
          {t('exposure.back')}
        </Button>
      </AuthFrame>
    )
  }
  return <ExposurePage />
}
