import { useId, useState, type ReactNode } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { authApi } from '~/lib/auth/api'
import { useAction } from '~/lib/auth/use-action'
import { ErrorNote } from '../auth-frame'
import { PasskeyEnrol } from '../passkey-enrol'
import { ShownOnce } from '../shown-once'
import { TotpEnrol } from '../totp-enrol'
import { useStepUp } from './step-up'

/** Yes or no before something that cannot be undone; the action runs inside, its error shows in the dialog. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<unknown>
  onClose: () => void
}) {
  const titleId = useId()
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <ConfirmForm titleId={titleId} title={title} body={body} confirmLabel={confirmLabel} danger={danger} onConfirm={onConfirm} onClose={onClose} />
    </Dialog>
  )
}

function ConfirmForm({
  titleId,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  titleId: string
  title: string
  body: ReactNode
  confirmLabel: string
  danger: boolean
  onConfirm: () => Promise<unknown>
  onClose: () => void
}) {
  const action = useAction()
  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h2 id={titleId} className="mb-1 text-base font-semibold">
          {title}
        </h2>
        <div className="text-sm text-muted">{body}</div>
      </div>
      <ErrorNote message={action.error?.message} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="lg" onClick={onClose}>
          {t('auth.cancel')}
        </Button>
        <Button
          size="lg"
          variant={danger ? 'outline' : 'primary'}
          className={danger ? 'border-negative text-negative hover:bg-raised' : undefined}
          disabled={action.busy}
          onClick={async () => {
            const r = await action.run(onConfirm)
            if (r.ok) onClose()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

/** Recovery codes, shown once: no Escape and no backdrop close until "I saved them" is ticked. */
export function CodesDialog({ open, codes, onClose }: { open: boolean; codes: string[]; onClose: () => void }) {
  const titleId = useId()
  return (
    <Dialog open={open} onClose={() => undefined} labelledBy={titleId}>
      <CodesBody titleId={titleId} codes={codes} onClose={onClose} />
    </Dialog>
  )
}

function CodesBody({ titleId, codes, onClose }: { titleId: string; codes: string[]; onClose: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h2 id={titleId} className="mb-1 text-base font-semibold">
          {t('account.codes.title')}
        </h2>
        <p className="text-sm text-muted">{t('account.codes.lead')}</p>
      </div>
      <ShownOnce lines={codes} fileName="dbloom-recovery-codes.txt" label={t('account.codes.label')} saved={saved} onSavedChange={setSaved} />
      <div className="flex justify-end">
        <Button size="lg" variant="primary" disabled={!saved} onClick={onClose}>
          {t('account.codes.done')}
        </Button>
      </div>
    </div>
  )
}

export function AddPasskeyDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (recoveryCodes?: string[]) => void }) {
  const titleId = useId()
  const { guard } = useStepUp()
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6">
        <h2 id={titleId} className="text-base font-semibold">
          {t('account.passkeys.addTitle')}
        </h2>
        <PasskeyEnrol
          options={() => authApi().passkeyRegisterOptions()}
          verify={(response, name) => guard(() => authApi().passkeyRegisterVerify(response, name))}
          onDone={(result) => onAdded((result as { recoveryCodes?: string[] } | undefined)?.recoveryCodes)}
          onCancel={onClose}
        />
      </div>
    </Dialog>
  )
}

export function TotpDialog({ open, replacing, onClose, onDone }: { open: boolean; replacing: boolean; onClose: () => void; onDone: (recoveryCodes?: string[]) => void }) {
  const titleId = useId()
  const { guard } = useStepUp()
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6">
        <h2 id={titleId} className="text-base font-semibold">
          {t(replacing ? 'account.totp.replaceTitle' : 'account.totp.addTitle')}
        </h2>
        <TotpEnrol start={() => guard(() => authApi().totpStart())} confirm={(code) => authApi().totpConfirm(code)} onDone={onDone} onCancel={onClose} />
      </div>
    </Dialog>
  )
}
