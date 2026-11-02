import { useId, type ReactNode } from 'react'
import { BrandName } from '~/components/brand'
import { cn } from '~/lib/utils'

/** Centred single column on the ground colour, the layout of the login page; `wide` is the setup wizard. */
export function AuthFrame({ children, wide = false }: { children?: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-ground px-4 py-10">
      <div className={cn('w-full', wide ? 'max-w-[600px]' : 'max-w-[400px]')}>
        <div className="mb-8">
          <BrandName />
        </div>
        {children}
      </div>
    </main>
  )
}

export function AuthHeading({ title, lead }: { title: string; lead?: string }) {
  return (
    <>
      <h1 className="mb-3 text-[22px] font-semibold leading-7">{title}</h1>
      {lead && <p className="mb-8 text-sm text-muted">{lead}</p>}
    </>
  )
}

/** Label, control, hint and error wired together with ids; the control gets its props from the render function. */
export function FormField({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-negative">
          {error}
        </p>
      )}
    </div>
  )
}

/** Failure line of a form; `role=alert` so it is read out when it appears. */
export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null
  return (
    <p role="alert" className="text-sm text-negative">
      {message}
    </p>
  )
}
