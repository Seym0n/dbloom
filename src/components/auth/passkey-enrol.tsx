import { useState, type FormEvent } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { CreationOptions, RegistrationResponse } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import { createPasskey, usePasskeysSupported } from '~/lib/auth/webauthn'
import { PASSKEY_NAME_MAX_CHARS } from '~/server/auth/types'
import { ErrorNote, FormField } from './auth-frame'

/** Registers a passkey: a name, then the browser's prompt; `options` and `verify` are the caller's server calls. */
export function PasskeyEnrol({
  options,
  verify,
  onDone,
  onCancel,
  defaultName = t('auth.passkey.defaultName'),
  disabled = false,
}: {
  options: () => Promise<CreationOptions>
  verify: (response: RegistrationResponse, name: string) => Promise<unknown>
  onDone: (result: unknown) => void
  onCancel?: () => void
  defaultName?: string
  /** The caller is not ready (for example a required field above is empty). */
  disabled?: boolean
}) {
  const [name, setName] = useState(defaultName)
  const action = useAction()
  const supported = usePasskeysSupported()

  async function submit(event: FormEvent) {
    event.preventDefault()
    const r = await action.run(async () => {
      const response = await createPasskey(await options())
      return verify(response, name.trim())
    })
    if (r.ok) onDone(r.value)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted">{t('auth.passkey.lead')}</p>
      {!supported && <p role="alert" className="text-sm text-negative">{t('auth.passkey.unsupported')}</p>}
      <FormField label={t('auth.passkey.name')} hint={t('auth.passkey.nameHint')}>
        {(field) => (
          <Input {...field} name="passkey-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={PASSKEY_NAME_MAX_CHARS} required />
        )}
      </FormField>
      <ErrorNote message={action.error?.message} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="lg" disabled={action.busy || disabled || !supported || name.trim() === ''}>
          {action.busy ? t('auth.passkey.waiting') : t('auth.passkey.add')}
        </Button>
        {onCancel && (
          <Button size="lg" onClick={onCancel}>
            {t('auth.cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}
