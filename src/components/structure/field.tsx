import { useId, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { Label } from '~/components/ui/label'
import { t } from '~/i18n'
import type { FieldError } from './model'

export const errorText = (error: FieldError | undefined) =>
  error ? t(error.key, error.values) : undefined

/** Label above, control, inline error below. The control receives its id and aria wiring through render. */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string
  error?: FieldError | string
  hint?: string
  className?: string
  children: (props: {
    id: string
    'aria-invalid': boolean
    'aria-describedby': string | undefined
  }) => ReactNode
}) {
  const id = useId()
  const message = typeof error === 'string' ? error : errorText(error)
  const describedBy = message ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': Boolean(message), 'aria-describedby': describedBy })}
      {hint && !message && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {message && (
        <p id={`${id}-error`} className="text-xs text-negative">
          {message}
        </p>
      )}
    </div>
  )
}

/** Small inline error for grid cells. */
export function CellError({ id, error }: { id: string; error: FieldError | undefined }) {
  const message = errorText(error)
  if (!message) return null
  return (
    <p id={id} className="mt-0.5 text-xs text-negative">
      {message}
    </p>
  )
}
