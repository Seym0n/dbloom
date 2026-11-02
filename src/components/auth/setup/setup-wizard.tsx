import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { AuthFrame, ErrorNote, FormField } from '~/components/auth/auth-frame'
import { authApi, type SetupStateResponse } from '~/lib/auth/api'
import { parseAuthError } from '~/lib/auth/errors'
import { validateSite } from '~/lib/auth/setup-site'
import { applicableSteps, nextStep, previousStep, type WizardStep } from '~/lib/auth/setup-steps'
import { useAction } from '~/lib/auth/use-action'
import { setCsrfToken } from '~/lib/csrf'
import { cn } from '~/lib/utils'
import type { LoginMode, SetupEnvStatus, SetupSiteValues } from '~/server/auth/types'
import { AdminStep, emptyAdmin, type AdminState } from './admin-step'
import { EnvStatus, SiteForm } from './site-form'

type Ready = { env: SetupEnvStatus; defaults: SetupSiteValues; draftMode?: LoginMode; draftSite?: SetupSiteValues }

function Stepper({ step, mode }: { step: WizardStep; mode: LoginMode | undefined }) {
  const steps = applicableSteps(mode)
  const index = steps.indexOf(step)
  return (
    <nav aria-label={t('setup.steps')} className="mb-6">
      <p className="mb-2 text-xs text-muted">{t('setup.stepOf', { current: index + 1, total: steps.length })}</p>
      <ol className="flex items-center gap-2">
        {steps.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className={cn(
                'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                i < index && 'border-accent bg-accent text-[var(--accent-ink)]',
                i === index && 'border-ink text-ink',
                i > index && 'border-control text-muted',
              )}
            >
              {i < index ? <Check size={12} aria-hidden /> : i + 1}
            </span>
            <span className={cn('text-xs', s === step ? 'font-medium text-ink' : 'sr-only min-[640px]:not-sr-only text-muted')}>{t(`setup.step.${s}`)}</span>
            {i < steps.length - 1 && <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />}
          </li>
        ))}
      </ol>
    </nav>
  )
}

function StepFrame({ title, lead, children, focus = true }: { title: string; lead?: string; children: ReactNode; focus?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focus) heading.current?.focus()
  }, [focus])
  return (
    <section className="rounded-[var(--radius-sheet)] border border-border bg-surface p-5 min-[480px]:p-6">
      <h1 ref={heading} tabIndex={-1} className="mb-2 text-[22px] font-semibold leading-7 outline-none">
        {title}
      </h1>
      {lead && <p className="mb-6 text-sm text-muted">{lead}</p>}
      {children}
    </section>
  )
}

/** First-run setup (FR-AUT-003, UI-TGT-002): token, login mode, site configuration, first administrator, done. */
export function SetupWizard() {
  const api = authApi()
  const [phase, setPhase] = useState<'loading' | 'gone' | 'ready'>('loading')
  const [step, setStep] = useState<WizardStep>('welcome')
  const [ready, setReady] = useState<Ready | null>(null)
  const [mode, setMode] = useState<LoginMode | undefined>(undefined)
  const [site, setSite] = useState<SetupSiteValues | null>(null)
  const [ack, setAck] = useState(false)
  const [admin, setAdmin] = useState<AdminState>(emptyAdmin)
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    api
      .setupGetState()
      .then(() => setPhase('ready'))
      .catch((e) => setPhase(parseAuthError(e).code === 'gone' ? 'gone' : 'ready'))
  }, [api])

  function adopt(state: SetupStateResponse) {
    if (!('env' in state)) return
    setReady({ env: state.env, defaults: state.defaults, ...(state.draft.loginMode ? { draftMode: state.draft.loginMode } : {}), ...(state.draft.site ? { draftSite: state.draft.site } : {}) })
    setMode(state.draft.loginMode ?? 'account')
    setSite(state.draft.site ?? state.defaults)
  }

  if (phase === 'loading') return <AuthFrame wide />
  if (phase === 'gone') {
    return (
      <AuthFrame wide>
        <StepFrame title={t('setup.gone.title')} lead={t('setup.gone.lead')} focus={false}>
          <Link to="/" className="text-sm font-medium text-accent underline underline-offset-2">
            {t('auth.link.toSignIn')}
          </Link>
        </StepFrame>
      </AuthFrame>
    )
  }

  const back = () => setStep((s) => previousStep(s, mode))
  const forward = () => setStep((s) => nextStep(s, mode))

  return (
    <AuthFrame wide>
      <Stepper step={step} mode={mode} />
      {step === 'welcome' && (
        <WelcomeStep
          accepted={ready !== null}
          onAccepted={async () => {
            adopt(await api.setupGetState())
            forward()
          }}
          onContinue={forward}
        />
      )}
      {step === 'mode' && mode && (
        <ModeStep
          value={mode}
          onBack={back}
          onSaved={(m) => {
            setMode(m)
            forward()
          }}
        />
      )}
      {step === 'site' && ready && mode && site && (
        <SiteStep
          mode={mode}
          values={site}
          onChange={setSite}
          env={ready.env}
          ack={ack}
          onAck={setAck}
          onBack={back}
          onSaved={async () => {
            if (mode === 'direct') {
              await api.setupComplete({ acknowledgeAdminNetwork: ack })
              setStep('done')
            } else forward()
          }}
        />
      )}
      {step === 'admin' && site && (
        <AdminFinish
          admin={admin}
          setAdmin={setAdmin}
          minLength={site.passwordMinLength}
          ack={ack}
          onBack={back}
          onDone={() => setStep('done')}
        />
      )}
      {step === 'done' && mode && site && <DoneStep mode={mode} siteName={site.siteName} adminName={admin.username} />}
    </AuthFrame>
  )
}

function WelcomeStep({ accepted, onAccepted, onContinue }: { accepted: boolean; onAccepted: () => Promise<void>; onContinue: () => void }) {
  const [token, setToken] = useState('')
  const [wrong, setWrong] = useState(false)
  const action = useAction()
  const api = authApi()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setWrong(false)
    const r = await action.run(async () => {
      const result = await api.setupVerifyToken(token.trim())
      if (!result.ok) return false
      setCsrfToken(result.csrf)
      await onAccepted()
      return true
    })
    if (r.ok && !r.value) setWrong(true)
    setToken('')
  }

  return (
    <StepFrame title={t('setup.welcome.title')} lead={t('setup.welcome.lead')} focus={false}>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        <dt className="text-muted">{t('setup.env.store')}</dt>
        <dd className="font-mono text-[13px]">{t('setup.env.stateful')}</dd>
      </dl>
      {accepted ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-sm">
            {t('setup.token.accepted')}
          </p>
          <div className="flex justify-end">
            <Button variant="primary" size="lg" onClick={onContinue}>
              {t('setup.next')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FormField label={t('setup.token.label')} hint={t('setup.token.hint')}>
            {(field) => (
              <Input
                {...field}
                name="setup-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
                className="font-mono"
              />
            )}
          </FormField>
          <ErrorNote message={wrong ? t('setup.token.invalid') : action.error?.message} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="lg" disabled={action.busy || token.trim() === ''}>
              {action.busy ? t('setup.token.checking') : t('setup.token.submit')}
            </Button>
          </div>
        </form>
      )}
    </StepFrame>
  )
}

function ModeStep({ value, onBack, onSaved }: { value: LoginMode; onBack: () => void; onSaved: (m: LoginMode) => void }) {
  const [mode, setMode] = useState<LoginMode>(value)
  const action = useAction()
  const api = authApi()
  const options: LoginMode[] = ['account', 'direct']

  async function submit(event: FormEvent) {
    event.preventDefault()
    const r = await action.run(() => api.setupSaveStep({ step: 2, loginMode: mode }))
    if (r.ok) onSaved(mode)
  }

  return (
    <StepFrame title={t('setup.mode.title')} lead={t('setup.mode.lead')}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">{t('setup.mode.title')}</legend>
          {options.map((m) => (
            <label
              key={m}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border p-4 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent)]',
                mode === m ? 'border-ink bg-raised' : 'border-border',
              )}
            >
              <input type="radio" name="login-mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-1 accent-[var(--accent)]" />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t(`setup.mode.${m}`)}</span>
                <span className="text-sm text-muted">{t(`setup.mode.${m}Lead`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted">{t('setup.mode.final')}</p>
        <p className="text-xs text-muted">{t('setup.mode.envNote')}</p>
        <ErrorNote message={action.error?.message} />
        <NavButtons onBack={onBack} busy={action.busy} />
      </form>
    </StepFrame>
  )
}

function NavButtons({ onBack, busy, label }: { onBack: () => void; busy: boolean; label?: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <Button size="lg" onClick={onBack}>
        {t('setup.back')}
      </Button>
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? t('setup.saving') : (label ?? t('setup.next'))}
      </Button>
    </div>
  )
}

function SiteStep({
  mode,
  values,
  onChange,
  env,
  ack,
  onAck,
  onBack,
  onSaved,
}: {
  mode: LoginMode
  values: SetupSiteValues
  onChange: (v: SetupSiteValues) => void
  env: SetupEnvStatus
  ack: boolean
  onAck: (v: boolean) => void
  onBack: () => void
  onSaved: () => Promise<void>
}) {
  const action = useAction()
  const api = authApi()
  const [errors, setErrors] = useState(validateSite(values, mode))
  const [tried, setTried] = useState(false)
  const needsAck = env.adminNetworks.length > 0 && !env.browserInAdminNetworks && mode === 'account'

  async function submit(event: FormEvent) {
    event.preventDefault()
    const found = validateSite(values, mode)
    setErrors(found)
    setTried(true)
    if (Object.keys(found).length > 0 || (needsAck && !ack)) return
    const r = await action.run(async () => {
      await api.setupSaveStep({ step: 3, site: { ...values, siteName: values.siteName.trim() } })
      await onSaved()
    })
    void r
  }

  return (
    <StepFrame title={t('setup.site.title')} lead={t('setup.site.lead')}>
      <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
        <EnvStatus env={env} acknowledged={ack} onAcknowledge={onAck} />
        <SiteForm
          values={values}
          onChange={(v) => {
            onChange(v)
            if (tried) setErrors(validateSite(v, mode))
          }}
          mode={mode}
          errors={tried ? errors : {}}
        />
        {tried && needsAck && !ack && <ErrorNote message={t('setup.env.acknowledgeRequired')} />}
        {tried && Object.keys(errors).length > 0 && <ErrorNote message={t('setup.site.fix')} />}
        <ErrorNote message={action.error?.message} />
        <NavButtons onBack={onBack} busy={action.busy} label={mode === 'direct' ? t('setup.finish') : t('setup.next')} />
      </form>
    </StepFrame>
  )
}

function AdminFinish({
  admin,
  setAdmin,
  minLength,
  ack,
  onBack,
  onDone,
}: {
  admin: AdminState
  setAdmin: (a: AdminState) => void
  minLength: number
  ack: boolean
  onBack: () => void
  onDone: () => void
}) {
  const action = useAction()
  const api = authApi()
  return (
    <StepFrame title={t('setup.admin.title')} lead={admin.passwordSet ? t('setup.admin.leadFactor') : t('setup.admin.lead')}>
      <AdminStep
        admin={admin}
        onChange={setAdmin}
        minLength={minLength}
        onBack={onBack}
        finishing={action.busy}
        finishError={action.error?.message ?? null}
        onFinish={async () => {
          const r = await action.run(() => api.setupComplete({ ...(admin.codes ? { codesSaved: true as const } : {}), acknowledgeAdminNetwork: ack }))
          if (r.ok) onDone()
        }}
      />
    </StepFrame>
  )
}

function DoneStep({ mode, siteName, adminName }: { mode: LoginMode; siteName: string; adminName: string }) {
  return (
    <StepFrame title={t('setup.done.title')} lead={t('setup.done.lead')}>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">{t('setup.done.mode')}</dt>
        <dd>{t(`setup.mode.${mode}`)}</dd>
        <dt className="text-muted">{t('setup.done.site')}</dt>
        <dd>{siteName}</dd>
        {mode === 'account' && (
          <>
            <dt className="text-muted">{t('setup.done.admin')}</dt>
            <dd>{adminName}</dd>
          </>
        )}
      </dl>
      <p className="mb-6 text-sm text-muted">{t('setup.done.consumed')}</p>
      {mode === 'direct' && <p className="mb-6 text-sm text-muted">{t('setup.done.directNote')}</p>}
      <Link
        to="/"
        className="press inline-flex h-10 items-center justify-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-[var(--primary-ink)] hover:opacity-90"
      >
        {t('setup.done.toSignIn')}
      </Link>
    </StepFrame>
  )
}
