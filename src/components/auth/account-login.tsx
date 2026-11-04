import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { authApi, type LoginPageInfo, type SignInOutcome } from '~/lib/auth/api'
import { useCountdown } from '~/lib/auth/countdown'
import { useAction } from '~/lib/auth/use-action'
import { authenticateWithPasskey, usePasskeysSupported } from '~/lib/auth/webauthn'
import { setCsrfToken } from '~/lib/csrf'
import { AuthFrame, AuthHeading, ErrorNote, FormField } from './auth-frame'
import { PasswordField } from './password-field'
import { LoginNotices } from './settings/site-notices'

/**
 * Account-mode sign-in (FR-AUT-006, 007, 026). Every failure shows the same fixed text; a throttle shows a countdown.
 * The next step (second factor, enrolment, forced change) is decided by the session state after `onSignedIn`.
 */
export function AccountLogin({ info, onSignedIn }: { info: LoginPageInfo; onSignedIn: (outcome: SignInOutcome) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [until, setUntil] = useState<number | null>(null)
  const action = useAction()
  const supported = usePasskeysSupported()
  const left = useCountdown(until)
  const throttled = left > 0
  const throttleShown = action.error?.parsed.code === 'auth_throttled'

  const startWait = (error?: { parsed: { code: string; retryAfterSeconds?: number } }) => {
    if (error?.parsed.code === 'auth_throttled') setUntil(Date.now() + (error.parsed.retryAfterSeconds ?? 5) * 1000)
  }

  const finish = (outcome: SignInOutcome) => {
    setCsrfToken(outcome.csrf)
    onSignedIn(outcome)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const r = await action.run(() => authApi().passwordSignIn({ username, password }))
    if (r.ok) finish(r.value)
    else {
      setPassword('')
      startWait(r.error)
    }
  }

  async function signInWithPasskey() {
    const r = await action.run(async () => {
      const { options } = await authApi().passkeyBegin()
      return authApi().passkeyFinish(await authenticateWithPasskey(options))
    })
    if (r.ok) finish(r.value)
    else startWait(r.error)
  }

  const showPasskey = info.passkeyEnabled && supported
  return (
    <AuthFrame>
      <AuthHeading title={t('auth.login.title', { site: info.siteName })} lead={t('auth.login.lead')} />
      <LoginNotices notice={info.notice} maintenance={info.maintenance} />
      <div className="flex flex-col gap-4">
        {info.passwordEnabled && (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <FormField label={t('auth.login.username')}>
              {(field) => (
                <Input
                  {...field}
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username webauthn"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={info.autofocus}
                  required
                />
              )}
            </FormField>
            <PasswordField label={t('auth.login.password')} name="password" value={password} onChange={setPassword} autoComplete="current-password" />
            {throttleShown ? (
              <div role="alert" className="text-sm text-negative">
                {t('auth.error.auth_throttled')}
              </div>
            ) : (
              <ErrorNote message={action.error?.message} />
            )}
            <Button type="submit" variant="primary" size="lg" disabled={action.busy || throttled}>
              {throttled ? t('auth.login.wait', { seconds: left }) : action.busy ? t('auth.login.submitting') : t('auth.login.submit')}
            </Button>
          </form>
        )}
        {showPasskey && (
          <>
            {info.passwordEnabled && (
              <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                {t('auth.login.or')}
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <Button size="lg" onClick={signInWithPasskey} disabled={action.busy || throttled}>
              <KeyRound size={16} aria-hidden />
              {t('auth.login.passkey')}
            </Button>
            {!info.passwordEnabled && <ErrorNote message={action.error?.message} />}
          </>
        )}
        {!info.passwordEnabled && !showPasskey && <p className="text-sm text-muted">{t('auth.login.noMethod')}</p>}
      </div>
    </AuthFrame>
  )
}
