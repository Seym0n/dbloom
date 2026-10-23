import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '~/lib/utils'

export type MenuItem = {
  key: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  /** A disabled item stays focusable and shows its reason, so keyboard users learn why. */
  disabled?: boolean
  reason?: string
  danger?: boolean
}

const MENU_WIDTH = 240

/** Disclosure menu: a button and a role=menu popup with arrow keys, Escape and outside click. No dependency. */
export function ActionsMenu({
  label,
  items,
  className,
  trigger,
}: {
  label: string
  items: MenuItem[]
  className?: string
  trigger?: ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const open = pos !== null

  function show() {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 16 - items.length * 44)),
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
    })
  }
  function hide(refocus: boolean) {
    setPos(null)
    if (refocus) button.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const down = (e: PointerEvent) => {
      const target = e.target as Node
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setPos(null)
    }
    const away = () => setPos(null)
    document.addEventListener('pointerdown', down)
    window.addEventListener('resize', away)
    window.addEventListener('scroll', away, true)
    return () => {
      document.removeEventListener('pointerdown', down)
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', away, true)
    }
  }, [open])

  function onMenuKey(e: KeyboardEvent) {
    const nodes = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => nodes[(i + nodes.length) % nodes.length]?.focus()
    if (e.key === 'ArrowDown') go(index + 1)
    else if (e.key === 'ArrowUp') go(index - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(nodes.length - 1)
    else if (e.key === 'Escape') hide(true)
    else if (e.key === 'Tab') {
      hide(false)
      return
    } else return
    e.preventDefault()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            show()
          }
        }}
        className={cn(
          'press grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:bg-active hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9',
          className,
        )}
      >
        {trigger ?? <MoreHorizontal size={14} aria-hidden />}
      </button>
      {pos && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
          className="fixed z-50 flex flex-col rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled || undefined}
              onClick={() => {
                if (item.disabled) return
                hide(false)
                item.onSelect()
              }}
              className={cn(
                'press flex min-h-9 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:bg-active',
                item.disabled
                  ? 'cursor-not-allowed text-muted'
                  : item.danger
                    ? 'text-negative hover:bg-active'
                    : 'text-ink hover:bg-active',
              )}
            >
              <span className="mt-0.5 shrink-0" aria-hidden>
                {item.icon}
              </span>
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                {item.disabled && item.reason && (
                  <span className="block text-xs text-muted">{item.reason}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
