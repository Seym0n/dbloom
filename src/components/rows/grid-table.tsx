import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Maximize2 } from 'lucide-react'
import { CellView, cellTitle } from '~/components/grid/cell-view'
import type { Cell, GetRowsResponse, RowColumn, SortEntry } from '~/server/rows/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { cellRenderers } from './cell-registry'
import type { CellContext, GridSnapshot, RowsGridHooks } from './grid-hooks'
import { clampWidth, isExpandable, type DisplayPrefs } from './grid-model'
import { HeaderCheckbox, RowCheckbox } from './selection'
import type { HeaderState, SelectionState } from './selection-model'
import {
  renderCell,
  type CellDisplayOptions,
  type KindRegistry,
  type CellRenderer,
} from './registry'

/**
 * `full` relation mode: the referenced row's name goes before the key, muted, so the key stays the last thing in
 * the cell and right-aligned keys keep one right edge down the column.
 */
function withRelation(context: CellContext, content: ReactNode): ReactNode {
  if (!context.relationDisplay) return content
  return (
    <>
      <span className="mr-2 font-sans text-muted">{context.relationDisplay}</span>
      {content}
    </>
  )
}

export const SELECT_COLUMN_WIDTH = 44
export const ACTIONS_COLUMN_WIDTH = 120

export type GridColumn = {
  name: string
  /** Index into `response.columns` and each row. */
  index: number
  model: RowColumn | undefined
  align: 'number' | 'temporal' | 'text'
  width: number
}

function ResizeHandle({
  name,
  width,
  onResize,
  onCommit,
}: {
  name: string
  width: number
  onResize: (name: string, width: number) => void
  onCommit: (name: string, width: number) => void
}) {
  const start = useRef<{ x: number; width: number } | null>(null)
  const latest = useRef(width)
  return (
    <span
      aria-hidden
      onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width }
        latest.current = width
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        latest.current = clampWidth(start.current.width + e.clientX - start.current.x)
        onResize(name, latest.current)
      }}
      onPointerUp={() => {
        if (!start.current) return
        start.current = null
        onCommit(name, latest.current)
      }}
      onPointerCancel={() => {
        start.current = null
        onResize(name, width)
      }}
      onDoubleClick={() => onCommit(name, clampWidth(160))}
      className="absolute top-0 right-0 z-[1] h-full w-2 cursor-col-resize touch-none select-none after:absolute after:top-2 after:right-0.5 after:bottom-2 after:w-px after:bg-border hover:after:bg-control pointer-coarse:w-3"
    />
  )
}

export type GridTableProps = {
  response: GetRowsResponse
  columns: GridColumn[]
  /** Visible row indexes (the find filter may hide rows), in display order. */
  rowIndexes: number[]
  sort: SortEntry[]
  onSort: (column: string, additive: boolean) => void
  onResize: (name: string, width: number) => void
  onResizeCommit: (name: string, width: number) => void
  selection: SelectionState
  headerState: HeaderState
  onToggleAll: () => void
  onToggleRow: (index: number, shift: boolean) => void
  display: DisplayPrefs
  locale: string
  renderers?: KindRegistry<CellRenderer>
  hooks: RowsGridHooks
  snapshot: GridSnapshot
  contextOf: (rowIndex: number, columnIndex: number) => CellContext
  focus: { r: number; c: number }
  onFocusCell: (r: number, c: number) => void
  editing: { r: number; c: number } | null
  onStartEdit: (r: number, c: number) => void
  renderEditor: (context: CellContext) => ReactNode
  onKeyDown: (event: KeyboardEvent<HTMLTableElement>) => void
  describedBy: string
  busy: boolean
  label: string
}

/**
 * The page as a real table with `role="grid"`. Cells are `td` with the classes of the earlier table view, so
 * numbers, dates and text keep one baseline; the selection cell is a row header (`th`) for the same reason.
 * Focus is roving: one cell has tabindex 0, the arrow keys move it (handled by the parent).
 */
export function GridTable(props: GridTableProps) {
  const { response, columns, rowIndexes, sort, display, hooks, snapshot } = props
  const renderers = props.renderers ?? cellRenderers
  const hasActions = Boolean(hooks.rowActions)
  const total =
    SELECT_COLUMN_WIDTH +
    columns.reduce((sum, c) => sum + c.width, 0) +
    (hasActions ? ACTIONS_COLUMN_WIDTH : 0)
  const options: CellDisplayOptions = {
    displayChars: display.displayChars,
    fullText: display.fullText,
    protectBinary: display.protectBinary,
    timeZone: response.timeZone,
    locale: props.locale,
  }

  return (
    <table
      role="grid"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      aria-rowcount={rowIndexes.length + 1}
      aria-colcount={columns.length + 1 + (hasActions ? 1 : 0)}
      aria-busy={props.busy || undefined}
      onKeyDown={props.onKeyDown}
      className="border-separate border-spacing-0 text-sm"
      style={{ tableLayout: 'fixed', width: total, minWidth: '100%' }}
    >
      <colgroup>
        <col style={{ width: SELECT_COLUMN_WIDTH }} />
        {columns.map((c) => (
          <col key={c.name} style={{ width: c.width }} />
        ))}
        {hasActions && <col style={{ width: ACTIONS_COLUMN_WIDTH }} />}
      </colgroup>
      <thead>
        <tr>
          <th
            scope="col"
            className="sticky top-0 z-10 border-b border-border bg-surface pl-6 text-left align-middle font-normal"
            style={{ height: 36 }}
          >
            <HeaderCheckbox state={props.headerState} onToggle={props.onToggleAll} />
          </th>
          {columns.map((col) => {
            const at = sort.findIndex((s) => s.column === col.name)
            const entry = at >= 0 ? sort[at] : undefined
            const comment = col.model?.comment
            const stamp = col.model?.kind === 'timestamp' ? response.timeZone : undefined
            return (
              <th
                key={col.name}
                scope="col"
                aria-sort={
                  entry?.direction === 'asc'
                    ? 'ascending'
                    : entry?.direction === 'desc'
                      ? 'descending'
                      : 'none'
                }
                title={comment ? `${col.name}: ${comment}` : undefined}
                className={cn(
                  'sticky top-0 z-10 border-b border-border bg-surface px-0 py-0 text-xs font-normal',
                  col.align === 'number' ? 'text-right' : 'text-left',
                )}
              >
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => props.onSort(col.name, e.shiftKey || e.ctrlKey || e.metaKey)}
                    className={cn(
                      'press flex h-9 w-full items-center gap-1 px-3 whitespace-nowrap text-muted hover:text-ink pointer-coarse:h-11',
                      col.align === 'number' && 'justify-end',
                    )}
                  >
                    <span className="truncate">{col.name}</span>
                    {stamp && <span className="shrink-0 text-faint">{stamp}</span>}
                    {entry?.direction === 'asc' && (
                      <ArrowUp size={12} aria-hidden className="shrink-0 text-ink" />
                    )}
                    {entry?.direction === 'desc' && (
                      <ArrowDown size={12} aria-hidden className="shrink-0 text-ink" />
                    )}
                    {entry && sort.length > 1 && (
                      <span
                        className="shrink-0 text-ink"
                        aria-label={t('rows.grid.sortOrder', { n: at + 1 })}
                      >
                        {at + 1}
                      </span>
                    )}
                  </button>
                  <ResizeHandle
                    name={col.name}
                    width={col.width}
                    onResize={props.onResize}
                    onCommit={props.onResizeCommit}
                  />
                </div>
              </th>
            )
          })}
          {hasActions && (
            <th
              scope="col"
              className="sticky top-0 z-10 border-b border-border bg-surface pr-6 text-right text-xs font-normal text-muted"
            >
              <span className="sr-only">{t('rows.grid.actions')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rowIndexes.map((rowIndex, position) => {
          const row = response.rows[rowIndex] ?? []
          const selected = props.selection.selected.has(rowIndex)
          return (
            <tr
              key={rowIndex}
              aria-rowindex={position + 2}
              aria-selected={selected}
              className={cn('group/row hover:bg-raised', selected && 'bg-active hover:bg-active')}
            >
              <th
                scope="row"
                className="border-b border-rule pl-6 text-left align-middle font-normal"
                style={{ height: 40 }}
              >
                <RowCheckbox
                  index={rowIndex}
                  checked={selected}
                  onToggle={(shift) => props.onToggleRow(rowIndex, shift)}
                />
              </th>
              {columns.map((col, c) => {
                const cell: Cell = row[col.index] ?? null
                const context = props.contextOf(rowIndex, col.index)
                const isFocus = props.focus.r === position && props.focus.c === c
                const isEditing = props.editing?.r === position && props.editing.c === c
                const expandable =
                  Boolean(hooks.onOpenCell) && isExpandable(cell, display.displayChars)
                const content = col.model ? (
                  renderCell(renderers, col.model, cell, options)
                ) : (
                  <CellView cell={cell} />
                )
                const title = cellTitle(cell, display)
                return (
                  <td
                    key={col.name}
                    role="gridcell"
                    data-r={position}
                    data-c={c}
                    aria-colindex={c + 2}
                    tabIndex={isFocus ? 0 : -1}
                    title={isEditing ? undefined : title}
                    onFocus={() => props.onFocusCell(position, c)}
                    onDoubleClick={() => props.onStartEdit(position, c)}
                    className={cn(
                      'group/cell relative overflow-hidden border-b border-rule px-3 pt-2.5 pb-0 align-baseline leading-5 text-ellipsis whitespace-nowrap focus-visible:outline-offset-[-2px]',
                      col.align === 'number' && 'text-right font-mono text-[13px]',
                      col.align === 'temporal' && 'font-mono text-[13px]',
                      isEditing && 'overflow-visible bg-surface p-0',
                    )}
                    style={{ height: 40 }}
                  >
                    {isEditing
                      ? props.renderEditor(context)
                      : hooks.decorateCell
                        ? hooks.decorateCell(context, withRelation(context, content))
                        : withRelation(context, content)}
                    {!isEditing && expandable && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t('rows.grid.openValue', { name: col.name })}
                        onClick={() => hooks.onOpenCell?.(context)}
                        className="press absolute top-1.5 right-1 hidden h-7 w-7 place-items-center rounded bg-surface text-muted border border-border hover:text-ink group-focus-within/cell:grid group-hover/cell:grid pointer-coarse:grid"
                      >
                        <Maximize2 size={12} aria-hidden />
                      </button>
                    )}
                  </td>
                )
              })}
              {hasActions && (
                <td
                  data-rows-actions
                  className="border-b border-rule pr-6 text-right align-middle"
                  style={{ height: 40 }}
                >
                  {hooks.rowActions?.({ rowIndex, row, snapshot })}
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
