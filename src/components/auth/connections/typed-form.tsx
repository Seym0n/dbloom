import { useState, type FormEvent } from 'react'
import { t } from '~/i18n'
import { ErrorNote, FormField } from '~/components/auth/auth-frame'
import { PasswordField } from '~/components/auth/password-field'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { EMPTY_TYPED, splitHostPort, tlsDefaultFrom, tlsModesFrom, toOpenInput, validateTyped, type TlsMode, type TypedErrors, type TypedForm } from '~/lib/auth/connections-logic'
import { useTargetTls } from '~/lib/auth/target-tls'
import type { ShownError } from '~/lib/auth/messages'
import type { OpenConnectionInput } from '~/server/auth/types'

export const tlsLabel = (m: TlsMode) => t(`auth.conn.tls.${m}`)

export function TlsSelect({ value, onChange, label = t('auth.conn.tls') }: { value: TlsMode; onChange: (v: TlsMode) => void; label?: string }) {
  const floor = useTargetTls()
  return (
    <FormField label={label}>
      {(field) => (
        <Select {...field} value={value} onChange={(e) => onChange(e.target.value as TlsMode)}>
          {tlsModesFrom(floor).map((m) => (
            <option key={m} value={m}>
              {tlsLabel(m)}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  )
}

const errorText = (e: 'required' | 'invalid' | undefined) => (e ? t(e === 'required' ? 'auth.conn.required' : 'auth.conn.invalid') : null)

/** The failure under the form: policy refusals have their own text, any other failure is the one generic message. */
export function connectErrorMessage(error: ShownError | null): string | null {
  if (!error) return null
  const code = error.parsed.code
  if (code === 'unknown' || code === 'profile_test_failed') return t('auth.conn.failed')
  return error.message
}

/** Typed credentials (FR-AUT-018): host, port, user, password, TLS, optional database and collation. */
export function TypedConnectForm({
  busy,
  error,
  onSubmit,
  submitLabel,
}: {
  busy: boolean
  error: ShownError | null
  onSubmit: (input: OpenConnectionInput) => void | Promise<unknown>
  submitLabel?: string
}) {
  const floor = useTargetTls()
  const [form, setForm] = useState<TypedForm>(() => ({ ...EMPTY_TYPED, tls: tlsDefaultFrom(floor) }))
  const [errors, setErrors] = useState<TypedErrors>({})
  const set = <K extends keyof TypedForm>(key: K, value: TypedForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit(event: FormEvent) {
    event.preventDefault()
    const found = validateTyped(form)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    void onSubmit(toOpenInput(form))
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={t('auth.conn.tabTyped')}>
      <div className="grid gap-4 min-[480px]:grid-cols-[minmax(0,1fr)_96px]">
        <FormField label={t('auth.conn.host')} error={errorText(errors.host)}>
          {(field) => (
            <Input
              {...field}
              name="host"
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
              onBlur={() => {
                const { host, port } = splitHostPort(form.host)
                if (port) setForm((f) => ({ ...f, host, port }))
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="db.example.org"
            />
          )}
        </FormField>
        <FormField label={t('auth.conn.port')} error={errorText(errors.port)}>
          {(field) => <Input {...field} name="port" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} autoComplete="off" />}
        </FormField>
      </div>
      <FormField label={t('auth.conn.username')} error={errorText(errors.username)}>
        {(field) => <Input {...field} name="db-user" value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />}
      </FormField>
      <PasswordField label={t('auth.conn.password')} name="db-password" value={form.password} onChange={(v) => set('password', v)} autoComplete="current-password" />
      <TlsSelect value={form.tls} onChange={(v) => set('tls', v)} />
      <details className="rounded-[var(--radius-card)] bg-raised px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none py-1 font-medium">{t('auth.conn.more')}</summary>
        <div className="mt-3 flex flex-col gap-4 pb-2">
          <FormField label={t('auth.conn.database')} error={errorText(errors.database)}>
            {(field) => <Input {...field} name="database" value={form.database} onChange={(e) => set('database', e.target.value)} autoComplete="off" spellCheck={false} />}
          </FormField>
          <FormField label={t('auth.conn.collation')} hint={t('auth.conn.collationHint')} error={errorText(errors.collation)}>
            {(field) => (
              <Input {...field} name="collation" value={form.collation} onChange={(e) => set('collation', e.target.value)} autoComplete="off" spellCheck={false} placeholder="utf8mb4_0900_ai_ci" />
            )}
          </FormField>
        </div>
      </details>
      <ErrorNote message={connectErrorMessage(error)} />
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? t('auth.conn.connecting') : (submitLabel ?? t('auth.conn.connect'))}
      </Button>
    </form>
  )
}
