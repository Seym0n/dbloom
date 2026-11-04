import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Hourglass } from 'lucide-react'
import { t } from '~/i18n'
import { authApi } from '~/lib/auth/api'
import { SETTINGS_KEY } from './settings-page'

/**
 * One line for administrators on the other admin pages while a protected settings change waits for confirmation (SPEC/33
 * FR-APR-011). The server decides: a failed call or an answer for a non-administrator shows nothing. Render it for administrators only.
 */
export function PendingLink() {
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => authApi().getSettings(), retry: false })
  const count = settings.data?.settings.filter((s) => s.pending).length ?? 0
  if (count === 0) return null
  return (
    <aside aria-label={t('settings.pending.region')} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-border bg-[var(--pill-warning-bg)] px-4 py-3 text-sm text-[var(--pill-warning-ink)]">
      <Hourglass size={16} aria-hidden className="flex-none" />
      <span>{count === 1 ? t('settings.pending.banner.one') : t('settings.pending.banner', { count })}</span>
      <Link to="/admin/settings" className="font-medium underline">
        {t('settings.pending.link')}
      </Link>
    </aside>
  )
}
