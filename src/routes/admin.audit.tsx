import { useEffect } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { AuthFrame, AuthHeading } from '~/components/auth/auth-frame'
import { AuditPage } from '~/components/auth/audit/audit-page'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { setCsrfToken } from '~/lib/csrf'
import { loadHome } from '~/routes/index'

/** `/admin/audit`: administrators only (SPEC/29 FR-AAU-007). Direct and stateless installs get a notice instead of the list. */
export const Route = createFileRoute('/admin/audit')({
  head: () => ({ meta: [{ title: t('audit.pageTitle') }] }),
  // `?actor=<user id>` comes from the Activity action on the Users page.
  validateSearch: (search: Record<string, unknown>): { actor?: string } =>
    typeof search.actor === 'string' && search.actor.length > 0 && search.actor.length <= 200 ? { actor: search.actor } : {},
  loader: async () => {
    const boot = await loadHome()
    if (boot.kind === 'account' && !boot.session) throw redirect({ to: '/' })
    return boot
  },
  component: AdminAudit,
})

function AdminAudit() {
  const boot = Route.useLoaderData()
  const { actor } = Route.useSearch()
  const router = useRouter()
  useEffect(() => {
    // The mock layer keeps its state in the browser, so the server render defers and the browser loads it.
    if (boot.kind === 'client') void router.invalidate()
  }, [boot.kind, router])

  if (boot.kind === 'direct') return <AuditPage mode="direct" />
  if (boot.kind !== 'account' || !boot.session) return null
  const { session } = boot
  if (typeof window !== 'undefined') setCsrfToken(session.csrf)
  if (session.state !== 'full' || session.user?.role !== 'admin') {
    return (
      <AuthFrame>
        <AuthHeading title={t('audit.forbidden')} lead={t('audit.forbiddenLead')} />
        <Button size="lg" onClick={() => void router.navigate({ to: '/' })}>
          {t('audit.back')}
        </Button>
      </AuthFrame>
    )
  }
  return <AuditPage mode="account" {...(actor ? { initialActor: actor } : {})} />
}
