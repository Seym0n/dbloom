import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LoginForm, type LoginDefaults } from '~/components/login-form'
import { setSessionEnded, useSessionEnded } from '~/lib/session-state'
import { getSessionInfo } from '~/server/session.functions'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'

/**
 * One neutral dialog for every invalid session (G10). Typed work stays in page memory behind it (G3).
 * `onSignedIn` receives the new target so the shell can drop work that belonged to someone else.
 */
export function SessionEndedDialog({
  defaults,
  onSignedIn,
  onAccountSignIn,
}: {
  defaults: LoginDefaults
  onSignedIn: (target: { host: string; port: number; username: string }) => void
  /** Account mode: no target form here; the button leads to the account sign-in (the sign-out clears the dead session). */
  onAccountSignIn?: () => void
}) {
  const ended = useSessionEnded()
  const ref = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (ended && !dialog.open) dialog.showModal()
    if (!ended && dialog.open) dialog.close()
  }, [ended])

  return (
    <dialog
      ref={ref}
      aria-labelledby="session-ended-title"
      onCancel={(e) => e.preventDefault()}
      className="m-auto w-[min(420px,calc(100vw-32px))] rounded-[var(--radius-sheet)] border border-border bg-surface p-6 text-ink shadow-lg"
    >
      <h2 id="session-ended-title" className="mb-2 text-base font-semibold">
        {t('session.ended.title')}
      </h2>
      <p className="mb-6 text-sm text-muted">{t('session.ended.body')}</p>
      {ended && onAccountSignIn && (
        <Button variant="primary" size="lg" className="w-full" onClick={() => {
          setSessionEnded(false)
          queryClient.clear()
          onAccountSignIn()
        }}>
          {t('session.ended.signIn')}
        </Button>
      )}
      {ended && !onAccountSignIn && (
        <LoginForm
          defaults={defaults}
          onSuccess={async () => {
            const info = await getSessionInfo()
            if (info && 'target' in info) onSignedIn(info.target)
            setSessionEnded(false)
            await queryClient.invalidateQueries()
          }}
        />
      )}
    </dialog>
  )
}
