import type { InputHTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-[var(--radius-control)] border border-control bg-surface px-3 text-sm text-ink placeholder:text-faint disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}
