import type { Cell } from '~/server/db/rows'

export const numberFormat = new Intl.NumberFormat('en-US')

/**
 * One cell of a result grid, always as text nodes (SEC-TGT-112, FR-SQL-030): NULL, a string, a cut value
 * with its length, or a summarised binary value. Shared by the table browser and the SQL results.
 */
export function CellView({ cell }: { cell: Cell }) {
  if (cell === null) return <span className="text-faint">NULL</span>
  if (typeof cell === 'string') return <>{cell}</>
  if ('binary' in cell) {
    return (
      <span className="font-mono text-xs text-muted">
        0x{cell.binary.toUpperCase()}
        {cell.size > 32 ? '…' : ''}{' '}
        <span className="text-faint">({numberFormat.format(cell.size)} B)</span>
      </span>
    )
  }
  return (
    <>
      {cell.cut}
      <span className="text-faint">… ({numberFormat.format(cell.length)} chars)</span>
    </>
  )
}
