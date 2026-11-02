import { useState } from 'react'
import { t } from '~/i18n'
import { useStepUp } from '~/components/auth/account/step-up'
import { PasswordField } from '~/components/auth/password-field'
import { FormField } from '~/components/auth/auth-frame'
import { ShownOnce } from '~/components/auth/shown-once'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { authApi } from '~/lib/auth/api'
import { normaliseRecoveryKey } from '~/lib/auth/connections-logic'
import { useAction } from '~/lib/auth/use-action'
import { VAULT_PASSPHRASE_MIN_DEFAULT, VAULT_RECOVERY_KEY_FILE_NAME } from '~/server/auth/types'
import { ModalForm } from './dialog-shell'

export type VaultFlow = 'create' | 'unlock' | 'change' | 'recover' | 'regenerate' | 'rotate'

/** A wrong passphrase comes back as the generic sign-in failure or as vault_locked (SPEC/26 FR-AUT-021); on a vault form it gets its own words. */
const vaultError = (e: { message: string; parsed: { code: string } } | null | undefined) =>
  e ? (e.parsed.code === 'auth_failed' || e.parsed.code === 'vault_locked' ? t('auth.vault.wrongPassphrase') : e.message) : null

/**
 * One dialog for every vault action (FR-AUT-021). Actions that mint a recovery key (create, recover, regenerate, rotate)
 * switch to the shown-once view and cannot be closed before "I saved it" is ticked.
 */
export function VaultFlowDialog({
  flow,
  minLength = VAULT_PASSPHRASE_MIN_DEFAULT,
  onClose,
  onDone,
  onSwitch,
}: {
  flow: VaultFlow
  minLength?: number
  onClose: () => void
  /** Called once the action succeeded and, where a key was shown, after it was confirmed. */
  onDone: (flow: VaultFlow) => void
  onSwitch?: (flow: VaultFlow) => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [shownKey, setShownKey] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [mismatch, setMismatch] = useState(false)
  const action = useAction()
  const { guard } = useStepUp()
  const api = authApi()

  const setsNew = flow === 'create' || flow === 'change' || flow === 'recover'
  const needsCurrent = flow === 'unlock' || flow === 'change' || flow === 'rotate'
  const needsKey = flow === 'recover'

  async function submit() {
    if (setsNew && next !== again) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    const r = await action.run(async () => {
      switch (flow) {
        case 'create':
          return api.vaultCreate(next)
        case 'unlock':
          return api.vaultUnlock(current)
        case 'change':
          return api.vaultChangePassphrase(current, next)
        case 'recover':
          return api.vaultUseRecoveryKey(normaliseRecoveryKey(recoveryKey), next)
        case 'regenerate':
          return guard(() => api.vaultRegenerateRecoveryKey())
        case 'rotate':
          return guard(() => api.vaultRotateKey(current))
      }
    })
    if (!r.ok) return
    const key = (r.value as { recoveryKey?: string } | undefined)?.recoveryKey
    if (key) setShownKey(key)
    else onDone(flow)
  }

  if (shownKey) {
    return (
      <ModalForm
        title={t('auth.vault.keyTitle')}
        lead={t('auth.vault.keyLead')}
        onClose={onClose}
        locked
        submitLabel={t('auth.vault.keyDone')}
        submitDisabled={!saved}
        onSubmit={() => onDone(flow)}
      >
        <ShownOnce
          lines={[shownKey]}
          columns={1}
          fileName={VAULT_RECOVERY_KEY_FILE_NAME}
          label={t('auth.vault.keyLabel')}
          confirmLabel={t('auth.vault.keySaved')}
          saved={saved}
          onSavedChange={setSaved}
        />
      </ModalForm>
    )
  }

  const busyLabel = t('auth.vault.working')
  return (
    <ModalForm
      title={t(`auth.vault.flow.${flow}.title`)}
      lead={t(`auth.vault.flow.${flow}.lead`)}
      onClose={onClose}
      busy={action.busy}
      submitLabel={action.busy ? busyLabel : t(`auth.vault.flow.${flow}.submit`)}
      submitDisabled={(needsCurrent && current === '') || (setsNew && next === '') || (needsKey && recoveryKey.trim() === '')}
      error={vaultError(action.error)}
      onSubmit={submit}
    >
      {needsKey && (
        <FormField label={t('auth.vault.recoveryKey')} hint={t('auth.vault.recoveryKeyHint')}>
          {(field) => (
            <Input {...field} value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus className="font-mono" />
          )}
        </FormField>
      )}
      {needsCurrent && (
        <PasswordField
          label={flow === 'change' ? t('auth.vault.currentPassphrase') : t('auth.vault.passphrase')}
          name="vault-current"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          autoFocus
        />
      )}
      {setsNew && (
        <>
          <PasswordField
            label={flow === 'create' ? t('auth.vault.passphrase') : t('auth.vault.newPassphrase')}
            name="vault-new"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            meter
            minLength={minLength}
            hint={t('auth.vault.passphraseHint', { count: minLength })}
            autoFocus={flow === 'create'}
          />
          <PasswordField
            label={t('auth.vault.passphraseAgain')}
            name="vault-again"
            value={again}
            onChange={setAgain}
            autoComplete="new-password"
            error={mismatch ? t('auth.vault.mismatch') : null}
          />
        </>
      )}
      {flow === 'unlock' && onSwitch && (
        <Button variant="ghost" className="self-start" onClick={() => onSwitch('recover')}>
          {t('auth.vault.useRecoveryKey')}
        </Button>
      )}
    </ModalForm>
  )
}
