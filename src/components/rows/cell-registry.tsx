import { CellView } from '~/components/grid/cell-view'
import { createKindRegistry, type CellRenderer } from './registry'

/**
 * Fallback renderer of every kind (FR-ROW-031): NULL, text cut to the display length, `0x` preview or size
 * of binary values. Always text nodes, never HTML (FR-ROW-030). Package D registers richer entries.
 */
export const defaultCellRenderer: CellRenderer = (cell, _column, options) => (
  <CellView
    cell={cell}
    displayChars={options.displayChars}
    fullText={options.fullText}
    protectBinary={options.protectBinary}
  />
)

/** The grid's registry. `cellRenderers.register(kind, renderer)` adds or replaces a built-in entry. */
export const cellRenderers = createKindRegistry<CellRenderer>(defaultCellRenderer)
