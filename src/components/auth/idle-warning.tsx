import { useCallback, useEffect, useState } from 'react'
import { Dialog } from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { ErrorNote } from '~/components/auth/auth-frame'
import { authApi } from '~/lib/auth/api'
import { useCountdown } from '~/lib/auth/countdown'
import { formatRemaining, idlePhase, msUntilIdleWarning } from '~/lib/auth/idle-logic'
import { isNetworkError, isSessionEnded, setConnectionLost, setSessionEnded } from '~/lib/session-state'
import { t } from '~/i18n'

/** Re-check after an unreachable server. */
const RETRY_MS = 15_000

/** The server's current idle limit (the shell's own calls move it); `null` when the session is gone. */
async function readIdleExpiry(): Promise<number | null> {
  const boot = await authApi().getAuthBoot()
  return boot.kind === 'account' && boot.session ? boot.session.idleExpiresAt : null
}

/**
 * Idle warning (SEC-UIX-109): two minutes before the idle limit a dialog offers "Stay signed in". The limit is read
 * from the server when the warning is due, because work in the shell or another tab moves it. Without an answer the
 * session ends as before (the neutral "session ended" dialog). Reading the limit does not extend the session; the
 * button does, with an ordinary session-bound call.
 */
export function IdleWarning({ idleExpiresAt }: { idleExpiresAt: number }) {
  const [limit, setLimit] = useState(idleExpiresAt)
  const [warning, setWarning] = useState(false)
  const [round, setRound] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const seconds = useCountdown(warning ? limit : null)

  useEffect(() => setLimit(idleExpiresAt), [idleExpiresAt])

  const verify = useCallback(async (): Promise<'again' | 'done'> => {
    try {
      const fresh = await readIdleExpiry()
      if (fresh === null) {
        setWarning(false)
        setSessionEnded(true)
        return 'done'
      }
      setConnectionLost(false)
      const phase = idlePhase(fresh, Date.now())
      setLimit(fresh)
      setWarning(phase === 'warning')
      if (phase === 'expired') {
        setWarning(false)
        setSessionEnded(true)
      }
      // Same limit, still before the window (clock skew): look again when the timer is recomputed.
      if (phase === 'active') setRound((n) => n + 1)
      return 'done'
    } catch (error) {
      if (isNetworkError(error)) setConnectionLost(true)
      return 'again'
    }
  }, [])

  // One timer for the next moment that needs a look: the warning, then the limit itself.
  useEffect(() => {
    let timer: number | undefined
    let cancelled = false
    const run = async () => {
      if ((await verify()) === 'again' && !cancelled) timer = window.setTimeout(() => void run(), RETRY_MS)
    }
    const delay = warning ? Math.max(0, limit - Date.now()) + 500 : msUntilIdleWarning(limit, Date.now())
    timer = window.setTimeout(() => void run(), delay)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [limit, warning, round, verify])

  async function stay() {
    setBusy(true)
    setFailed(false)
    try {
      await authApi().listConnections()
      await verify()
    } catch (error) {
      if (isSessionEnded(error)) {
        setWarning(false)
        setSessionEnded(true)
      } else setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={warning} onClose={() => undefined} labelledBy="idle-warning-title" className="w-[min(420px,calc(100vw-32px))]">
      <div className="flex flex-col gap-4 p-6">
        <h2 id="idle-warning-title" className="text-base font-semibold">
          {t('session.idle.title')}
        </h2>
        <p className="text-sm text-muted" data-testid="idle-remaining">
          {t('session.idle.body', { time: formatRemaining(seconds) })}
        </p>
        <ErrorNote message={failed ? t('session.idle.failed') : null} />
        <div className="flex justify-end">
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void stay()}>
            {t('session.idle.stay')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
