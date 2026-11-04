import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '~/i18n'
import { FormField } from '~/components/auth/auth-frame'
import { PasswordField } from '~/components/auth/password-field'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { authApi } from '~/lib/auth/api'
import { EMPTY_PROFILE, profileToForm, tlsAtLeast, tlsDefaultFrom, toSaveInput, validateProfile, vaultView, type ProfileErrors, type ProfileForm } from '~/lib/auth/connections-logic'
import { useTargetTls } from '~/lib/auth/target-tls'
import { describeError } from '~/lib/auth/messages'
import { useAction } from '~/lib/auth/use-action'
import type { ProfileInfo } from '~/server/auth/types'
import { ModalForm } from './dialog-shell'
import { TlsSelect } from './typed-form'
import { useProfiles, useRefreshVault, useVaultStatus } from './use-vault'

const errorText = (e: 'required' | 'invalid' | undefined) => (e ? t(e === 'required' ? 'auth.conn.required' : 'auth.conn.invalid') : null)

type Outcome = { kind: 'ok' } | { kind: 'failed'; message: string }

function ProfileDialog({ profile, unlocked, onClose, onSaved }: { profile: ProfileInfo | null; unlocked: boolean; onClose: () => void; onSaved: (note: string) => void }) {
  const floor = useTargetTls()
  const [form, setForm] = useState<ProfileForm>(() => {
    if (!profile) return { ...EMPTY_PROFILE, tls: tlsDefaultFrom(floor) }
    const stored = profileToForm(profile)
    return { ...stored, tls: tlsAtLeast(stored.tls, floor) }
  })
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [testResult, setTestResult] = useState<Outcome | null>(null)
  const [canSaveAnyway, setCanSaveAnyway] = useState(false)
  const save = useAction()
  const test = useAction()
  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setTestResult(null)
  }
  const validate = () => {
    const found = validateProfile(form, unlocked)
    setErrors(found)
    return Object.keys(found).length === 0
  }

  async function submit(saveAnyway = false) {
    if (!validate()) return
    const r = await save.run(() => authApi().saveProfile(toSaveInput(form, unlocked, saveAnyway)))
    if (r.ok) onSaved(t(r.value.test === 'failed' ? 'auth.profile.savedUntested' : 'auth.profile.saved'))
    else if (r.error?.parsed.code === 'profile_test_failed') setCanSaveAnyway(true)
  }

  async function runTest() {
    if (!validate()) return
    setTestResult(null)
    try {
      const result = await test.run(() => authApi().testProfile(toSaveInput(form, unlocked)))
      if (!result.ok) return
      setTestResult(result.value.ok ? { kind: 'ok' } : { kind: 'failed', message: failedText(result.value.error.targetMessage) })
      if (!result.value.ok) setCanSaveAnyway(true)
    } catch (e) {
      setTestResult({ kind: 'failed', message: describeError(e).message })
    }
  }

  const failedText = (m?: string) => (m ? t('auth.profile.testFailedDetail', { message: m }) : t('auth.profile.testFailed'))
  const saveError = save.error
    ? save.error.parsed.code === 'profile_test_failed'
      ? failedText(save.error.parsed.targetMessage)
      : save.error.message
    : null

  return (
    <ModalForm
      wide
      title={t(profile ? 'auth.profile.editTitle' : 'auth.profile.newTitle')}
      lead={unlocked ? t('auth.profile.formLead') : t('auth.profile.formLeadLocked')}
      onClose={onClose}
      busy={save.busy}
      submitLabel={save.busy ? t('auth.profile.saving') : t('auth.profile.save')}
      error={saveError ?? test.error?.message ?? null}
      onSubmit={() => submit(false)}
      extra={
        <>
          {canSaveAnyway && (
            <Button size="lg" disabled={save.busy} onClick={() => void submit(true)}>
              {t('auth.profile.saveAnyway')}
            </Button>
          )}
          <Button size="lg" disabled={test.busy || save.busy} onClick={() => void runTest()}>
            {test.busy ? t('auth.profile.testing') : t('auth.profile.test')}
          </Button>
        </>
      }
    >
      {testResult && (
        <p role="status" className={testResult.kind === 'ok' ? 'text-sm text-positive' : 'text-sm text-negative'}>
          {testResult.kind === 'ok' ? t('auth.profile.testOk') : testResult.message}
        </p>
      )}
      <FormField label={t('auth.profile.name')} error={errorText(errors.name)}>
        {(f) => <Input {...f} name="profile-name" value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" autoFocus />}
      </FormField>
      <div className="grid gap-4 min-[480px]:grid-cols-[minmax(0,1fr)_96px]">
        <FormField label={t('auth.conn.host')} error={errorText(errors.host)}>
          {(f) => <Input {...f} name="profile-host" value={form.host} onChange={(e) => set('host', e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />}
        </FormField>
        <FormField label={t('auth.conn.port')} error={errorText(errors.port)}>
          {(f) => <Input {...f} name="profile-port" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} autoComplete="off" />}
        </FormField>
      </div>
      {unlocked ? (
        <>
          <FormField label={t('auth.conn.username')} error={errorText(errors.username)}>
            {(f) => <Input {...f} name="profile-user" value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />}
          </FormField>
          <div className="flex flex-col gap-2">
            <PasswordField
              label={t('auth.conn.password')}
              name="profile-password"
              value={form.password}
              onChange={(v) => set('password', v)}
              autoComplete="new-password"
              hint={form.id && form.keepPassword && form.password === '' ? t('auth.profile.passwordKept') : undefined}
            />
            {form.id && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.keepPassword} onChange={(e) => set('keepPassword', e.target.checked)} />
                {t('auth.profile.keepPassword')}
              </label>
            )}
          </div>
        </>
      ) : (
        <p className="rounded-[var(--radius-card)] bg-raised p-3 text-sm text-muted">{t('auth.profile.secretsLocked')}</p>
      )}
      <TlsSelect value={form.tls} onChange={(v) => set('tls', v)} />
      <div className="grid gap-4 min-[480px]:grid-cols-2">
        <FormField label={t('auth.conn.database')}>
          {(f) => <Input {...f} name="profile-database" value={form.database} onChange={(e) => set('database', e.target.value)} autoComplete="off" spellCheck={false} />}
        </FormField>
        <FormField label={t('auth.conn.collation')} error={errorText(errors.collation)}>
          {(f) => <Input {...f} name="profile-collation" value={form.collation} onChange={(e) => set('collation', e.target.value)} autoComplete="off" spellCheck={false} />}
        </FormField>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox checked={form.compress} onChange={(e) => set('compress', e.target.checked)} />
          {t('auth.profile.compress')}
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={form.activateRoles} onChange={(e) => set('activateRoles', e.target.checked)} />
          {t('auth.profile.activateRoles')}
        </label>
      </div>
      <details className="rounded-[var(--radius-card)] bg-raised px-3 py-2 text-sm" open={form.caPem !== '' || form.clientCertPem !== '' || Boolean(profile?.hasClientKey)}>
        <summary className="cursor-pointer select-none py-1 font-medium">{t('auth.profile.certs')}</summary>
        <div className="mt-3 flex flex-col gap-4 pb-2">
          <FormField label={t('auth.profile.ca')}>
            {(f) => <PemArea {...f} value={form.caPem} onChange={(v) => set('caPem', v)} />}
          </FormField>
          <FormField label={t('auth.profile.clientCert')} error={errors.clientPair ? t('auth.profile.clientPair') : null}>
            {(f) => <PemArea {...f} value={form.clientCertPem} onChange={(v) => set('clientCertPem', v)} />}
          </FormField>
          {unlocked ? (
            <FormField label={t('auth.profile.clientKey')} hint={form.keepClientKey && form.clientKeyPem === '' ? t('auth.profile.clientKeyKept') : undefined}>
              {(f) => <PemArea {...f} value={form.clientKeyPem} onChange={(v) => set('clientKeyPem', v)} secret />}
            </FormField>
          ) : (
            <p className="text-muted">{t('auth.profile.clientKeyLocked')}</p>
          )}
        </div>
      </details>
    </ModalForm>
  )
}

function PemArea({ value, onChange, secret, ...rest }: { value: string; onChange: (v: string) => void; secret?: boolean; id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  return (
    <textarea
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={4}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="none"
      placeholder={secret ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN CERTIFICATE-----'}
      className="w-full resize-y rounded-[var(--radius-control)] border border-control bg-surface p-3 font-mono text-xs text-ink placeholder:text-faint"
    />
  )
}

/** Saved profiles: list, create, edit, test, delete. The vault decides what can be edited (FR-AUT-021, 022). */
export function ProfilesManager() {
  const vault = useVaultStatus()
  const view = vault.data ? vaultView(vault.data) : null
  const profiles = useProfiles(view === 'unlocked' || view === 'locked')
  const refresh = useRefreshVault()
  const [editing, setEditing] = useState<ProfileInfo | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<ProfileInfo | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const remove = useAction()

  if (vault.isPending) return null
  if (view === 'disabled') return <p className="text-sm text-muted">{t('auth.profile.disabled')}</p>

  const unlocked = view === 'unlocked'
  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="profiles-heading" className="text-base font-semibold">
            {t('auth.profile.title')}
          </h2>
          <p className="text-sm text-muted">{t(view === 'absent' ? 'auth.profile.vaultAbsent' : view === 'locked' ? 'auth.profile.vaultLocked' : 'auth.profile.lead')}</p>
        </div>
        {view !== 'absent' && (
          <Button variant="primary" onClick={() => setEditing(null)}>
            <Plus size={14} aria-hidden />
            {t('auth.profile.new')}
          </Button>
        )}
      </div>
      {note && (
        <p role="status" className="text-sm text-positive">
          {note}
        </p>
      )}
      {profiles.data && profiles.data.length === 0 && view !== 'absent' && <p className="text-sm text-muted">{t('auth.profile.none')}</p>}
      {profiles.data && profiles.data.length > 0 && (
        <ul aria-label={t('auth.profile.listLabel')} className="flex flex-col gap-2">
          {profiles.data.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-[var(--radius-card)] bg-raised px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted">
                  {p.targetUser ? `${p.targetUser}@` : ''}
                  {p.host}:{p.port}
                  {p.hasClientKey ? ` · ${t('auth.profile.clientCertShort')}` : ''}
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label={t('auth.profile.editNamed', { name: p.name })} onClick={() => setEditing(p)}>
                <Pencil size={14} aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('auth.profile.deleteNamed', { name: p.name })} onClick={() => setDeleting(p)}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing !== undefined && (
        <ProfileDialog
          profile={editing}
          unlocked={unlocked}
          onClose={() => setEditing(undefined)}
          onSaved={(n) => {
            setEditing(undefined)
            setNote(n)
            void refresh()
          }}
        />
      )}
      {deleting && (
        <ModalForm
          danger
          title={t('auth.profile.deleteTitle', { name: deleting.name })}
          lead={t('auth.profile.deleteLead')}
          onClose={() => setDeleting(null)}
          busy={remove.busy}
          submitLabel={t('auth.profile.delete')}
          error={remove.error?.message ?? null}
          onSubmit={async () => {
            const r = await remove.run(() => authApi().deleteProfile(deleting.id))
            if (!r.ok) return
            setDeleting(null)
            setNote(t('auth.profile.deleted'))
            void refresh()
          }}
        />
      )}
    </section>
  )
}
