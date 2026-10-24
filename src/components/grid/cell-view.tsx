import type { Cell } from '~/server/db/rows'
import { t } from '~/i18n'

export const numberFormat = new Intl.NumberFormat('en-US')

/** Characters of the excerpt in the tooltip of a cut cell (UI-ISS-113). */
export const TOOLTIP_EXCERPT_CHARS = 200

export type CellViewOptions = {
  /** Partial mode: characters shown before the cut (FR-ROW-010). Absent: show what the server sent. */
  displayChars?: number
  /** Full-text mode: show everything that was loaded. */
  fullText?: boolean
  /** ProtectBinary: size only, no bytes. */
  protectBinary?: boolean
}

/** Cuts at a code point boundary so a surrogate pair is never split. */
export function cutText(text: string, chars: number): string {
  if (text.length <= chars) return text
  let end = chars
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** Length of the value and its leading excerpt, or undefined when the cell is shown whole. */
export function cellTitle(cell: Cell, options: CellViewOptions = {}): string | undefined {
  if (cell === null) return undefined
  if (typeof cell === 'string') {
    const limit = options.fullText ? Infinity : options.displayChars
    if (limit === undefined || cell.length <= limit) return undefined
    return t('rows.grid.cut', {
      length: numberFormat.format(cell.length),
      excerpt: cutText(cell, TOOLTIP_EXCERPT_CHARS),
    })
  }
  if ('binary' in cell) return t('rows.grid.binaryTitle', { size: numberFormat.format(cell.size) })
  return t('rows.grid.cut', {
    length: numberFormat.format(cell.length),
    excerpt: cutText(cell.cut, TOOLTIP_EXCERPT_CHARS),
  })
}

/**
 * One cell of a result grid, always as text nodes (SEC-TGT-112, FR-SQL-030): NULL, a string, a cut value
 * with its length, or a summarised binary value. Shared by the table browser and the SQL results.
 * The options are additive: without them the output is what the SQL tab always showed.
 */
export function CellView({ cell, ...options }: { cell: Cell } & CellViewOptions) {
  if (cell === null) return <span className="text-faint">NULL</span>
  if (typeof cell === 'string') {
    if (
      options.displayChars !== undefined &&
      !options.fullText &&
      cell.length > options.displayChars
    ) {
      return (
        <>
          {cutText(cell, options.displayChars)}
          <span className="text-faint">… ({numberFormat.format(cell.length)} chars)</span>
        </>
      )
    }
    return <>{cell}</>
  }
  if ('binary' in cell) {
    if (options.protectBinary) {
      return (
        <span className="text-muted">
          {t('rows.grid.binary')}{' '}
          <span className="text-faint">({numberFormat.format(cell.size)} B)</span>
        </span>
      )
    }
    return (
      <span className="font-mono text-xs text-muted">
        0x{cell.binary.toUpperCase()}
        {cell.size > 32 ? '…' : ''}{' '}
        <span className="text-faint">({numberFormat.format(cell.size)} B)</span>
      </span>
    )
  }
  const shown =
    options.displayChars !== undefined && !options.fullText
      ? cutText(cell.cut, options.displayChars)
      : cell.cut
  return (
    <>
      {shown}
      <span className="text-faint">… ({numberFormat.format(cell.length)} chars)</span>
    </>
  )
}
