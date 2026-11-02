import { useState, type FormEvent } from 'react'
import { Check } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { ErrorNote, FormField } from '~/components/auth/auth-frame'
import { PasskeyEnrol } from '~/components/auth/passkey-enrol'
import { PasswordField } from '~/components/auth/password-field'
import { ShownOnce } from '~/components/auth/shown-once'
import { TotpEnrol } from '~/components/auth/totp-enrol'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import { adminComplete } from '~/lib/auth/setup-steps'
import { DISPLAY_NAME_MAX_CHARS, RECOVERY_CODES_FILE_NAME, USERNAME_MAX_CHARS } from '~/server/auth/types'

export type AdminState = { username: string; displayName: string; passwordSet: boolean; passkey: boolean; totp: boolean; codes: string[] | null; codesSaved: boolean }

export const emptyAdmin: AdminState = { username: '', displayName: '', passwordSet: false, passkey: false, totp: false, codes: null, codesSaved: false }

/** Step 4 (FR-AUT-003): user name and password, then a passkey and/or an authenticator app, then recovery codes once. */
export function AdminStep({
  admin,
  onChange,
  minLength,
  onFinish,
  finishing,
  finishError,
  onBack,
}: {
  admin: AdminState
  onChange: (next: AdminState) => void
  minLength: number
  onFinish: () => void
  finishing: boolean
  finishError: string | null
  onBack: () => void
}) {
  const [username, setUsername] = useState(admin.username)
  const [displayName, setDisplayName] = useState(admin.displayName)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [factor, setFactor] = useState<'passkey' | 'totp' | null>(null)
  const [codesOpen, setCodesOpen] = useState(false)
  const save = useAction()
  const api = authApi()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password !== again) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    const r = await save.run(() => api.setupSaveStep({ step: 4, username: username.trim(), displayName: displayName.trim(), password }))
    if (r.ok) {
      setPassword('')
      setAgain('')
      onChange({ ...admin, username: username.trim(), displayName: displayName.trim(), passwordSet: true })
    }
  }

  const hasFactor = admin.passkey || admin.totp
  const ready = adminComplete({ passwordSet: admin.passwordSet, hasFactor, codesPending: admin.codes !== null, codesSaved: admin.codesSaved })

  if (!admin.passwordSet) {
    return (
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormField label={t('setup.admin.username')} hint={t('setup.admin.usernameHint')}>
          {(field) => (
            <Input {...field} name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={USERNAME_MAX_CHARS} required />
          )}
        </FormField>
        <FormField label={t('setup.admin.displayName')}>
          {(field) => <Input {...field} name="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={DISPLAY_NAME_MAX_CHARS} />}
        </FormField>
        <PasswordField
          label={t('setup.admin.password')}
          name="new-password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          meter
          minLength={minLength}
          username={username}
          hint={t('auth.password.policy', { count: minLength })}
        />
        <PasswordField label={t('auth.change.again')} name="again" value={again} onChange={setAgain} autoComplete="new-password" error={mismatch ? t('auth.password.mismatch') : null} />
        <ErrorNote message={save.error?.message} />
        <div className="flex flex-wrap justify-between gap-2">
          <Button size="lg" onClick={onBack}>
            {t('setup.back')}
          </Button>
          <Button type="submit" variant="primary" size="lg" disabled={save.busy || username.trim() === '' || password === ''}>
            {save.busy ? t('setup.saving') : t('setup.admin.savePassword')}
          </Button>
        </div>
      </form>
    )
  }

  if (admin.codes && codesOpen) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('auth.codes.title')}</h2>
        <p className="text-sm text-muted">{t('auth.codes.lead')}</p>
        <ShownOnce lines={admin.codes} fileName={RECOVERY_CODES_FILE_NAME} label={t('auth.codes.label')} saved={admin.codesSaved} onSavedChange={(saved) => onChange({ ...admin, codesSaved: saved })} />
        <div className="flex justify-end">
          <Button variant="primary" size="lg" disabled={!admin.codesSaved} onClick={() => setCodesOpen(false)}>
            {t('auth.codes.continue')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-2 text-sm" aria-label={t('setup.admin.progress')}>
        <Done label={t('setup.admin.passwordDone', { name: admin.username })} />
        {admin.passkey && <Done label={t('setup.admin.passkeyDone')} />}
        {admin.totp && <Done label={t('setup.admin.totpDone')} />}
        {admin.codes && admin.codesSaved && <Done label={t('setup.admin.codesDone')} />}
      </ul>
      {factor === null ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t(hasFactor ? 'setup.admin.moreFactors' : 'setup.admin.factorLead')}</p>
          <div className="flex flex-wrap gap-2">
            {!admin.passkey && <Button size="lg" onClick={() => setFactor('passkey')}>{t('setup.admin.addPasskey')}</Button>}
            {!admin.totp && <Button size="lg" onClick={() => setFactor('totp')}>{t('setup.admin.addTotp')}</Button>}
          </div>
        </div>
      ) : factor === 'passkey' ? (
        <PasskeyEnrol
          options={() => api.setupPasskeyOptions()}
          verify={(response, name) => api.setupPasskeyVerify(response, name)}
          onDone={() => {
            onChange({ ...admin, passkey: true })
            setFactor(null)
          }}
          onCancel={() => setFactor(null)}
        />
      ) : (
        <TotpEnrol
          start={() => api.setupTotpStart()}
          confirm={(code) => api.setupTotpVerify(code)}
          onDone={(codes) => {
            onChange({ ...admin, totp: true, codes: codes ?? admin.codes, codesSaved: false })
            if (codes) setCodesOpen(true)
            setFactor(null)
          }}
          onCancel={() => setFactor(null)}
        />
      )}
      {factor === null && (
        <>
          <ErrorNote message={finishError} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="primary" size="lg" onClick={onFinish} disabled={!ready || finishing}>
              {finishing ? t('setup.saving') : t('setup.finish')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function Done({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2">
      <Check size={16} className="text-positive" aria-hidden />
      {label}
    </li>
  )
}
