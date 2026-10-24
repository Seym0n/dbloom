import { useId, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import type { SearchInput } from '~/server/rows/types'
import { MAX_FILTER_VALUE_BYTES } from '~/server/rows/types'
import { t } from '~/i18n'
import { RowsPopover } from './rows-popover'

/**
 * "Search in table" runs on the server over the text columns (FR-ROW-009) and resets the page; it is applied
 * with Enter or the button, never while typing, so a keystroke does not start a query on a big table.
 */
export function TableSearch({
  applied,
  onSearch,
  disabled,
}: {
  applied: SearchInput | undefined
  onSearch: (next: SearchInput | undefined) => void
  disabled?: boolean
}) {
  const [text, setText] = useState(applied?.text ?? '')
  const [allColumns, setAllColumns] = useState(applied?.allColumns ?? false)
  const [matchCase, setMatchCase] = useState(applied?.matchCase ?? false)
  const id = useId()

  const submit = () => {
    const value = text.trim() === '' ? '' : text
    if (value === '') return onSearch(undefined)
    onSearch({ text: value, allColumns, matchCase })
  }

  return (
    <form
      role="search"
      aria-label={t('rows.search.landmark')}
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="relative">
        <Search
          size={14}
          strokeWidth={1.5}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
        />
        <Input
          id={id}
          type="search"
          aria-label={t('rows.search.table')}
          placeholder={t('rows.search.tablePlaceholder')}
          value={text}
          maxLength={MAX_FILTER_VALUE_BYTES}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className="h-8 w-44 [appearance:none] pr-7 pl-8 sm:w-56 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
        />
        {(text !== '' || applied) && (
          <button
            type="button"
            aria-label={t('rows.search.clear')}
            onClick={() => {
              setText('')
              if (applied) onSearch(undefined)
            }}
            className="press absolute top-1/2 right-1.5 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-faint hover:bg-active hover:text-ink"
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </div>
      <Button type="submit" disabled={disabled} className="pointer-coarse:h-11">
        {t('rows.search.run')}
      </Button>
      <RowsPopover
        label={t('rows.search.options')}
        icon={<SlidersHorizontal size={14} strokeWidth={1.5} aria-hidden />}
        hideLabelBelow="xl"
        variant="ghost"
        widthClass="w-[min(300px,calc(100vw-32px))]"
      >
        {() => (
          <div className="flex flex-col gap-3 p-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${id}-all`}
                checked={allColumns}
                onChange={(e) => setAllColumns(e.target.checked)}
              />
              <label htmlFor={`${id}-all`} className="text-sm">
                <span className="block">{t('rows.search.allColumns')}</span>
                <span className="block text-xs text-muted">{t('rows.search.allColumnsHint')}</span>
              </label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${id}-case`}
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />
              <label htmlFor={`${id}-case`} className="text-sm">
                {t('rows.search.matchCase')}
              </label>
            </div>
            <p className="text-xs text-muted">{t('rows.search.optionsNote')}</p>
          </div>
        )}
      </RowsPopover>
    </form>
  )
}

/**
 * "Find on this page": a client-side filter over the rows already loaded, with a live match count. It is
 * labelled page-local so nobody mistakes it for the table search (FR-UIX-055).
 */
export function PageFind({
  value,
  onChange,
  matches,
  total,
}: {
  value: string
  onChange: (next: string) => void
  matches: number
  total: number
}) {
  const hint = useId()
  return (
    <div className="flex items-center gap-2">
      <Input
        type="search"
        aria-label={t('rows.search.page')}
        aria-describedby={hint}
        placeholder={t('rows.search.pagePlaceholder')}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-36 sm:w-44 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
      />
      <p id={hint} className="min-w-0 text-xs whitespace-nowrap text-muted" aria-live="polite">
        {value.trim() === '' ? '' : t('rows.search.pageMatches', { matches, total })}
      </p>
    </div>
  )
}
