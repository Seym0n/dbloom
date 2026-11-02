import { useId, type ReactNode } from 'react'
import { cn } from '~/lib/utils'

/** A titled group of an account page: heading, optional lead, and a flat panel of rows. */
export function Section({ title, lead, action, children, id }: { title: string; lead?: string; action?: ReactNode; children: ReactNode; id?: string }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} id={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {lead && <p className="mt-1 max-w-[60ch] text-sm text-muted">{lead}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Panel of rows separated by one-pixel rules; the first row has none. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-[var(--radius-card)] border border-border bg-surface px-4', className)}>{children}</div>
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule py-3 first:border-t-0', className)}>{children}</div>
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'negative' }) {
  const tones = {
    neutral: 'bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]',
    warning: 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]',
    negative: 'bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]',
  }
  return <span className={cn('inline-flex h-5 flex-none items-center whitespace-nowrap rounded-full px-2 text-xs font-medium', tones[tone])}>{children}</span>
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-sm text-muted', className)}>{children}</p>
}
