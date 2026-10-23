import type { InputHTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

/** Native checkbox, 18px, accent-coloured when checked. Always give it a label or an aria-label. */
export function Checkbox({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'h-[18px] w-[18px] shrink-0 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}
