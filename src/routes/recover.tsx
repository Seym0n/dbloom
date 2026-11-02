import { createFileRoute } from '@tanstack/react-router'
import { LinkPage } from '~/components/auth/link-page'
import { t } from '~/i18n'

export const Route = createFileRoute('/recover')({
  head: () => ({ meta: [{ title: t('auth.recover.pageTitle') }, { name: 'referrer', content: 'no-referrer' }] }),
  component: () => <LinkPage kind="recovery" />,
})
