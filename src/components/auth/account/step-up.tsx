import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { authApi, type FactorsInfo } from '~/lib/auth/api'
import { isStepUpRequired, stepUpMethods } from '~/lib/auth/account-logic'
import { useAction } from '~/lib/auth/use-action'
import { authenticateWithPasskey } from '~/lib/auth/webauthn'
import type { StepUpMethod } from '~/server/auth/types'
import { ErrorNote, FormField } from '../auth-frame'
import { PasswordField } from '../password-field'
import { TabList, panelId } from '../tab-list'

type Guard = <T>(action: () => Promise<T>) => Promise<T>
const StepUpContext = createContext<Guard | null>(null)

/**
 * Wrap a server call that may answer `stepup_required` (FR-AUT-013): `guard(() => authApi().passkeyRemove(id))`.
 * The dialog opens, and once the user confirmed with a factor the call is made again. Cancelling gives the first error back.
 */
export function useStepUp(): { guard: Guard } {
  const guard = useContext(StepUpContext)
  return { guard: guard ?? ((action) => action()) }
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ done: () => void; cancel: () => void } | null>(null)
  const shared = useRef<Promise<void> | null>(null)

  const request = useCallback((): Promise<void> => {
    if (shared.current) return shared.current
    const promise = new Promise<void>((resolve, reject) => {
      setPending({ done: resolve, cancel: () => reject(new Error('cancelled')) })
    }).finally(() => {
      shared.current = null
      setPending(null)
    })
    shared.current = promise
    return promise
  }, [])

  const guard = useCallback<Guard>(
    async (action) => {
      try {
        return await action()
      } catch (error) {
        if (!isStepUpRequired(error)) throw error
        try {
          await request()
        } catch {
          throw error
        }
        return action()
      }
    },
    [request],
  )

  const value = useMemo(() => guard, [guard])
  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpDialog open={pending !== null} onDone={() => pending?.done()} onCancel={() => pending?.cancel()} />
    </StepUpContext.Provider>
  )
}

/** The dialog on its own, for tests and for screens that drive it themselves. */
export function StepUpDialog({ open, onDone, onCancel }: { open: boolean; onDone: () => void; onCancel: () => void }) {
  const titleId = useId()
  return (
    <Dialog open={open} onClose={onCancel} labelledBy={titleId}>
      <StepUpForm titleId={titleId} onDone={onDone} onCancel={onCancel} />
    </Dialog>
  )
}

const METHOD_LABEL: Record<StepUpMethod, 'account.stepup.passkey' | 'account.stepup.totp' | 'account.stepup.password'> = {
  passkey: 'account.stepup.passkey',
  totp: 'account.stepup.totp',
  password: 'account.stepup.password',
}

function StepUpForm({ titleId, onDone, onCancel }: { titleId: string; onDone: () => void; onCancel: () => void }) {
  const [methods, setMethods] = useState<StepUpMethod[] | null>(null)
  const [method, setMethod] = useState<StepUpMethod>('password')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const loader = useAction()
  const verify = useAction()
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void loader.run(() => authApi().listFactors()).then((r) => {
      const list = r.ok ? stepUpMethods(r.value as FactorsInfo) : (['password'] as StepUpMethod[])
      setMethods(list)
      setMethod(list[0]!)
    })
  }, [loader])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const r = await verify.run(async () => {
      if (method === 'passkey') {
        const options = await authApi().stepUpOptions('passkey')
        if (!('challenge' in options)) throw new Error('mfa_failed')
        return authApi().stepUpVerify({ method: 'passkey', response: await authenticateWithPasskey(options) })
      }
      await authApi().stepUpOptions(method)
      return authApi().stepUpVerify(method === 'totp' ? { method: 'totp', code } : { method: 'password', password })
    })
    if (r.ok) onDone()
    else {
      setCode('')
      setPassword('')
    }
  }

  const ready = method === 'passkey' || (method === 'totp' && code.replace(/\s/g, '').length >= 6) || (method === 'password' && password !== '')

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6" noValidate>
      <div>
        <h2 id={titleId} className="mb-1 text-base font-semibold">
          {t('account.stepup.title')}
        </h2>
        <p className="text-sm text-muted">{t('account.stepup.lead')}</p>
      </div>
      {methods && methods.length > 1 && (
        <TabList
          label={t('account.stepup.methods')}
          idPrefix="stepup"
          value={method}
          onChange={(key) => {
            setMethod(key)
            verify.clear()
          }}
          tabs={methods.map((key) => ({ key, label: t(METHOD_LABEL[key]) }))}
        />
      )}
      <div role={methods && methods.length > 1 ? 'tabpanel' : undefined} id={panelId('stepup', method)} className="flex flex-col gap-4">
        {method === 'passkey' && <p className="text-sm text-muted">{t('account.stepup.passkeyLead')}</p>}
        {method === 'totp' && (
          <FormField label={t('auth.mfa.codeLabel')} hint={t('auth.mfa.codeHint')}>
            {(field) => (
              <Input
                {...field}
                name="stepup-totp"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                className="max-w-40 font-mono tracking-widest"
              />
            )}
          </FormField>
        )}
        {method === 'password' && (
          <PasswordField label={t('account.stepup.passwordLabel')} name="stepup-password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        )}
      </div>
      <ErrorNote message={verify.error?.message ?? loader.error?.message} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="lg" onClick={onCancel}>
          {t('auth.cancel')}
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={verify.busy || methods === null || !ready}>
          {verify.busy ? t('account.stepup.checking') : t('account.stepup.confirm')}
        </Button>
      </div>
    </form>
  )
}
