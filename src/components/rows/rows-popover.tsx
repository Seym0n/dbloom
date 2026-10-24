import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

/**
 * Disclosure popover of the rows toolbar: a button and a non-modal panel. Escape and a press outside close
 * it and return focus to the button; focus moves into the panel on open. No dependency, no animation.
 */
export function RowsPopover({
  label,
  icon,
  badge,
  children,
  align = 'left',
  widthClass = 'w-[min(360px,calc(100vw-32px))]',
  hideLabelBelow = 'lg',
  disabled,
  variant,
}: {
  label: string
  icon: ReactNode
  /** Small count or word after the label (active filter conditions). */
  badge?: ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  widthClass?: string
  hideLabelBelow?: 'xl' | 'lg' | 'md' | 'never'
  disabled?: boolean
  variant?: 'outline' | 'primary' | 'ghost'
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const first = panel.current?.querySelector<HTMLElement>(
      'input, select, button, [href], textarea, [tabindex]:not([tabindex="-1"])',
    )
    first?.focus()
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [open])

  const close = () => {
    setOpen(false)
    root.current?.querySelector<HTMLElement>('button')?.focus()
  }

  return (
    <div ref={root} className="relative">
      <Button
        variant={variant}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="pointer-coarse:h-11"
      >
        {icon}
        <span
          className={cn(
            hideLabelBelow === 'xl' && 'hidden xl:inline',
            hideLabelBelow === 'lg' && 'hidden lg:inline',
            hideLabelBelow === 'md' && 'hidden md:inline',
          )}
        >
          {label}
        </span>
        {hideLabelBelow !== 'never' && (
          <span
            className={cn(
              'sr-only',
              hideLabelBelow === 'xl'
                ? 'xl:hidden'
                : hideLabelBelow === 'lg'
                  ? 'lg:hidden'
                  : 'md:hidden',
            )}
          >
            {label}
          </span>
        )}
        {badge}
      </Button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              close()
            }
          }}
          className={cn(
            'absolute top-full z-30 mt-1 flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
            widthClass,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

/** The small pill after a toolbar label (a count of active conditions). */
export function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--pill-neutral-bg)] px-1.5 text-xs font-medium text-[var(--pill-neutral-ink)]">
      {children}
    </span>
  )
}
