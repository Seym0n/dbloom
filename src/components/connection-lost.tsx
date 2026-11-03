import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { WifiOff } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { authApi } from '~/lib/auth/api'
import { isNetworkError, setConnectionLost, setSessionEnded, useConnectionLost } from '~/lib/session-state'
import { t } from '~/i18n'

/**
 * "Connection lost" (SCN-072): the server cannot be reached, which is not a 401, so the session stays. Retry asks the
 * server for the session; an answer clears the notice and refetches what failed, "no session" shows the ended dialog.
 */
export function ConnectionLost() {
  const lost = useConnectionLost()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  if (!lost) return null

  async function retry() {
    setBusy(true)
    try {
      const boot = await authApi().getAuthBoot()
      setConnectionLost(false)
      const session = boot.kind === 'account' || boot.kind === 'direct' ? boot.session : null
      if (!session) setSessionEnded(true)
      else await queryClient.refetchQueries({ predicate: (q) => q.state.status === 'error' })
    } catch (error) {
      if (!isNetworkError(error)) setConnectionLost(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="alert"
      className="fixed top-14 left-1/2 z-30 flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
    >
      <WifiOff size={16} className="shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t('connection.lost.title')}</p>
        <p className="text-xs text-muted">{t('connection.lost.body')}</p>
      </div>
      <Button variant="primary" disabled={busy} onClick={() => void retry()}>
        {busy ? t('connection.lost.retrying') : t('connection.lost.retry')}
      </Button>
    </div>
  )
}
