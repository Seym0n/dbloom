import { useId, useState, type FormEvent } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { authApi, type SignInOutcome } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import { setCsrfToken } from '~/lib/csrf'
import { PASSWORD_MIN_LENGTH_DEFAULT } from '~/server/auth/types'
import { ErrorNote } from './auth-frame'
import { PasswordField } from './password-field'

/**
 * Change my password (FR-AUT-005, 017). `required` is the `must_change` state: no Escape, no backdrop close, a sign-out
 * button instead of cancel. Wave 2 opens it from account security without `required`.
 */
export function ChangePasswordDialog({
  open,
  required = false,
  username,
  minLength = PASSWORD_MIN_LENGTH_DEFAULT,
  onClose,
  onChanged,
  onSignOut,
}: {
  open: boolean
  required?: boolean
  username?: string
  minLength?: number
  onClose: () => void
  onChanged: (outcome?: Partial<SignInOutcome>) => void
  onSignOut?: () => void
}) {
  const titleId = useId()
  return (
    <Dialog open={open} onClose={required ? () => undefined : onClose} labelledBy={titleId}>
      <ChangePasswordForm
        titleId={titleId}
        required={required}
        {...(username ? { username } : {})}
        minLength={minLength}
        onClose={onClose}
        onChanged={onChanged}
        {...(onSignOut ? { onSignOut } : {})}
      />
    </Dialog>
  )
}

function ChangePasswordForm({
  titleId,
  required,
  username,
  minLength,
  onClose,
  onChanged,
  onSignOut,
}: {
  titleId: string
  required: boolean
  username?: string
  minLength: number
  onClose: () => void
  onChanged: (outcome?: Partial<SignInOutcome>) => void
  onSignOut?: () => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const action = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (next !== again) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    const r = await action.run(() => authApi().changePassword({ currentPassword: current, newPassword: next }))
    if (!r.ok) return
    const result = r.value || undefined
    if (result?.csrf) setCsrfToken(result.csrf)
    onChanged(result)
  }

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6" noValidate>
      <div>
        <h2 id={titleId} className="mb-1 text-base font-semibold">
          {t(required ? 'auth.change.titleRequired' : 'auth.change.title')}
        </h2>
        <p className="text-sm text-muted">{t(required ? 'auth.change.leadRequired' : 'auth.change.lead')}</p>
      </div>
      <PasswordField label={t('auth.change.current')} name="current" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      <PasswordField
        label={t('auth.change.new')}
        name="new"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        meter
        minLength={minLength}
        {...(username ? { username } : {})}
        hint={t('auth.password.policy', { count: minLength })}
      />
      <PasswordField
        label={t('auth.change.again')}
        name="again"
        value={again}
        onChange={setAgain}
        autoComplete="new-password"
        error={mismatch ? t('auth.password.mismatch') : null}
      />
      <ErrorNote message={action.error?.message} />
      <div className="flex flex-wrap justify-end gap-2">
        {required ? (
          onSignOut && (
            <Button size="lg" onClick={onSignOut}>
              {t('auth.signOut')}
            </Button>
          )
        ) : (
          <Button size="lg" onClick={onClose}>
            {t('auth.cancel')}
          </Button>
        )}
        <Button type="submit" variant="primary" size="lg" disabled={action.busy || current === '' || next === ''}>
          {action.busy ? t('auth.change.saving') : t('auth.change.submit')}
        </Button>
      </div>
    </form>
  )
}
