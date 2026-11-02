import { useId, type ReactNode } from 'react'
import { t } from '~/i18n'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { FormField } from '~/components/auth/auth-frame'
import { type SiteErrors } from '~/lib/auth/setup-site'
import { daysToMs, hoursToMs, minutesToMs, msToDays, msToHours, msToMinutes } from '~/lib/auth/setup-steps'
import { FACTOR_KINDS, PRIMARY_CREDENTIALS, ROLES, SESSION_LIMIT_ACTIONS, MFA_SCOPES, type SetupEnvStatus, type SetupSiteValues } from '~/server/auth/types'
import { cn } from '~/lib/utils'

const errorText = (e: SiteErrors[keyof SiteErrors]) => (e === 'required' ? t('setup.site.err.required') : e === 'range' ? t('setup.site.err.range') : e === 'pick' ? t('setup.site.err.pick') : null)

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 border-t border-rule pt-5 first:border-t-0 first:pt-0">
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  )
}

function Check({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <Checkbox id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" aria-describedby={hint ? `${id}-h` : undefined} />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {hint && (
          <span id={`${id}-h`} className="text-xs text-muted">
            {hint}
          </span>
        )}
      </div>
    </div>
  )
}

function CheckGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  error,
  labelOf,
}: {
  legend: string
  options: readonly T[]
  value: readonly T[]
  onChange: (v: T[]) => void
  error?: string | null
  labelOf: (option: T) => string
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {options.map((option) => (
          <Check
            key={option}
            label={labelOf(option)}
            checked={value.includes(option)}
            onChange={(on) => onChange(on ? [...value, option] : value.filter((o) => o !== option))}
          />
        ))}
      </div>
      {error && <p className="text-xs text-negative">{error}</p>}
    </fieldset>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint,
  error,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  hint?: string
  error?: string | null
}) {
  return (
    <FormField label={unit ? `${label} (${unit})` : label} {...(hint ? { hint } : {})} {...(error ? { error } : {})}>
      {(field) => (
        <Input
          {...field}
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          className="max-w-40"
        />
      )}
    </FormField>
  )
}

const scopeLabel = (s: (typeof MFA_SCOPES)[number]) => t(`setup.site.scope.${s}`)

/** Step 3 form (FR-AUT-003). Direct mode shows only the settings that apply without DBLoom accounts. */
export function SiteForm({
  values,
  onChange,
  mode,
  errors,
}: {
  values: SetupSiteValues
  onChange: (v: SetupSiteValues) => void
  mode: 'account' | 'direct'
  errors: SiteErrors
}) {
  const set = <K extends keyof SetupSiteValues>(key: K, value: SetupSiteValues[K]) => onChange({ ...values, [key]: value })
  const account = mode === 'account'
  return (
    <div className="flex flex-col gap-5">
      <Section title={t('setup.site.general')}>
        <FormField label={t('setup.site.name')} hint={t('setup.site.nameHint')} error={errorText(errors.siteName)}>
          {(field) => <Input {...field} value={values.siteName} onChange={(e) => set('siteName', e.target.value)} maxLength={80} autoComplete="off" />}
        </FormField>
        <Check label={t('setup.site.autofocus')} checked={values.loginAutofocus} onChange={(v) => set('loginAutofocus', v)} />
      </Section>

      {account && (
        <>
          <Section title={t('setup.site.twoFactor')}>
            <FormField label={t('setup.site.scope')} hint={t('setup.site.scopeHint')} error={errorText(errors.mfaScope)}>
              {(field) => (
                <Select {...field} value={values.mfaScope} onChange={(e) => set('mfaScope', e.target.value as SetupSiteValues['mfaScope'])} className="max-w-72">
                  {MFA_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {scopeLabel(s)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            {values.mfaScope === 'roles' && (
              <CheckGroup
                legend={t('setup.site.scopeRoles')}
                options={ROLES}
                value={values.mfaRoles}
                onChange={(v) => set('mfaRoles', v)}
                error={errorText(errors.mfaRoles)}
                labelOf={(r) => t(`auth.role.${r}`)}
              />
            )}
            <CheckGroup
              legend={t('setup.site.factors')}
              options={FACTOR_KINDS}
              value={values.mfaFactors}
              onChange={(v) => set('mfaFactors', v)}
              error={errorText(errors.mfaFactors)}
              labelOf={(f) => t(`setup.site.factor.${f}`)}
            />
            <NumberField
              label={t('setup.site.grace')}
              unit={t('setup.unit.days')}
              hint={t('setup.site.graceHint')}
              value={msToDays(values.mfaGraceMs)}
              onChange={(v) => set('mfaGraceMs', daysToMs(v))}
              min={0}
              max={7}
              step={0.5}
              error={errorText(errors.mfaGraceMs)}
            />
          </Section>

          <Section title={t('setup.site.signIn')}>
            <CheckGroup
              legend={t('setup.site.primary')}
              options={PRIMARY_CREDENTIALS}
              value={values.primaryCredentials}
              onChange={(v) => set('primaryCredentials', v)}
              error={errorText(errors.primaryCredentials)}
              labelOf={(c) => t(`setup.site.primary.${c}`)}
            />
          </Section>

          <Section title={t('setup.site.passwords')}>
            <NumberField
              label={t('setup.site.minLength')}
              unit={t('setup.unit.characters')}
              value={values.passwordMinLength}
              onChange={(v) => set('passwordMinLength', v)}
              min={10}
              max={64}
              error={errorText(errors.passwordMinLength)}
            />
            <Check label={t('setup.site.breached')} hint={t('setup.site.breachedHint')} checked={values.breachedCheck} onChange={(v) => set('breachedCheck', v)} />
          </Section>

          <Section title={t('setup.site.sessions')}>
            <NumberField label={t('setup.site.perUser')} value={values.sessionsPerUser} onChange={(v) => set('sessionsPerUser', v)} min={1} max={20} error={errorText(errors.sessionsPerUser)} />
            <FormField label={t('setup.site.atLimit')}>
              {(field) => (
                <Select {...field} value={values.sessionsAtLimit} onChange={(e) => set('sessionsAtLimit', e.target.value as SetupSiteValues['sessionsAtLimit'])} className="max-w-72">
                  {SESSION_LIMIT_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {t(`setup.site.atLimit.${a}`)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </Section>

          <Section title={t('setup.site.links')}>
            <div className="grid gap-4 min-[480px]:grid-cols-3">
              <NumberField label={t('setup.site.tempPassword')} unit={t('setup.unit.hours')} value={msToHours(values.tempPasswordMs)} onChange={(v) => set('tempPasswordMs', hoursToMs(v))} min={1} step={1} error={errorText(errors.tempPasswordMs)} />
              <NumberField label={t('setup.site.invite')} unit={t('setup.unit.hours')} value={msToHours(values.inviteLifetimeMs)} onChange={(v) => set('inviteLifetimeMs', hoursToMs(v))} min={1} step={1} error={errorText(errors.inviteLifetimeMs)} />
              <NumberField label={t('setup.site.recovery')} unit={t('setup.unit.hours')} value={msToHours(values.recoveryLinkLifetimeMs)} onChange={(v) => set('recoveryLinkLifetimeMs', hoursToMs(v))} min={1} step={1} error={errorText(errors.recoveryLinkLifetimeMs)} />
            </div>
          </Section>

          <Section title={t('setup.site.vault')}>
            <div className="grid gap-4 min-[480px]:grid-cols-2">
              <NumberField label={t('setup.site.passphraseMin')} unit={t('setup.unit.characters')} value={values.vaultPassphraseMin} onChange={(v) => set('vaultPassphraseMin', v)} min={12} max={256} error={errorText(errors.vaultPassphraseMin)} />
              <NumberField label={t('setup.site.autoLock')} unit={t('setup.unit.minutes')} value={msToMinutes(values.vaultAutoLockMs)} onChange={(v) => set('vaultAutoLockMs', minutesToMs(v))} min={1} error={errorText(errors.vaultAutoLockMs)} />
            </div>
            <Check label={t('setup.site.profiles')} hint={t('setup.site.profilesHint')} checked={values.personalProfiles} onChange={(v) => set('personalProfiles', v)} />
          </Section>
        </>
      )}

      <Section title={t('setup.site.targets')}>
        <Check label={t('setup.site.denyRoot')} hint={t('setup.site.denyRootHint')} checked={values.denyRootTarget} onChange={(v) => set('denyRootTarget', v)} />
        <Check label={t('setup.site.emptyPassword')} hint={t('setup.site.emptyPasswordHint')} checked={values.allowEmptyTargetPassword} onChange={(v) => set('allowEmptyTargetPassword', v)} />
      </Section>
    </div>
  )
}

/** Read-only `.env` status of step 3 with the public-origin and administration-network checks (UI-TGT-002, Q6). */
export function EnvStatus({ env, acknowledged, onAcknowledge }: { env: SetupEnvStatus; acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const originWarn = env.publicOriginMatchesBrowser === false || env.publicOrigin === null
  const networkWarn = env.adminNetworks.length > 0 && !env.browserInAdminNetworks
  const rows: { label: string; value: string; warn?: string }[] = [
    { label: t('setup.env.store'), value: t('setup.env.stateful') },
    {
      label: t('setup.env.origin'),
      value: env.publicOrigin ?? t('setup.env.notSet'),
      ...(originWarn ? { warn: env.publicOrigin === null ? t('setup.env.originMissing') : t('setup.env.originMismatch') } : {}),
    },
    { label: t('setup.env.key'), value: env.secretKeyPresent ? t('setup.env.present') : t('setup.env.missing'), ...(env.secretKeyPresent ? {} : { warn: t('setup.env.keyMissing') }) },
    { label: t('setup.env.networks'), value: env.adminNetworks.length > 0 ? env.adminNetworks.join(', ') : t('setup.env.anyNetwork') },
    { label: t('setup.env.address'), value: env.browserAddress, ...(networkWarn ? { warn: t('setup.env.addressOutside') } : {}) },
    { label: t('setup.env.importDir'), value: env.importDir ?? t('setup.env.notSet') },
    { label: t('setup.env.uploadDir'), value: env.uploadDir ?? t('setup.env.notSet') },
    { label: t('setup.env.tls'), value: t(`setup.env.tls.${env.tls}`) },
  ]
  return (
    <section aria-labelledby="env-title" className="rounded-[var(--radius-card)] border border-border bg-raised p-4">
      <h2 id="env-title" className="mb-1 text-sm font-semibold">
        {t('setup.env.title')}
      </h2>
      <p className="mb-3 text-xs text-muted">{t('setup.env.lead')}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm min-[480px]:grid-cols-[auto_1fr]">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted">{r.label}</dt>
            <dd className="min-w-0 break-words">
              <span className="font-mono text-[13px]">{r.value}</span>
              {r.warn && (
                <p className={cn('mt-0.5 text-xs text-[var(--pill-warning-ink)]')} role="note">
                  {r.warn}
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {networkWarn && (
        <div className="mt-4">
          <Check label={t('setup.env.acknowledge')} checked={acknowledged} onChange={onAcknowledge} />
        </div>
      )}
    </section>
  )
}
