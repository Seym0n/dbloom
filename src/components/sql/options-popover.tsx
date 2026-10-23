import { useEffect, useId, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import type { SqlRunOptions } from '~/server/sql/types'
import { t, type MessageKey } from '~/i18n'
import { Notice } from './parts'

export type TabPrefs = { completion: boolean }

type RunKey = keyof SqlRunOptions

const RUN_ROWS: { key: RunKey; label: MessageKey; hint?: MessageKey }[] = [
  { key: 'continueOnError', label: 'sql.opt.continue', hint: 'sql.opt.continueHint' },
  { key: 'singleTransaction', label: 'sql.opt.transaction', hint: 'sql.opt.transactionHint' },
  { key: 'disableForeignKeyChecks', label: 'sql.opt.fk', hint: 'sql.opt.fkHint' },
  { key: 'confirmSoft', label: 'sql.opt.soft', hint: 'sql.opt.softHint' },
]

/**
 * Run options as a disclosure popover (no dependency): a button and a panel with checkboxes. Escape and an
 * outside press close it and return focus to the button. Options live in page memory only.
 */
export function OptionsPopover({
  options,
  onChange,
  prefs,
  onPrefs,
  implicitCommitWarning,
}: {
  options: SqlRunOptions
  onChange: (next: SqlRunOptions) => void
  prefs: TabPrefs
  onPrefs: (next: TabPrefs) => void
  implicitCommitWarning: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLElement>('input')?.focus()
    const down = (e: PointerEvent) => {
      const target = e.target as Node
      if (!root.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [open])

  return (
    <div ref={root} className="relative">
      <Button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="pointer-coarse:h-11"
      >
        <SlidersHorizontal size={14} strokeWidth={1.5} aria-hidden />
        <span className="hidden lg:inline">{t('sql.opt.title')}</span>
        <span className="sr-only lg:hidden">{t('sql.opt.title')}</span>
      </Button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={t('sql.opt.title')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
              root.current?.querySelector<HTMLElement>('button')?.focus()
            }
          }}
          className="absolute top-full right-0 z-30 mt-1 flex w-[min(340px,calc(100vw-32px))] flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
        >
          {RUN_ROWS.map((row) => {
            const cid = `${id}-${row.key}`
            return (
              <div key={row.key} className="flex items-start gap-2">
                <Checkbox
                  id={cid}
                  checked={options[row.key]}
                  onChange={(e) => onChange({ ...options, [row.key]: e.target.checked })}
                  disabled={row.key === 'continueOnError' && options.singleTransaction}
                />
                <label htmlFor={cid} className="min-w-0 text-sm">
                  <span className="block">{t(row.label)}</span>
                  {row.hint && <span className="block text-xs text-muted">{t(row.hint)}</span>}
                </label>
              </div>
            )
          })}
          <div className="flex items-start gap-2 border-t border-rule pt-3">
            <Checkbox
              id={`${id}-completion`}
              checked={prefs.completion}
              onChange={(e) => onPrefs({ ...prefs, completion: e.target.checked })}
            />
            <label htmlFor={`${id}-completion`} className="text-sm">
              {t('sql.opt.completion')}
            </label>
          </div>
          {options.singleTransaction && implicitCommitWarning && (
            <Notice>{t('sql.opt.implicitCommit')}</Notice>
          )}
          <p className="text-xs text-muted">{t('sql.opt.sessionNote')}</p>
        </div>
      )}
    </div>
  )
}
