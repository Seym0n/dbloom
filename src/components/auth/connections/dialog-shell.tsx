import { useId, type FormEvent, type ReactNode } from 'react'
import { t } from '~/i18n'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { ErrorNote } from '~/components/auth/auth-frame'

/**
 * Form in a modal dialog, the pattern of the change-password dialog: title, lead, fields, an error line and a
 * cancel / submit pair. Mount it only while it is wanted (`{open && <ModalForm …/>}`) so each opening starts clean.
 * `locked` blocks Escape, backdrop close and the cancel button (a secret that is shown once).
 */
export function ModalForm({
  title,
  lead,
  onClose,
  onSubmit,
  submitLabel,
  busy = false,
  submitDisabled = false,
  error,
  locked = false,
  danger = false,
  wide = false,
  extra,
  children,
}: {
  title: string
  lead?: string
  onClose: () => void
  onSubmit: () => void | Promise<unknown>
  submitLabel: string
  busy?: boolean
  submitDisabled?: boolean
  error?: string | null
  locked?: boolean
  danger?: boolean
  wide?: boolean
  /** Extra buttons left of cancel (a test, "save anyway"). */
  extra?: ReactNode
  children?: ReactNode
}) {
  const titleId = useId()
  function submit(event: FormEvent) {
    event.preventDefault()
    void onSubmit()
  }
  return (
    <Dialog open onClose={locked ? () => undefined : onClose} labelledBy={titleId} className={wide ? 'w-[min(680px,calc(100vw-32px))]' : undefined}>
      <form onSubmit={submit} noValidate className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6">
        <div>
          <h2 id={titleId} className="mb-1 text-base font-semibold">
            {title}
          </h2>
          {lead && <p className="text-sm text-muted">{lead}</p>}
        </div>
        {children}
        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          {extra}
          {!locked && (
            <Button size="lg" onClick={onClose}>
              {t('auth.cancel')}
            </Button>
          )}
          <Button
            type="submit"
            variant={danger ? 'outline' : 'primary'}
            size="lg"
            disabled={busy || submitDisabled}
            className={danger ? 'border-negative text-negative hover:bg-raised' : undefined}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
