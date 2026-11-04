import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { t } from '~/i18n'
import { BrandName } from '~/components/brand'
import { Button } from '~/components/ui/button'
import { Muted, Panel, Section } from '~/components/auth/account/account-ui'
import { StepUpProvider } from '~/components/auth/account/step-up'
import { ErrorNote } from '~/components/auth/auth-frame'
import { ExposureBanner } from '~/components/auth/exposure/exposure-banner'
import { authApi } from '~/lib/auth/api'
import { SETTING_GROUPS } from '~/server/auth/setting-meta'
import { SettingRow } from './setting-row'
import { SITE_NOTICES_KEY, SiteNotices } from './site-notices'

export const SETTINGS_KEY = ['admin', 'settings'] as const

/** Administrator page: every setting with its source, limits and editor (SPEC/32 FR-ASE-013). Wrapped in the step-up dialog. */
export function SettingsPage() {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => authApi().getSettings(), retry: false })
  // The banner and maintenance line of this page come from the session: a saved text must show at once.
  const reload = () => Promise.all([client.invalidateQueries({ queryKey: SETTINGS_KEY }), client.invalidateQueries({ queryKey: SITE_NOTICES_KEY })])
  return (
    <StepUpProvider>
      <main className="min-h-full bg-ground px-4 py-8">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8">
          <header className="flex flex-col gap-4">
            <BrandName />
            <Link to="/" className="press -ml-2 inline-flex h-8 w-fit items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-medium text-muted hover:bg-active hover:text-ink">
              <ArrowLeft size={14} aria-hidden />
              {t('settings.back')}
            </Link>
            <div>
              <h1 className="mb-1 text-[22px] font-semibold leading-7">{t('settings.title')}</h1>
              <p className="max-w-[60ch] text-sm text-muted">{t('settings.lead')}</p>
            </div>
          </header>
          <ExposureBanner />
          <SiteNotices />
          {settings.isPending ? (
            <Muted>{t('settings.loading')}</Muted>
          ) : settings.isError ? (
            <Panel className="py-3">
              <ErrorNote message={t('settings.loadFailed')} />
              <Button className="mt-2" onClick={() => void settings.refetch()}>
                {t('settings.retry')}
              </Button>
            </Panel>
          ) : (
            SETTING_GROUPS.map((group) => {
              const items = settings.data.settings.filter((s) => s.group === group)
              if (items.length === 0) return null
              return (
                <Section key={group} title={t(`settings.group.${group}`)}>
                  <Panel>
                    <ul aria-label={t(`settings.group.${group}`)}>
                      {items.map((d) => (
                        <SettingRow key={d.key} d={d} onChanged={reload} />
                      ))}
                    </ul>
                  </Panel>
                </Section>
              )
            })
          )}
        </div>
      </main>
    </StepUpProvider>
  )
}
