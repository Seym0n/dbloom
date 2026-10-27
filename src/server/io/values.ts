/**
 * Value formatters of module `io` (FR-IO-005/006/007/023, spec 5.4): one cell, as the reader delivers it
 * (`IoCell`: exact text, Buffer for binary, null), becomes an SQL literal, a CSV cell text or a JSON value
 * per type kind. Pure functions; nothing here touches a connection.
 *
 * Choices where the spec leaves room:
 * - Buffers in CSV and JSON are `0x<hex>` (`0x` when empty), also for BIT and geometry.
 * - A BIT Buffer is written as `b'..'` in SQL (leading zeros dropped, at least one digit); a BIT given as text is
 *   taken as a decimal integer.
 * - A geometry cell is the HEX of the server's internal value; a Buffer or an all-hex string becomes `0x..`.
 */
import type { ColumnInfo, IoCell } from './types'

export type { ColumnInfo, IoCell } from './types'

export type SqlLiteralOptions = {
  /** The session has `NO_BACKSLASH_ESCAPES`: a backslash is a plain character and must not be doubled. */
  noBackslashEscapes?: boolean
}

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const HEX = /^(?:[0-9A-Fa-f]{2})*$/
const NUMERIC_KINDS = new Set(['int', 'decimal', 'float', 'year'])

export function hexOf(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')
}

function isBinaryColumn(col: ColumnInfo): boolean {
  return col.binary === true || col.kind === 'binary' || col.kind === 'blob'
}

/** `0x..` for any bytes; `0x` alone is not valid SQL, so callers handle the empty case. */
function bytesOf(cell: string | Buffer): Buffer {
  return typeof cell === 'string' ? Buffer.from(cell, 'utf8') : cell
}

// ---- SQL -----------------------------------------------------------------------------------------------

/**
 * String literal, correct with and without `NO_BACKSLASH_ESCAPES`. `'` is always doubled. With backslash
 * escapes `\` doubles, NUL becomes `\0` and CR becomes `\r`; without them NUL is spliced in with `CHAR(0)`.
 */
export function sqlString(value: string, opts: SqlLiteralOptions = {}): string {
  if (opts.noBackslashEscapes) {
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'"
    if (!value.includes('\u0000')) return quote(value)
    return 'CONCAT(' + value.split('\u0000').map(quote).join(',CHAR(0),') + ')'
  }
  return (
    "'" +
    value
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "''")
      .replaceAll('\u0000', '\\0')
      .replaceAll('\r', '\\r') +
    "'"
  )
}

export function sqlHex(b: Uint8Array): string {
  return b.byteLength === 0 ? "''" : '0x' + hexOf(b)
}

export function sqlBit(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += byte.toString(2).padStart(8, '0')
  s = s.replace(/^0+(?=.)/, '')
  return "b'" + (s === '' ? '0' : s) + "'"
}

export function sqlLiteral(cell: IoCell, col: ColumnInfo, opts: SqlLiteralOptions = {}): string {
  if (cell === null) return 'NULL'
  if (col.bit || col.kind === 'bit') {
    if (typeof cell !== 'string') return sqlBit(cell)
    return /^\d+$/.test(cell) ? cell : sqlString(cell, opts)
  }
  if (col.geometry || col.kind === 'geometry') {
    if (typeof cell !== 'string') return sqlHex(cell)
    return cell !== '' && HEX.test(cell) ? '0x' + cell : sqlString(cell, opts)
  }
  if (isBinaryColumn(col) || col.kind === 'unknown') {
    if (typeof cell !== 'string' || isBinaryColumn(col)) return sqlHex(bytesOf(cell))
  }
  if (typeof cell !== 'string') return sqlString(cell.toString('utf8'), opts)
  if (NUMERIC_KINDS.has(col.kind) && NUMERIC.test(cell)) return cell
  return sqlString(cell, opts)
}

// ---- CSV -------------------------------------------------------------------------------------------------

export type CsvCellOptions = {
  nullText: string
  /** FR-IO-023: prefix `'` to cells that start with = + - @ TAB CR. */
  neutraliseFormulas: boolean
  /** `keep` leaves breaks, `lf` turns CRLF and CR into LF (Excel preset), `remove` turns breaks into a space. */
  lineBreaks?: 'keep' | 'lf' | 'remove'
}

const FORMULA_START = /^[=+\-@\t\r]/

/** Plain text of one cell, before enclosure and escaping. NULL is `nullText`. */
export function csvCellText(cell: IoCell, col: ColumnInfo, opts: CsvCellOptions): string {
  if (cell === null) return opts.nullText
  let text: string
  if (typeof cell !== 'string') text = cell.byteLength === 0 ? '0x' : '0x' + hexOf(cell)
  else text = cell
  const numeric = NUMERIC_KINDS.has(col.kind) && NUMERIC.test(text)
  // Negative numerals in numeric columns are data, not formulas.
  if (opts.neutraliseFormulas && !numeric && FORMULA_START.test(text)) text = "'" + text
  if (opts.lineBreaks === 'lf') text = text.replace(/\r\n|\r/g, '\n')
  else if (opts.lineBreaks === 'remove') text = text.replace(/\r\n|\r|\n/g, ' ')
  return text
}

// ---- JSON ------------------------------------------------------------------------------------------------

export type JsonScalar = string | number | null

/** FR-IO-007: exact integers inside the IEEE double range stay numbers; BIGINT beyond it and DECIMAL are strings. */
export function jsonValue(cell: IoCell, col: ColumnInfo): JsonScalar {
  if (cell === null) return null
  if (typeof cell !== 'string') return cell.byteLength === 0 ? '0x' : '0x' + hexOf(cell)
  if (col.kind === 'int' || col.kind === 'year') {
    if (/^-?\d+$/.test(cell)) {
      const n = Number(cell)
      return Number.isSafeInteger(n) ? n : cell
    }
    return cell
  }
  if (col.kind === 'float') {
    if (NUMERIC.test(cell)) {
      const n = Number(cell)
      if (Number.isFinite(n)) return n
    }
    return cell
  }
  return cell
}
