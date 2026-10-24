import { useEffect, useRef, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import { Checkbox } from '~/components/ui/checkbox'
import { numberFormat } from '~/components/grid/cell-view'
import { t } from '~/i18n'
import type { HeaderState } from './selection-model'

/** Check-all for the visible page, with the indeterminate state (FR-UIX-054). */
export function HeaderCheckbox({ state, onToggle }: { state: HeaderState; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={t('rows.grid.selectPage')}
      checked={state === 'all'}
      onChange={onToggle}
      className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-[var(--accent)]"
    />
  )
}

/**
 * Row checkbox. Shift+click selects the range from the last toggled row (FR-UIX-036); the shift state is
 * read from the click, because `onChange` carries no modifiers.
 */
export function RowCheckbox({
  index,
  checked,
  onToggle,
}: {
  index: number
  checked: boolean
  onToggle: (shift: boolean) => void
}) {
  return (
    <Checkbox
      aria-label={t('rows.grid.selectRow', { n: index + 1 })}
      checked={checked}
      tabIndex={-1}
      onChange={() => {}}
      onClick={(e: MouseEvent<HTMLInputElement>) => {
        e.stopPropagation()
        onToggle(e.shiftKey)
      }}
    />
  )
}

/** "3 rows selected" with a Clear button; announced politely. */
export function SelectionSummary({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <div className="flex items-center gap-1.5 text-sm" aria-live="polite" aria-atomic="true">
      {count > 0 && (
        <>
          <span className="text-ink">
            {t('rows.grid.selected', { count: numberFormat.format(count) })}
          </span>
          <button
            type="button"
            onClick={onClear}
            className="press inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted hover:bg-active hover:text-ink pointer-coarse:h-11"
          >
            <X size={12} aria-hidden />
            {t('rows.grid.clearSelection')}
          </button>
        </>
      )}
    </div>
  )
}
