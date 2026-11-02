import { useEffect, useState } from 'react'
import { KeyRound, Lock, LockOpen } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { authApi } from '~/lib/auth/api'
import { formatLockIn, vaultView } from '~/lib/auth/connections-logic'
import { useAction } from '~/lib/auth/use-action'
import { ErrorNote } from '~/components/auth/auth-frame'
import { VaultFlowDialog, type VaultFlow } from './vault-dialogs'
import { useRefreshVault, useVaultStatus } from './use-vault'

/** Ticks once a second while a lock time is shown. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

/** Vault status and every action on it (FR-AUT-021): create, unlock, lock, change passphrase, recovery key, rotate. */
export function VaultPanel() {
  const status = useVaultStatus()
  const refresh = useRefreshVault()
  const [flow, setFlow] = useState<VaultFlow | null>(null)
  const lock = useAction()
  const data = status.data
  const now = useNow(Boolean(data?.unlocked))

  if (status.isPending) return <p className="text-sm text-muted">{t('auth.vault.loading')}</p>
  if (!data) return <p role="alert" className="text-sm text-negative">{t('auth.vault.loadFailed')}</p>

  const view = vaultView(data)
  const left = formatLockIn(data.autoLockAt, now)

  async function doLock() {
    const r = await lock.run(() => authApi().vaultLock())
    if (r.ok) await refresh()
  }

  const finished = async () => {
    setFlow(null)
    await refresh()
  }

  return (
    <section aria-labelledby="vault-heading" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted">{view === 'unlocked' ? <LockOpen size={18} aria-hidden /> : <Lock size={18} aria-hidden />}</span>
        <div className="min-w-0">
          <h2 id="vault-heading" className="text-base font-semibold">
            {t('auth.vault.title')}
          </h2>
          <p className="text-sm text-muted">{t('auth.vault.lead')}</p>
          <p className="mt-2 text-sm" data-testid="vault-status" aria-live="polite">
            {t(`auth.vault.status.${view}`)}
            {view === 'unlocked' && left ? <span className="text-muted"> · {t('auth.vault.autoLock', { time: left })}</span> : null}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {view === 'absent' && (
          <Button variant="primary" onClick={() => setFlow('create')}>
            <KeyRound size={14} aria-hidden />
            {t('auth.vault.create')}
          </Button>
        )}
        {view === 'locked' && (
          <>
            <Button variant="primary" onClick={() => setFlow('unlock')}>
              {t('auth.vault.unlock')}
            </Button>
            <Button onClick={() => setFlow('recover')}>{t('auth.vault.useRecoveryKey')}</Button>
          </>
        )}
        {view === 'unlocked' && (
          <>
            <Button onClick={() => void doLock()} disabled={lock.busy}>
              {t('auth.vault.lock')}
            </Button>
            <Button onClick={() => setFlow('change')}>{t('auth.vault.change')}</Button>
            <Button onClick={() => setFlow('regenerate')}>{t('auth.vault.regenerate')}</Button>
            <Button onClick={() => setFlow('rotate')}>{t('auth.vault.rotate')}</Button>
          </>
        )}
      </div>
      <ErrorNote message={lock.error?.message} />

      {flow && (
        <VaultFlowDialog
          key={flow}
          flow={flow}
          onClose={() => setFlow(null)}
          onDone={() => void finished()}
          onSwitch={(next) => setFlow(next)}
        />
      )}
    </section>
  )
}
