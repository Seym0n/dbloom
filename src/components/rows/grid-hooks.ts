/**
 * Hook contract between the grid (package C) and the forms, editors and dialogs (package D), SPEC 24 section 13
 * (task 12: "inline editor in the grid cell, agreed hook with C"). The grid owns layout, focus, selection,
 * paging and the cache of the page; D plugs in through `RowsGridHooks` and never reaches into grid state.
 *
 * Rules: every callback is optional; with no hooks the grid is read-only. Cell content is rendered through
 * the kind registry of `registry.ts`; `decorateCell` only wraps it (for a link), it never replaces it.
 */
import type { ReactNode } from 'react'
import type {
  Cell,
  GetRowsResponse,
  GuardValue,
  Identity,
  RowColumn,
  RowPermissions,
  RowTable,
} from '~/server/rows/types'

/** Where one cell is, and everything an editor needs to know about it. Indexes are into the page response. */
export type CellContext = {
  rowIndex: number
  columnIndex: number
  columnName: string
  /** Absent only if the response and the model disagree; treat as read-only. */
  column: RowColumn | undefined
  cell: Cell
  row: Cell[]
  /** `response.columns`, aligned with `row`. */
  columns: string[]
  table: RowTable
  identity: Identity
  permissions: RowPermissions
  /**
   * Identity key of the row as guard values, or undefined when the identity is `none` or a key cell was cut or
   * is a binary value over 32 bytes. Binary key values are `0x`-prefixed hex.
   */
  key: Record<string, GuardValue> | undefined
  timeZone: string
}

/** Operations the grid offers to hooks. Stable for the life of the grid. */
export type GridControls = {
  /** Refetch the current page (keeps page, sort, filter, search). */
  refresh(): void
  /** Replace one row of the cached page with the re-read row (FR-ISS-110); `cells` align with `columns`. */
  replaceRow(rowIndex: number, cells: Cell[]): void
  /** Show the statement that ran under the grid ("SQL that ran"). */
  showStatement(sql: string): void
  clearSelection(): void
  /** Move keyboard focus to a cell (visible row position, visible column position). */
  focusCell(rowIndex: number, columnIndex: number): void
}

/** What toolbar slots and the Delete key see: the current page and the selection (page selection is the unit). */
export type GridSnapshot = {
  db: string
  table: string
  response: GetRowsResponse | undefined
  /** Selected row indexes into `response.rows`, ascending. */
  selectedIndexes: number[]
  selectedRows: Cell[][]
  /** Identity keys of the selected rows; a row whose key cannot be built (cut cell) is left out and counted. */
  selectedKeys: Record<string, GuardValue>[]
  unkeyedSelected: number
  controls: GridControls
  /** True while the user changes filter, sort or page: forms may disable themselves. */
  busy: boolean
}

export type CellEditContext = CellContext &
  GridControls & {
    /**
     * Leave edit mode. `move` continues to the next editable cell (Tab) or the same column one row down (Enter).
     * Call after a successful save or after the editor decided nothing changed.
     */
    finish(options?: { move?: 'next' | 'previous' | 'down' }): void
    /** Leave edit mode without a request (Esc). */
    cancel(): void
  }

export type RowsGridHooks = {
  /** Extra buttons in the toolbar (Insert, Delete selected, Edit selected, Export). */
  toolbar?: (snapshot: GridSnapshot) => ReactNode
  /** A trailing cell per row (Edit, Copy, Delete). Rendered as buttons, last column of the row. */
  rowActions?: (context: { rowIndex: number; row: Cell[]; snapshot: GridSnapshot }) => ReactNode
  /** Wrap rendered cell content, for instance in a foreign key `<a href>`. Must keep the content as text nodes. */
  decorateCell?: (context: CellContext, content: ReactNode) => ReactNode
  /** Whether Enter, F2 and double-click start editing here. Called with the grid-editing preference already on. */
  canEditCell?: (context: CellContext) => boolean
  /** The editor shown in place of the cell content while editing; it autofocuses itself. */
  renderEditor?: (context: CellEditContext) => ReactNode
  /** Open the cell viewer (FR-ROW-011): expand control, Shift+Enter. */
  onOpenCell?: (context: CellContext) => void
  /** The Delete key on a focused selection (UI-ISS-115). */
  onDeleteKey?: (snapshot: GridSnapshot) => void
  /** True while a form or cell is dirty: auto-refresh pauses (FR-ROW-028). */
  dirty?: boolean
}
