import type { SelectHTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

/** Native select in the control style of the shell. Compact (32px) is for grids, default (40px) for forms. */
export function Select({
  className,
  compact,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return (
    <select
      className={cn(
        'w-full rounded-[var(--radius-control)] border border-control bg-surface px-2 text-sm text-ink disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted',
        compact ? 'h-8' : 'h-10',
        className,
      )}
      {...props}
    />
  )
}
