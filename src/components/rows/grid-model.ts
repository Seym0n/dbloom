/** Pure helpers of the rows grid: sort list, column layout, totals, find in page, row keys (SPEC 24). */
import type {
  Cell,
  ColumnLayout,
  GuardValue,
  Identity,
  RowsTotal,
  SortEntry,
} from '~/server/rows/types'
import { MAX_SORT_ENTRIES } from '~/server/rows/types'

// ---- Sort (FR-ROW-006, FR-UIX-035) -----------------------------------------------------------------------

/**
 * Header click. Plain click: the column alone, ascending, then descending, then unsorted. Modifier click
 * (shift, ctrl, meta): the column is added to the sort list, flipped or removed, other columns stay.
 */
export function nextSortList(
  sort: readonly SortEntry[],
  column: string,
  additive: boolean,
): SortEntry[] {
  const at = sort.findIndex((s) => s.column === column)
  const current = at >= 0 ? sort[at] : undefined
  if (!additive) {
    if (!current || sort.length > 1) return [{ column, direction: 'asc' }]
    return current.direction === 'asc' ? [{ column, direction: 'desc' }] : []
  }
  if (!current) {
    return sort.length >= MAX_SORT_ENTRIES ? [...sort] : [...sort, { column, direction: 'asc' }]
  }
  if (current.direction === 'asc') {
    return sort.map((s, i) => (i === at ? { column, direction: 'desc' as const } : s))
  }
  return sort.filter((_, i) => i !== at)
}

// ---- Column layout (FR-ROW-010, DATA-ISS-114) ----------------------------------------------------------------

export const MIN_COLUMN_WIDTH = 64
export const MAX_COLUMN_WIDTH = 800
export const DEFAULT_COLUMN_WIDTH = 160

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COLUMN_WIDTH
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)))
}

/**
 * Applies a stored layout to the columns the table has now: entries of dropped columns go, new columns are
 * appended visible at the end, everything else is left untouched.
 */
export function reconcileLayout(
  stored: Partial<ColumnLayout> | undefined,
  names: readonly string[],
): ColumnLayout {
  const known = new Set(names)
  const order = (stored?.order ?? []).filter((n, i, all) => known.has(n) && all.indexOf(n) === i)
  const placed = new Set(order)
  for (const n of names) if (!placed.has(n)) order.push(n)
  const widths: Record<string, number> = {}
  for (const [name, width] of Object.entries(stored?.widths ?? {})) {
    if (known.has(name) && typeof width === 'number') widths[name] = clampWidth(width)
  }
  return { order, hidden: (stored?.hidden ?? []).filter((n) => known.has(n)), widths }
}

export function visibleOrder(layout: ColumnLayout): string[] {
  const hidden = new Set(layout.hidden)
  return layout.order.filter((n) => !hidden.has(n))
}

export function toggleHidden(layout: ColumnLayout, name: string): ColumnLayout {
  const hidden = layout.hidden.includes(name)
    ? layout.hidden.filter((n) => n !== name)
    : [...layout.hidden, name]
  return { ...layout, hidden }
}

export function moveColumn(layout: ColumnLayout, name: string, delta: -1 | 1): ColumnLayout {
  const at = layout.order.indexOf(name)
  const to = at + delta
  if (at < 0 || to < 0 || to >= layout.order.length) return layout
  const order = [...layout.order]
  const [item] = order.splice(at, 1)
  order.splice(to, 0, item!)
  return { ...layout, order }
}

export function setColumnWidth(layout: ColumnLayout, name: string, width: number): ColumnLayout {
  return { ...layout, widths: { ...layout.widths, [name]: clampWidth(width) } }
}

export function resetLayout(names: readonly string[]): ColumnLayout {
  return { order: [...names], hidden: [], widths: {} }
}

/** Never hide the last visible column: an empty grid would hide that it is a table at all. */
export function canHide(layout: ColumnLayout, name: string): boolean {
  if (layout.hidden.includes(name)) return true
  return visibleOrder(layout).length > 1
}

// ---- Totals and paging (FR-ROW-007) --------------------------------------------------------------------------

export type TotalText =
  { key: 'exact' | 'estimate' | 'lowerBound'; value: number } | { key: 'unknown' }

export function describeTotal(total: RowsTotal): TotalText {
  if (total.kind === 'unknown' || total.value === null) return { key: 'unknown' }
  return { key: total.kind, value: total.value }
}

/** The last page needs an exact total; otherwise its button explains why it is off. */
export function lastPageIndex(total: RowsTotal, pageSize: number): number | undefined {
  if (total.kind !== 'exact' || total.value === null) return undefined
  return Math.max(0, Math.ceil(total.value / pageSize) - 1)
}

export function pageCount(total: RowsTotal, pageSize: number): number | undefined {
  const last = lastPageIndex(total, pageSize)
  return last === undefined ? undefined : last + 1
}

export function rowRange(
  page: number,
  pageSize: number,
  rowsOnPage: number,
): { from: number; to: number } | undefined {
  if (rowsOnPage <= 0) return undefined
  return { from: page * pageSize + 1, to: page * pageSize + rowsOnPage }
}

export const AUTO_REFRESH_SECONDS = [0, 30, 60, 300, 1800] as const
export type AutoRefreshSeconds = (typeof AUTO_REFRESH_SECONDS)[number]

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

let requestCounter = 0
/** Request ids match `[A-Za-z0-9_-]{8,64}` (contracts). */
export function newRequestId(prefix = 'cnt'): string {
  requestCounter += 1
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18).padEnd(8, '0')
  return `${prefix}-${rand}-${requestCounter}`
}

// ---- Find in this page (FR-ROW-009, FR-UIX-055) --------------------------------------------------------------

/** Text a cell shows, for client-side matching. Cut values match on what was loaded. */
export function cellText(cell: Cell): string {
  if (cell === null) return ''
  if (typeof cell === 'string') return cell
  if ('binary' in cell) return `0x${cell.binary}`
  return cell.cut
}

export function rowMatches(row: readonly Cell[], needle: string): boolean {
  const n = needle.trim().toLowerCase()
  if (n === '') return true
  return row.some((cell) => cellText(cell).toLowerCase().includes(n))
}

/** Row indexes (into the page) that match; all of them when the needle is empty. */
export function matchingRows(rows: readonly (readonly Cell[])[], needle: string): number[] {
  const all: number[] = []
  rows.forEach((row, i) => {
    if (rowMatches(row, needle)) all.push(i)
  })
  return all
}

// ---- Row key (FR-ROW-004, FR-ROW-026) ------------------------------------------------------------------------

/** Binary cells carry the first 32 bytes only; a longer value cannot be a key. */
const MAX_BINARY_KEY_BYTES = 32

/**
 * Key of a row as guard values from the cells on the page, or undefined if any key cell cannot be taken as
 * it is (cut text, long binary) or the identity is none. The server re-checks it against the model.
 */
export function rowKeyOf(
  identity: Identity,
  columns: readonly string[],
  row: readonly Cell[],
): Record<string, GuardValue> | undefined {
  if (identity.kind === 'none') return undefined
  const key: Record<string, GuardValue> = {}
  for (const name of identity.columns) {
    const index = columns.indexOf(name)
    if (index < 0) return undefined
    const cell = row[index] ?? null
    if (cell === null) key[name] = { t: 'null' }
    else if (typeof cell === 'string') key[name] = { t: 'v', v: cell }
    else if ('binary' in cell) {
      if (cell.size > MAX_BINARY_KEY_BYTES) return undefined
      key[name] = { t: 'v', v: `0x${cell.binary}` }
    } else return undefined
  }
  return key
}

/** Longest text a cell shows is decided by the viewer; this says whether a viewer has more to show. */
export function isExpandable(cell: Cell, displayChars: number): boolean {
  if (cell === null) return false
  if (typeof cell === 'string') return cell.length > displayChars || /[\r\n\t]/.test(cell)
  return true
}

// ---- Display preferences (FR-ROW-010, 029) ------------------------------------------------------------------

export const DISPLAY_CHARS_MIN = 20
export const DISPLAY_CHARS_MAX = 1000

export type RelationMode = 'full' | 'links' | 'none'

export type DisplayPrefs = {
  displayChars: number
  fullText: boolean
  /** True: binary cells show their size only. False (default): `0x` preview of the first bytes and the size. */
  protectBinary: boolean
  gridEditing: boolean
  /** Foreign keys (FR-ROW-014): `full` shows the referenced row's name beside the key, `links` only a link, `none` neither. */
  relationMode: RelationMode
}

export function clampDisplayChars(n: number): number {
  if (!Number.isFinite(n)) return 100
  return Math.min(DISPLAY_CHARS_MAX, Math.max(DISPLAY_CHARS_MIN, Math.round(n)))
}

export function relationModeOf(value: unknown): RelationMode {
  return value === 'full' || value === 'none' ? value : 'links'
}

export function parseDisplayPrefs(
  values: Partial<Record<string, unknown>>,
  fallbackChars: number,
): DisplayPrefs {
  const chars = values['rows.displayChars']
  return {
    displayChars: clampDisplayChars(typeof chars === 'number' ? chars : fallbackChars),
    fullText: values['rows.fullText'] === true,
    protectBinary: values['rows.protectBinary'] === true,
    gridEditing: values['rows.gridEditing'] !== false,
    relationMode: relationModeOf(values['rows.relationMode']),
  }
}

export function parseSortPref(value: unknown, names: readonly string[]): SortEntry[] {
  if (!Array.isArray(value)) return []
  const out: SortEntry[] = []
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as SortEntry).column === 'string' &&
      names.includes((entry as SortEntry).column) &&
      ((entry as SortEntry).direction === 'asc' || (entry as SortEntry).direction === 'desc') &&
      out.length < MAX_SORT_ENTRIES &&
      !out.some((s) => s.column === (entry as SortEntry).column)
    ) {
      out.push({ column: (entry as SortEntry).column, direction: (entry as SortEntry).direction })
    }
  }
  return out
}
