import { Ban, Check, CircleAlert, Minus, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { StatementClass } from '~/server/structure/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'

function Pill({
  tone,
  children,
}: {
  tone: 'neutral' | 'warning' | 'negative'
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]',
        tone === 'warning' && 'bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]',
        tone === 'negative' && 'bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]',
      )}
    >
      {children}
    </span>
  )
}

/** Class of a statement: a pale pill with a glyph and a word, so colour is never the only signal. */
export function ClassBadge({
  value,
  scope = 'structure',
}: {
  value: StatementClass
  scope?: 'structure' | 'rows'
}) {
  if (value === 'hard') {
    return (
      <Pill tone="negative">
        <ShieldAlert size={12} aria-hidden />
        {t(scope === 'rows' ? 'rows.class.hard' : 'structure.class.hard')}
      </Pill>
    )
  }
  if (value === 'soft') {
    return (
      <Pill tone="warning">
        <CircleAlert size={12} aria-hidden />
        {t(scope === 'rows' ? 'rows.class.soft' : 'structure.class.soft')}
      </Pill>
    )
  }
  return (
    <Pill tone="neutral">
      <ShieldCheck size={12} aria-hidden />
      {t(scope === 'rows' ? 'rows.class.none' : 'structure.class.none')}
    </Pill>
  )
}

export function ResultBadge({ status }: { status: 'executed' | 'failed' | 'not-run' }) {
  if (status === 'executed') {
    return (
      <Pill tone="neutral">
        <Check size={12} aria-hidden />
        {t('structure.result.executed')}
      </Pill>
    )
  }
  if (status === 'failed') {
    return (
      <Pill tone="negative">
        <Ban size={12} aria-hidden />
        {t('structure.result.failed')}
      </Pill>
    )
  }
  return (
    <Pill tone="neutral">
      <Minus size={12} aria-hidden />
      {t('structure.result.notRun')}
    </Pill>
  )
}
