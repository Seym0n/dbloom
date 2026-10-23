import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '~/lib/utils'

/**
 * Modal on the native <dialog> (focus trap, Escape and focus return come from the browser), the same
 * pattern as session-ended-dialog. Children mount only while open, so each opening starts clean.
 * `onClose` is called for Escape and for a click on the backdrop; the caller decides whether to obey.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  labelledBy: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={cn(
        'm-auto max-h-[calc(100dvh-32px)] w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-[var(--radius-sheet)] border border-border bg-surface p-0 text-ink shadow-lg',
        className,
      )}
    >
      {open ? children : null}
    </dialog>
  )
}
