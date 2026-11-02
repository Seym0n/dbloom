import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { t, type MessageKey } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { authApi, type FactorsInfo } from '~/lib/auth/api'
import { isLastFactor, recoveryLevel, relativeWhen, isoDate } from '~/lib/auth/account-logic'
import { useAction } from '~/lib/auth/use-action'
import { PASSKEY_NAME_MAX_CHARS, type PasskeyInfo } from '~/server/auth/types'
import { ErrorNote } from '../auth-frame'
import { AddPasskeyDialog, CodesDialog, ConfirmDialog, TotpDialog } from './account-dialogs'
import { Muted, Panel, Pill, Row, Section } from './account-ui'
import { useStepUp } from './step-up'

export const FACTORS_KEY = ['account', 'factors'] as const

/** "3 minutes ago", "yesterday"-style age of a timestamp, an ISO date after a week. */
export function WhenText({ ts }: { ts: number }) {
  const w = relativeWhen(ts, Date.now())
  const text =
    w.unit === 'now'
      ? t('account.when.now')
      : w.unit === 'date'
        ? isoDate(w.n)
        : t(`account.when.${w.unit}` as MessageKey, { n: w.n })
  return (
    <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      {text}
    </time>
  )
}

type Dialogs = 'addPasskey' | 'totp' | 'removeTotp' | 'regenerate' | 'disable' | null

/** Second factors of FR-AUT-012: passkeys, the authenticator app, recovery codes, and switching two-factor off. */
export function FactorsSection({ announce }: { announce: (message: string) => void }) {
  const queryClient = useQueryClient()
  const { guard } = useStepUp()
  const factors = useQuery({ queryKey: FACTORS_KEY, queryFn: () => authApi().listFactors(), retry: false })
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: FACTORS_KEY })

  if (factors.isPending) return <Section title={t('account.factors.title')} lead={t('account.factors.lead')}><Muted>{t('account.loading')}</Muted></Section>
  if (factors.isError || !factors.data) {
    return (
      <Section title={t('account.factors.title')} lead={t('account.factors.lead')}>
        <Panel className="py-3">
          <ErrorNote message={t('account.loadFailed')} />
          <Button className="mt-2" onClick={() => void factors.refetch()}>
            {t('account.retry')}
          </Button>
        </Panel>
      </Section>
    )
  }
  const data: FactorsInfo = factors.data
  const any = data.passkeys.length > 0 || data.totp
  const level = recoveryLevel(data.recoveryCodes)

  const added = async (recoveryCodes: string[] | undefined, message: string) => {
    setDialog(null)
    await refresh()
    announce(message)
    if (recoveryCodes && recoveryCodes.length > 0) setCodes(recoveryCodes)
  }

  return (
    <Section title={t('account.factors.title')} lead={t('account.factors.lead')}>
      <Panel>
        <Row className="!items-start">
          <div className="min-w-0">
            <h3 className="font-medium">{t('account.passkeys.title')}</h3>
            <Muted>{t('account.passkeys.lead')}</Muted>
          </div>
          <Button onClick={() => setDialog('addPasskey')} disabled={data.passkeys.length >= 10}>
            {t('account.passkeys.add')}
          </Button>
        </Row>
        {data.passkeys.length === 0 ? (
          <Row>
            <Muted>{t('account.passkeys.empty')}</Muted>
          </Row>
        ) : (
          <ul aria-label={t('account.passkeys.title')}>
            {data.passkeys.map((passkey) => (
              <PasskeyRow key={passkey.id} passkey={passkey} onChanged={refresh} onRemove={() => setRemoving(passkey)} announce={announce} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <Row>
          <div className="min-w-0">
            <h3 className="font-medium">{t('account.totp.title')}</h3>
            <Muted>{data.totp ? t('account.totp.on') : t('account.totp.off')}</Muted>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDialog('totp')}>{t(data.totp ? 'account.totp.replace' : 'account.totp.set')}</Button>
            {data.totp && <Button onClick={() => setDialog('removeTotp')}>{t('account.totp.remove')}</Button>}
          </div>
        </Row>
      </Panel>

      <Panel>
        <Row>
          <div className="min-w-0">
            <h3 className="font-medium">{t('account.codes.title')}</h3>
            <Muted>{t('account.recovery.count', { count: data.recoveryCodes })}</Muted>
            {level === 'low' && <p className="mt-1 text-sm text-[var(--pill-warning-ink)]">{t('account.recovery.low')}</p>}
            {level === 'none' && any && <p className="mt-1 text-sm text-[var(--pill-warning-ink)]">{t('account.recovery.none')}</p>}
          </div>
          <Button disabled={!any} onClick={() => setDialog('regenerate')}>
            {t('account.recovery.regenerate')}
          </Button>
        </Row>
      </Panel>

      {any && (
        <Panel>
          <Row>
            <div className="min-w-0">
              <h3 className="font-medium">{t('account.disable.title')}</h3>
              <Muted>{t('account.disable.lead')}</Muted>
            </div>
            <Button className="border-negative text-negative" onClick={() => setDialog('disable')}>
              {t('account.disable.action')}
            </Button>
          </Row>
        </Panel>
      )}

      <AddPasskeyDialog open={dialog === 'addPasskey'} onClose={() => setDialog(null)} onAdded={(c) => void added(c, t('account.passkeys.addedDone'))} />
      <TotpDialog open={dialog === 'totp'} replacing={data.totp} onClose={() => setDialog(null)} onDone={(c) => void added(c, t(data.totp ? 'account.totp.replaced' : 'account.totp.added'))} />
      <ConfirmDialog
        open={dialog === 'removeTotp'}
        title={t('account.totp.removeTitle')}
        body={isLastFactor(data) ? t('account.totp.removeLast') : t('account.totp.removeBody')}
        confirmLabel={t('account.totp.remove')}
        danger
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await guard(() => authApi().totpRemove())
          await refresh()
          announce(t('account.totp.removed'))
        }}
      />
      <ConfirmDialog
        open={dialog === 'regenerate'}
        title={t('account.recovery.regenTitle')}
        body={t('account.recovery.regenBody')}
        confirmLabel={t('account.recovery.regenerate')}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          const result = await guard(() => authApi().recoveryCodesRegenerate())
          await refresh()
          setCodes(result.recoveryCodes)
        }}
      />
      <ConfirmDialog
        open={dialog === 'disable'}
        title={t('account.disable.title')}
        body={t('account.disable.body')}
        confirmLabel={t('account.disable.action')}
        danger
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await guard(() => authApi().disableMfa())
          await refresh()
          announce(t('account.disable.done'))
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={t('account.passkeys.removeTitle')}
        body={removing ? t(isLastFactor(data) ? 'account.passkeys.removeLast' : 'account.passkeys.removeBody', { name: removing.name }) : null}
        confirmLabel={t('account.passkeys.remove')}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          await guard(() => authApi().passkeyRemove(removing.id))
          await refresh()
          announce(t('account.passkeys.removed'))
        }}
      />
      <CodesDialog open={codes !== null} codes={codes ?? []} onClose={() => setCodes(null)} />
    </Section>
  )
}

function PasskeyRow({ passkey, onChanged, onRemove, announce }: { passkey: PasskeyInfo; onChanged: () => unknown; onRemove: () => void; announce: (m: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(passkey.name)
  const action = useAction()

  async function save(event: FormEvent) {
    event.preventDefault()
    const next = name.trim()
    if (next === '' || next === passkey.name) {
      setEditing(false)
      return
    }
    const r = await action.run(() => authApi().passkeyRename(passkey.id, next))
    if (!r.ok) return
    setEditing(false)
    await onChanged()
    announce(t('account.passkeys.renamed'))
  }

  return (
    <li className="border-t border-rule py-3">
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2" noValidate>
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor={`rename-${passkey.id}`} className="text-sm font-medium">
              {t('account.passkeys.renameLabel')}
            </label>
            <Input id={`rename-${passkey.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={PASSKEY_NAME_MAX_CHARS} autoFocus />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={action.busy || name.trim() === ''}>
            {t('account.save')}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setEditing(false)
              setName(passkey.name)
              action.clear()
            }}
          >
            {t('auth.cancel')}
          </Button>
          <div className="basis-full">
            <ErrorNote message={action.error?.message} />
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <span className="break-all">{passkey.name}</span>
              {passkey.backedUp && <Pill>{t('account.passkeys.synced')}</Pill>}
            </p>
            <Muted>
              {t('account.passkeys.created')} <WhenText ts={passkey.createdAt} />
              {' · '}
              {passkey.lastUsedAt ? (
                <>
                  {t('account.passkeys.lastUsed')} <WhenText ts={passkey.lastUsedAt} />
                </>
              ) : (
                t('account.passkeys.neverUsed')
              )}
            </Muted>
          </div>
          <div className="flex gap-2">
            <Button aria-label={t('account.passkeys.renameAria', { name: passkey.name })} onClick={() => setEditing(true)}>
              {t('account.passkeys.rename')}
            </Button>
            <Button aria-label={t('account.passkeys.removeAria', { name: passkey.name })} onClick={onRemove}>
              {t('account.passkeys.remove')}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
