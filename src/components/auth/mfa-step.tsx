import { useId, useRef, useState, type FormEvent } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { authApi, type SignInOutcome } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import { authenticateWithPasskey, usePasskeysSupported } from '~/lib/auth/webauthn'
import { setCsrfToken } from '~/lib/csrf'
import { AuthFrame, AuthHeading, ErrorNote, FormField } from './auth-frame'
import { TabList, panelId, tabId } from './tab-list'

type Method = 'totp' | 'passkey' | 'recovery'

/**
 * Second factor of a half-signed-in session (`pending_mfa`, FR-AUT-011): TOTP, passkey or recovery code. One fixed
 * failure message; `mfa_expired` (five tries or five minutes) sends the person back to sign-in.
 */
export function MfaStep({ onSignedIn, onRestart }: { onSignedIn: (outcome: SignInOutcome) => void; onRestart: () => void }) {
  const [method, setMethod] = useState<Method>('totp')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const action = useAction()
  const begun = useRef<Method | null>(null)
  const supported = usePasskeysSupported()
  const prefix = useId()
  const expired = action.error?.parsed.code === 'mfa_expired'

  const finish = (outcome: SignInOutcome) => {
    setCsrfToken(outcome.csrf)
    onSignedIn(outcome)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const r = await action.run(async () => {
      // A code step starts its challenge (the five-tries counter) on the server before the first code.
      if (begun.current !== method) {
        await authApi().mfaOptions(method)
        begun.current = method
      }
      return method === 'totp' ? authApi().mfaVerify({ method: 'totp', code }) : authApi().mfaVerify({ method: 'recovery', code: recovery })
    })
    if (r.ok) finish(r.value)
    else {
      setCode('')
      setRecovery('')
    }
  }

  async function signInWithPasskey() {
    const r = await action.run(async () => {
      const options = await authApi().mfaOptions('passkey')
      if (!('challenge' in options)) throw new Error('mfa_failed')
      return authApi().mfaVerify({ method: 'passkey', response: await authenticateWithPasskey(options) })
    })
    if (r.ok) finish(r.value)
  }

  async function restart() {
    await authApi().signOut().catch(() => undefined)
    setCsrfToken(undefined)
    onRestart()
  }

  const tabs: { key: Method; label: string }[] = [
    { key: 'totp', label: t('auth.mfa.totp') },
    { key: 'passkey', label: t('auth.mfa.passkey') },
    { key: 'recovery', label: t('auth.mfa.recovery') },
  ]

  return (
    <AuthFrame>
      <AuthHeading title={t('auth.mfa.title')} lead={t('auth.mfa.lead')} />
      <div className="mb-6">
        <TabList
          label={t('auth.mfa.methods')}
          tabs={tabs}
          value={method}
          onChange={(m) => {
            setMethod(m)
            action.clear()
          }}
          idPrefix={prefix}
        />
      </div>
      <div role="tabpanel" id={panelId(prefix, method)} aria-labelledby={tabId(prefix, method)}>
        {method === 'passkey' ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">{t('auth.mfa.passkeyLead')}</p>
            {!supported && <p role="alert" className="text-sm text-negative">{t('auth.passkey.unsupported')}</p>}
            <ErrorNote message={action.error?.message} />
            <Button variant="primary" size="lg" onClick={signInWithPasskey} disabled={action.busy || !supported || expired}>
              {action.busy ? t('auth.passkey.waiting') : t('auth.mfa.passkeyUse')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {method === 'totp' ? (
              <FormField label={t('auth.mfa.codeLabel')} hint={t('auth.mfa.codeHint')}>
                {(field) => (
                  <Input
                    {...field}
                    name="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    required
                    className="font-mono tracking-widest"
                  />
                )}
              </FormField>
            ) : (
              <FormField label={t('auth.mfa.recoveryLabel')} hint={t('auth.mfa.recoveryHint')}>
                {(field) => (
                  <Input
                    {...field}
                    name="recovery"
                    value={recovery}
                    onChange={(e) => setRecovery(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={32}
                    required
                    className="font-mono"
                  />
                )}
              </FormField>
            )}
            <ErrorNote message={action.error?.message} />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={action.busy || expired || (method === 'totp' ? code.replace(/\s/g, '').length < 6 : recovery.trim() === '')}
            >
              {action.busy ? t('auth.mfa.checking') : t('auth.mfa.submit')}
            </Button>
          </form>
        )}
      </div>
      <div className="mt-6">
        <Button variant={expired ? 'primary' : 'ghost'} onClick={restart}>
          {expired ? t('auth.mfa.restart') : t('auth.mfa.otherAccount')}
        </Button>
      </div>
    </AuthFrame>
  )
}
