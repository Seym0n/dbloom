/** Row selection of the grid: single, shift-click range, whole page (FR-ROW-019, FR-UIX-036, FR-UIX-054). */

export type SelectionState = {
  selected: ReadonlySet<number>
  /** Row the last plain toggle happened on; the start of a shift range. */
  anchor: number | null
}

export const emptySelection: SelectionState = { selected: new Set(), anchor: null }

/**
 * `order` is the visible row indexes in display order (the find filter may hide rows). A shift range
 * selects every visible row between the anchor and the target, anchor included.
 */
export function toggleRow(
  state: SelectionState,
  index: number,
  order: readonly number[],
  shift: boolean,
): SelectionState {
  const next = new Set(state.selected)
  const anchorAt = state.anchor === null ? -1 : order.indexOf(state.anchor)
  const targetAt = order.indexOf(index)
  if (shift && anchorAt >= 0 && targetAt >= 0) {
    const [lo, hi] = anchorAt < targetAt ? [anchorAt, targetAt] : [targetAt, anchorAt]
    for (let i = lo; i <= hi; i++) next.add(order[i]!)
    return { selected: next, anchor: state.anchor }
  }
  if (next.has(index)) next.delete(index)
  else next.add(index)
  return { selected: next, anchor: index }
}

export function selectPage(order: readonly number[]): SelectionState {
  return { selected: new Set(order), anchor: order[0] ?? null }
}

export function clearSelection(): SelectionState {
  return emptySelection
}

export type HeaderState = 'none' | 'some' | 'all'

export function headerState(state: SelectionState, order: readonly number[]): HeaderState {
  if (order.length === 0) return 'none'
  let count = 0
  for (const i of order) if (state.selected.has(i)) count += 1
  return count === 0 ? 'none' : count === order.length ? 'all' : 'some'
}

/** Header checkbox: anything selected clears it, nothing selected selects the visible page. */
export function toggleHeader(state: SelectionState, order: readonly number[]): SelectionState {
  return headerState(state, order) === 'all' ? emptySelection : selectPage(order)
}

/** Selected indexes that still exist on the page, ascending. */
export function selectedIndexes(state: SelectionState, rowCount: number): number[] {
  return [...state.selected].filter((i) => i >= 0 && i < rowCount).sort((a, b) => a - b)
}
