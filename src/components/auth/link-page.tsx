import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { authApi, type NewCredential } from '~/lib/auth/api'
import { takeFragmentToken } from '~/lib/auth/fragment'
import { useAction } from '~/lib/auth/use-action'
import { DISPLAY_NAME_MAX_CHARS, PASSWORD_MIN_LENGTH_DEFAULT, USERNAME_MAX_CHARS } from '~/server/auth/types'
import { AuthFrame, AuthHeading, ErrorNote, FormField } from './auth-frame'
import { PasskeyEnrol } from './passkey-enrol'
import { PasswordField } from './password-field'
import { TabList, panelId, tabId } from './tab-list'

type Credential = 'password' | 'passkey'

/**
 * `/invite` and `/recover` (FR-AUT-015, 016). The token comes from the URL fragment and is removed from the address
 * bar and history entry on first render; it lives only in this component's state. An invite also asks for a user name.
 */
export function LinkPage({ kind }: { kind: 'invite' | 'recovery' }) {
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const read = useRef(false)
  useEffect(() => {
    if (read.current) return
    read.current = true
    setToken(takeFragmentToken() ?? null)
  }, [])

  const [done, setDone] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [credential, setCredential] = useState<Credential>('password')
  const action = useAction()
  const prefix = useId()
  const invite = kind === 'invite'
  const key = invite ? 'invite' : 'recover'

  if (token === undefined) return <AuthFrame />
  if (token === null) {
    return (
      <AuthFrame>
        <AuthHeading title={t(invite ? 'auth.invite.invalidTitle' : 'auth.recover.invalidTitle')} lead={t(invite ? 'auth.error.invite_invalid' : 'auth.error.recovery_invalid')} />
        <Link to="/" className="text-sm font-medium text-accent underline underline-offset-2">
          {t('auth.link.toSignIn')}
        </Link>
      </AuthFrame>
    )
  }
  if (done) {
    return (
      <AuthFrame>
        <AuthHeading title={t(invite ? 'auth.invite.doneTitle' : 'auth.recover.doneTitle')} lead={t(invite ? 'auth.invite.doneLead' : 'auth.recover.doneLead')} />
        <Link
          to="/"
          className="press inline-flex h-10 items-center justify-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-[var(--primary-ink)] hover:opacity-90"
        >
          {t('auth.link.toSignIn')}
        </Link>
      </AuthFrame>
    )
  }

  const redeem = (cred: NewCredential) =>
    invite
      ? authApi().redeemInvite({ token, username, ...(displayName.trim() ? { displayName: displayName.trim() } : {}), credential: cred })
      : authApi().redeemRecovery({ token, credential: cred })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password !== again) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    const r = await action.run(() => redeem({ kind: 'password', password }))
    if (r.ok) setDone(true)
    else {
      setPassword('')
      setAgain('')
    }
  }

  const usernameField = invite && (
    <>
      <FormField label={t('auth.invite.username')} hint={t('auth.invite.usernameHint')}>
        {(field) => (
          <Input
            {...field}
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={USERNAME_MAX_CHARS}
            required
          />
        )}
      </FormField>
      <FormField label={t('auth.invite.displayName')}>
        {(field) => (
          <Input {...field} name="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={DISPLAY_NAME_MAX_CHARS} />
        )}
      </FormField>
    </>
  )

  return (
    <AuthFrame>
      <AuthHeading title={t(invite ? 'auth.invite.title' : 'auth.recover.title')} lead={t(invite ? 'auth.invite.lead' : 'auth.recover.lead')} />
      <div className="flex flex-col gap-4">
        {usernameField}
        <TabList
          label={t('auth.link.credential')}
          tabs={[
            { key: 'password', label: t('auth.link.password') },
            { key: 'passkey', label: t('auth.link.passkey') },
          ]}
          value={credential}
          onChange={(c) => {
            setCredential(c)
            action.clear()
          }}
          idPrefix={prefix}
        />
        <div role="tabpanel" id={panelId(prefix, credential)} aria-labelledby={tabId(prefix, credential)}>
          {credential === 'password' ? (
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate data-testid={`${key}-password-form`}>
              <PasswordField
                label={t('auth.link.newPassword')}
                name="new-password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                meter
                minLength={PASSWORD_MIN_LENGTH_DEFAULT}
                {...(invite && username ? { username } : {})}
                hint={t('auth.password.policy', { count: PASSWORD_MIN_LENGTH_DEFAULT })}
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
              <Button type="submit" variant="primary" size="lg" disabled={action.busy || password === '' || (invite && username.trim() === '')}>
                {action.busy ? t('auth.link.saving') : t(invite ? 'auth.invite.submit' : 'auth.recover.submit')}
              </Button>
            </form>
          ) : (
            <PasskeyEnrol
              options={() => (invite ? authApi().invitePasskeyOptions({ token, username }) : authApi().recoveryPasskeyOptions(token))}
              verify={(response, name) => redeem({ kind: 'passkey', response, name })}
              onDone={() => setDone(true)}
              disabled={invite && username.trim() === ''}
            />
          )}
        </div>
      </div>
    </AuthFrame>
  )
}
