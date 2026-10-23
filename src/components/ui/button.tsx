import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

const button = cva(
  'press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-[var(--primary-ink)] hover:opacity-90',
        outline: 'border border-control bg-surface text-ink hover:bg-raised',
        ghost: 'text-muted hover:bg-active hover:text-ink',
      },
      size: { default: 'h-8 px-3', icon: 'h-8 w-8', lg: 'h-10 px-4' },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
)

type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>

export function Button({ className, variant, size, type = 'button', ...props }: Props) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />
}
