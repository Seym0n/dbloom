import { useState, type ReactNode } from 'react'
import { Check, CircleAlert, Copy, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button } from '~/components/ui/button'
import type { StatementClass } from '~/server/structure/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'

export function Pill({
  tone,
  children,
  className,
}: {
  tone: 'neutral' | 'warning' | 'negative'
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]',
        tone === 'warning' && 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]',
        tone === 'negative' && 'bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]',
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * Class of a statement of the SQL tab. Same look as the structure badge (pale pill, glyph and a word,
 * so colour is never the only signal) but with words that fit user SQL: the structure labels talk about
 * schema changes and would misname an UPDATE.
 */
export function SqlClassBadge({ value }: { value: StatementClass }) {
  if (value === 'hard') {
    return (
      <Pill tone="negative">
        <ShieldAlert size={12} aria-hidden />
        {t('sql.class.hard')}
      </Pill>
    )
  }
  if (value === 'soft') {
    return (
      <Pill tone="warning">
        <CircleAlert size={12} aria-hidden />
        {t('sql.class.soft')}
      </Pill>
    )
  }
  return (
    <Pill tone="neutral">
      <ShieldCheck size={12} aria-hidden />
      {t('sql.class.none')}
    </Pill>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      className="h-6 px-2 text-xs"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      <span aria-live="polite">{copied ? t('table.copied') : t('table.copy')}</span>
    </Button>
  )
}

export function Notice({
  children,
  tone = 'warning',
  role,
}: {
  children: ReactNode
  tone?: 'warning' | 'negative' | 'neutral'
  role?: 'alert' | 'status'
}) {
  return (
    <p
      role={role ?? (tone === 'negative' ? 'alert' : undefined)}
      className={cn(
        'flex items-start gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm',
        tone === 'warning' && 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]',
        tone === 'negative' && 'bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]',
        tone === 'neutral' && 'bg-raised text-muted',
      )}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

/** Platform-aware label of the Mod key for hints. */
export function modKey(): string {
  if (typeof navigator === 'undefined') return 'Ctrl'
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
}
