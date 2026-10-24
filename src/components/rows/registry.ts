/**
 * Extension seam of module `rows` (SPEC/24-module-rows.md FR-ROW-031, task 0). Frozen: the grid renders a cell
 * through `renderCell(kind, cell, options)` and the form edits a value through the `ValueEditor` of its kind,
 * each looked up here. Slice 1 has built-in entries only (package D registers them); the later module
 * `transformations` adds entries without touching the grid or the form. No dynamic loading of code.
 */
import type { ReactNode } from 'react'
import type { Cell, GuardValue, RowColumn, TypeKind, WireValue } from '../../server/rows/types'

/** Display preferences a renderer may use (FR-ROW-010). */
export type CellDisplayOptions = {
  /** Characters shown in partial mode. */
  displayChars: number
  /** Full-text mode: show the whole loaded text. */
  fullText: boolean
  /** ProtectBinary: show `0x...` summary and size, never raw bytes. */
  protectBinary: boolean
  /** Session time zone label for `timestamp` kinds (FR-ROW-027). */
  timeZone?: string
  locale: string
}

/**
 * Pure function from a cell to React nodes. It must render data as text nodes only (FR-ROW-030): no
 * `dangerouslySetInnerHTML`, no links built from cell text.
 */
export type CellRenderer = (cell: Cell, column: RowColumn, options: CellDisplayOptions) => ReactNode

/** Value state of one form field (FR-ROW-016): the original server value, the current wire value, dirty flag. */
export type EditorValue = {
  original: Cell
  /** Digest of the stored value for columns compared by digest (FR-ROW-005). */
  digest?: string
  current: WireValue
  dirty: boolean
}

export type ValueEditorProps = {
  column: RowColumn
  value: EditorValue
  /** Called with the new wire value; the form recomputes `dirty` against the original. */
  onChange: (next: WireValue) => void
  disabled?: boolean
  /** Translated field-level message (FR-ROW-025). */
  error?: string
  /** DOM ids for the visible label and the description, for `aria-labelledby` / `aria-describedby`. */
  labelId: string
  describedById?: string
  /** Insert form (no stored value yet) or edit form. */
  mode: 'insert' | 'edit'
  locale: string
}

/** A React component (or a function returning nodes) that edits one field. */
export type ValueEditor = (props: ValueEditorProps) => ReactNode

/**
 * Turns an original cell into the guard value used for the conflict check (FR-ROW-005): text, null, or the
 * digest for columns compared by digest. Built-in for every kind; kept here so editors and forms share it.
 */
export type GuardValueOf = (column: RowColumn, original: Cell, digest?: string) => GuardValue

export type KindRegistry<T> = {
  get(kind: TypeKind): T
  /** Replaces the entry of a kind; a later module calls this at start-up. */
  register(kind: TypeKind, entry: T): void
  has(kind: TypeKind): boolean
}

/** A registry with a mandatory fallback, so an unknown kind always renders and never throws. */
export function createKindRegistry<T>(fallback: T): KindRegistry<T> {
  const entries = new Map<TypeKind, T>()
  return {
    get: (kind) => entries.get(kind) ?? fallback,
    register: (kind, entry) => {
      entries.set(kind, entry)
    },
    has: (kind) => entries.has(kind),
  }
}

/** Render a cell through the registry (FR-ROW-031). */
export function renderCell(
  registry: KindRegistry<CellRenderer>,
  column: RowColumn,
  cell: Cell,
  options: CellDisplayOptions,
): ReactNode {
  return registry.get(column.kind)(cell, column, options)
}
