import { useQuery } from '@tanstack/react-query'
import { Info, Wrench } from 'lucide-react'
import { t } from '~/i18n'
import { authApi } from '~/lib/auth/api'
import type { MaintenanceView } from '~/server/auth/types'

export const SITE_NOTICES_KEY = ['auth', 'site-notices'] as const
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Maintenance state as text: for administrators (told, exempt), for users (refused), for the sign-in page. */
export function MaintenanceNotice({ maintenance, audience }: { maintenance: MaintenanceView | undefined; audience: 'admin' | 'user' | 'sign-in' }) {
  if (!maintenance?.active) return null
  const text = audience === 'admin' ? t('settings.maintenance.admin') : audience === 'sign-in' ? t('settings.maintenance.sign') : t('settings.maintenance.user')
  return (
    <aside aria-label={t('settings.maintenance.region')} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-border bg-[var(--pill-warning-bg)] px-4 py-3 text-sm text-[var(--pill-warning-ink)]">
      <Wrench size={16} aria-hidden className="flex-none" />
      <span>{text}</span>
      {maintenance.endsAt !== null && <span>{t('settings.maintenance.ends', { time: when(maintenance.endsAt) })}</span>}
    </aside>
  )
}

/** The administrators' banner for signed-in users (ST-219). Plain text only: React renders it as a text node. */
export function InfoBanner({ text }: { text: string | undefined }) {
  if (!text) return null
  return (
    <aside aria-label={t('settings.banner.region')} className="flex items-start gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 text-sm text-ink">
      <Info size={16} aria-hidden className="mt-0.5 flex-none text-muted" />
      <span className="whitespace-pre-line break-words">{text}</span>
    </aside>
  )
}

/** Notice above the sign-in form (ST-216), then the maintenance line. */
export function LoginNotices({ notice, maintenance }: { notice: string | undefined; maintenance: MaintenanceView | undefined }) {
  if (!notice && !maintenance?.active) return null
  return (
    <div className="mb-4 flex flex-col gap-3">
      {notice && (
        <p role="note" aria-label={t('settings.notice.region')} className="whitespace-pre-line break-words rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 text-sm text-ink">
          {notice}
        </p>
      )}
      <MaintenanceNotice maintenance={maintenance} audience="sign-in" />
    </div>
  )
}

/** Banner and maintenance line of the signed-in session, for pages that do not get the session handed down. Administrator pages only. */
export function SiteNotices() {
  const boot = useQuery({
    queryKey: SITE_NOTICES_KEY,
    queryFn: async () => {
      const b = await authApi().getAuthBoot()
      return b.kind === 'account' && b.session ? { banner: b.session.banner, maintenance: b.session.maintenance } : null
    },
    retry: false,
  })
  if (!boot.data) return null
  return (
    <>
      <MaintenanceNotice maintenance={boot.data.maintenance} audience="admin" />
      <InfoBanner text={boot.data.banner} />
    </>
  )
}
