import { useId, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import type { ColumnLayout, RowColumn } from '~/server/rows/types'
import { t } from '~/i18n'
import {
  DEFAULT_COLUMN_WIDTH,
  DISPLAY_CHARS_MAX,
  DISPLAY_CHARS_MIN,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  canHide,
  clampDisplayChars,
  clampWidth,
  moveColumn,
  resetLayout,
  setColumnWidth,
  relationModeOf,
  toggleHidden,
  type DisplayPrefs,
} from './grid-model'
import { CountBadge, RowsPopover } from './rows-popover'

function WidthField({
  name,
  value,
  onCommit,
}: {
  name: string
  value: number
  onCommit: (width: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(n)) onCommit(clampWidth(n))
    setDraft(null)
  }
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={MIN_COLUMN_WIDTH}
      max={MAX_COLUMN_WIDTH}
      step={10}
      aria-label={t('rows.grid.columnWidth', { name })}
      className="h-7 w-[4.5rem] px-2 text-xs pointer-coarse:h-11"
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setDraft(null)
        }
      }}
    />
  )
}

/**
 * Show, hide, reorder and size columns, and the display options (partial text length, full text, binary
 * mode, grid editing). The list scrolls and can be searched, so a table with 150 columns stays reachable
 * (UI-ISS-128). Everything is operable with the keyboard: the order is changed with buttons, not by drag only.
 */
export function ColumnMenu({
  columns,
  layout,
  onLayout,
  display,
  onDisplay,
  canEdit,
}: {
  columns: RowColumn[]
  layout: ColumnLayout
  onLayout: (next: ColumnLayout) => void
  display: DisplayPrefs
  onDisplay: (next: DisplayPrefs) => void
  /** False when editing is unavailable anyway (read-only connection, view): the switch is disabled. */
  canEdit: boolean
}) {
  const [query, setQuery] = useState('')
  const id = useId()
  const byName = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns])
  const q = query.trim().toLowerCase()
  const listed = layout.order.filter((name) => q === '' || name.toLowerCase().includes(q))
  const hiddenCount = layout.hidden.length

  return (
    <RowsPopover
      label={t('rows.grid.columns')}
      icon={<Columns3 size={14} strokeWidth={1.5} aria-hidden />}
      badge={hiddenCount > 0 ? <CountBadge>{`−${hiddenCount}`}</CountBadge> : undefined}
      align="right"
      widthClass="w-[min(380px,calc(100vw-32px))]"
    >
      {() => (
        <>
          <div className="flex flex-col gap-2 border-b border-rule p-3">
            <Input
              type="search"
              aria-label={t('rows.grid.columnSearch')}
              placeholder={t('rows.grid.columnSearch')}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="h-7 px-2 text-xs pointer-coarse:h-11"
                onClick={() => onLayout({ ...layout, hidden: [] })}
                disabled={hiddenCount === 0}
              >
                {t('rows.grid.showAll')}
              </Button>
              <Button
                className="h-7 px-2 text-xs pointer-coarse:h-11"
                onClick={() => onLayout(resetLayout(columns.map((c) => c.name)))}
              >
                {t('rows.grid.resetLayout')}
              </Button>
              <p className="ml-auto text-xs text-muted" aria-live="polite">
                {t('rows.grid.columnsShown', {
                  shown: layout.order.length - hiddenCount,
                  total: layout.order.length,
                })}
              </p>
            </div>
          </div>

          <ul
            aria-label={t('rows.grid.columns')}
            className="min-h-0 flex-1 overflow-auto px-1 py-1"
          >
            {listed.length === 0 && (
              <li className="px-2 py-3 text-sm text-muted">{t('rows.grid.noColumnMatch')}</li>
            )}
            {listed.map((name) => {
              const position = layout.order.indexOf(name)
              const hidden = layout.hidden.includes(name)
              const cid = `${id}-c-${position}`
              const column = byName.get(name)
              return (
                <li
                  key={name}
                  className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised"
                >
                  <Checkbox
                    id={cid}
                    checked={!hidden}
                    disabled={!canHide(layout, name)}
                    onChange={() => onLayout(toggleHidden(layout, name))}
                  />
                  <label
                    htmlFor={cid}
                    className="min-w-0 flex-1 text-sm"
                    title={column?.comment || undefined}
                  >
                    <span className="block truncate">{name}</span>
                    {column && (
                      <span className="block truncate text-xs text-muted">{column.fullType}</span>
                    )}
                  </label>
                  <WidthField
                    name={name}
                    value={layout.widths[name] ?? DEFAULT_COLUMN_WIDTH}
                    onCommit={(w) => onLayout(setColumnWidth(layout, name, w))}
                  />
                  <span className="flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11"
                      aria-label={t('rows.grid.moveUp', { name })}
                      disabled={position <= 0}
                      onClick={() => onLayout(moveColumn(layout, name, -1))}
                    >
                      <ArrowUp size={13} aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11"
                      aria-label={t('rows.grid.moveDown', { name })}
                      disabled={position >= layout.order.length - 1}
                      onClick={() => onLayout(moveColumn(layout, name, 1))}
                    >
                      <ArrowDown size={13} aria-hidden />
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>

          <fieldset className="flex flex-col gap-2.5 border-t border-rule p-3">
            <legend className="sr-only">{t('rows.grid.display')}</legend>
            <p className="text-xs font-medium text-muted">{t('rows.grid.display')}</p>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('rows.grid.displayChars')}</span>
              <Input
                type="number"
                inputMode="numeric"
                min={DISPLAY_CHARS_MIN}
                max={DISPLAY_CHARS_MAX}
                step={10}
                disabled={display.fullText}
                className="h-8 w-20 px-2 pointer-coarse:h-11"
                value={display.displayChars}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n) && e.target.value !== '')
                    onDisplay({ ...display, displayChars: clampDisplayChars(n) })
                }}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={display.fullText}
                onChange={(e) => onDisplay({ ...display, fullText: e.target.checked })}
              />
              {t('rows.grid.fullText')}
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('rows.grid.binaryMode')}</span>
              <Select
                compact
                className="w-auto pointer-coarse:h-11"
                value={display.protectBinary ? 'size' : 'hex'}
                onChange={(e) =>
                  onDisplay({ ...display, protectBinary: e.target.value === 'size' })
                }
              >
                <option value="hex">{t('rows.grid.binaryHex')}</option>
                <option value="size">{t('rows.grid.binarySize')}</option>
              </Select>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('rows.grid.relationMode')}</span>
              <Select
                compact
                className="w-auto pointer-coarse:h-11"
                value={display.relationMode}
                onChange={(e) =>
                  onDisplay({ ...display, relationMode: relationModeOf(e.target.value) })
                }
              >
                <option value="links">{t('rows.grid.relationLinks')}</option>
                <option value="full">{t('rows.grid.relationFull')}</option>
                <option value="none">{t('rows.grid.relationNone')}</option>
              </Select>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('rows.grid.stringOperator')}</span>
              <Select
                compact
                className="w-auto pointer-coarse:h-11"
                value={display.stringOperator}
                onChange={(e) =>
                  onDisplay({
                    ...display,
                    stringOperator: e.target.value === 'starts with' ? 'starts with' : 'contains',
                  })
                }
              >
                <option value="contains">{t('rows.grid.stringContains')}</option>
                <option value="starts with">{t('rows.grid.stringStartsWith')}</option>
              </Select>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={display.gridEditing}
                disabled={!canEdit}
                onChange={(e) => onDisplay({ ...display, gridEditing: e.target.checked })}
              />
              <span>
                <span className="block">{t('rows.grid.gridEditing')}</span>
                {!canEdit && (
                  <span className="block text-xs text-muted">{t('rows.grid.gridEditingOff')}</span>
                )}
              </span>
            </label>
          </fieldset>
        </>
      )}
    </RowsPopover>
  )
}
