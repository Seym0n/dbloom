import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ShieldAlert } from 'lucide-react'
import { t } from '~/i18n'
import { authApi } from '~/lib/auth/api'
import { EXPOSURE_KEY } from './exposure-page'

/**
 * Persistent, non-blocking banner for administrators while unacknowledged exposure warnings exist on a non-loopback
 * install (SPEC/31 FR-AEX-004). The server decides whether it is raised; the component only asks, so a failed call or an
 * answer for a non-administrator shows nothing. Render it for administrators only.
 */
export function ExposureBanner() {
  const exposure = useQuery({ queryKey: EXPOSURE_KEY, queryFn: () => authApi().getExposure(), retry: false })
  const banner = exposure.data?.banner
  if (!banner?.raised) return null
  return (
    <aside aria-label={t('exposure.title')} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-border bg-[var(--pill-warning-bg)] px-4 py-3 text-sm text-[var(--pill-warning-ink)]">
      <ShieldAlert size={16} aria-hidden className="flex-none" />
      <span>{banner.count === 1 ? t('exposure.banner.one') : t('exposure.banner', { count: banner.count })}</span>
      <Link to="/admin/exposure" className="font-medium underline">
        {t('exposure.banner.link')}
      </Link>
    </aside>
  )
}
