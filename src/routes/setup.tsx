import { createFileRoute } from '@tanstack/react-router'
import { SetupWizard } from '~/components/auth/setup/setup-wizard'
import { t } from '~/i18n'

/** On the server render a finished (or never needed) setup makes the document a 404, as the setup functions are (FR-AUT-003). */
async function markGone() {
  if (typeof window !== 'undefined' || import.meta.env.VITE_DBLOOM_AUTH_MOCK === 'true') return
  await (await import('~/server/auth.functions')).setupPageStatus().catch(() => undefined)
}

export const Route = createFileRoute('/setup')({
  head: () => ({ meta: [{ title: t('setup.pageTitle') }] }),
  loader: markGone,
  component: SetupWizard,
})
