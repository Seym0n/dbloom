import { useEffect } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { AuthFrame, AuthHeading } from '~/components/auth/auth-frame'
import { AssistantAdminPage } from '~/components/auth/assistant/assistant-admin-page'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { setCsrfToken } from '~/lib/csrf'
import { loadHome } from '~/routes/index'

/** `/admin/assistant`: administrators only (SPEC/34 FR-AST-019). Direct and stateless installs have no administrators and go to the front page. */
export const Route = createFileRoute('/admin/assistant')({
  head: () => ({ meta: [{ title: t('asstAdmin.pageTitle') }] }),
  loader: async () => {
    const boot = await loadHome()
    if (boot.kind === 'direct' || (boot.kind === 'account' && !boot.session)) throw redirect({ to: '/' })
    return boot
  },
  component: AdminAssistant,
})

function AdminAssistant() {
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
        <AuthHeading title={t('asstAdmin.forbidden')} lead={t('asstAdmin.forbiddenLead')} />
        <Button size="lg" onClick={() => void router.navigate({ to: '/' })}>
          {t('asstAdmin.back')}
        </Button>
      </AuthFrame>
    )
  }
  return <AssistantAdminPage />
}
