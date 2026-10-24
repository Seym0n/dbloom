/**
 * Pure logic and shared context of the row form, the value editors, the cell dialog and the pickers
 * (FR-ROW-003, 016, 018, 025). No React components here, so every rule can be unit-tested in node.
 *
 * The rule that keeps stored data safe (DATA-ISS-010): a field the user did not touch is never sent. A field
 * that is edited back to its original value is not dirty either.
 */
import { createContext } from 'react'
import type { MessageKey } from '~/i18n'
import type {
  Cell,
  FkInfo,
  FnName,
  GuardValue,
  Identity,
  RowColumn,
  RowTable,
  TypeKind,
  WireValue,
} from '~/server/rows/types'

// ---- Context given by the form, the cell dialog and the inline editor to everything below -------------------

export type LoadFullResult =
  { ok: true; text: string; digest?: string; truncated: boolean } | { ok: false; message: string }

export type RowFormContextValue = {
  db: string
  table: string
  model: RowTable | null
  /** `@@session.time_zone` resolved, shown next to timestamps (FR-ROW-027). */
  timeZone?: string
  /** Largest upload in bytes (`RowLimits.uploadBytes`). */
  uploadBytes: number
  /** Key of the row being edited; absent in the insert form. */
  rowKey?: Record<string, GuardValue>
  /** Loads the whole value of a cut cell of the row being edited (readCell), with its digest. */
  loadFull?: (column: RowColumn) => Promise<LoadFullResult>
  /** Outgoing foreign key of which `column` is the only column, for the picker. */
  singleFk?: (column: string) => FkInfo | undefined
  /** Opens the insert form of the referenced table; resolves with the new key or null (UI-ISS-110). */
  createReferenced?: (fk: FkInfo) => Promise<Record<string, string | null> | null>
}

export const DEFAULT_UPLOAD_BYTES = 8 * 1024 * 1024

export const RowFormContext = createContext<RowFormContextValue>({
  db: '',
  table: '',
  model: null,
  uploadBytes: DEFAULT_UPLOAD_BYTES,
})

// ---- Cells ---------------------------------------------------------------------------------------------------

export type PartialCell = { cut: string; length: number } | { binary: string; size: number }

export const isPartialCell = (cell: Cell): cell is PartialCell =>
  cell !== null && typeof cell !== 'string'

/** Largest binary value the grid sends whole (the first 32 bytes, skeleton behaviour). */
export const GRID_BINARY_BYTES = 32

export const isBinaryKind = (kind: TypeKind) => kind === 'binary' || kind === 'blob'

/** Columns compared by a digest of the stored value, not by `=` (FR-ROW-005). */
const DIGEST_KINDS: ReadonlySet<TypeKind> = new Set<TypeKind>(['float', 'json', 'geometry'])

/** True when the old value of this cell can only be guarded by the digest `readRow` / `readCell` returns. */
export function needsDigest(column: RowColumn, cell: Cell): boolean {
  if (DIGEST_KINDS.has(column.kind)) return true
  if (cell === null || typeof cell === 'string') return false
  if ('cut' in cell) return true
  return cell.size > GRID_BINARY_BYTES
}

export const isGenerated = (column: RowColumn) => column.generated !== undefined

export const hasDefault = (column: RowColumn) =>
  column.default.kind !== 'none' || column.autoIncrement

// ---- Wire values -----------------------------------------------------------------------------------------------

export const NULL_WIRE: WireValue = { t: 'null' }
export const DEFAULT_WIRE: WireValue = { t: 'default' }

export function wireEqual(a: WireValue, b: WireValue): boolean {
  if (a.t !== b.t) return false
  if (a.t === 'v' && b.t === 'v') return a.v === b.v
  if (a.t === 'fn' && b.t === 'fn') return a.name === b.name
  if (a.t === 'bin' && b.t === 'bin') return a.upload === b.upload
  return true
}

const stripBitWrapper = (v: string) => {
  const m = /^b'([01]*)'$/i.exec(v) ?? /^0b([01]+)$/i.exec(v)
  return m ? (m[1] ?? '') : v
}

/** `BIT(n)` in one format for read and edit: `b'...'` padded to n digits (DATA-ISS-129). */
export function formatBit(column: RowColumn, digits: string): string {
  const bits = column.length ?? 1
  return `b'${digits.padStart(bits, '0')}'`
}

/** The text of a cell as the editor shows it for a plain value; partial cells give what the grid has. */
export function editText(column: RowColumn, cell: Cell): string {
  if (cell === null) return ''
  if (typeof cell === 'string') {
    if (column.kind === 'bit') {
      const digits = stripBitWrapper(cell)
      return /^[01]*$/.test(digits) ? formatBit(column, digits) : cell
    }
    return cell
  }
  if ('cut' in cell) return cell.cut
  return cell.size <= GRID_BINARY_BYTES ? `0x${cell.binary.toUpperCase()}` : ''
}

/** The wire value that stands for "the value as stored". Never sent unless the field is dirty. */
export function initialWire(column: RowColumn, cell: Cell): WireValue {
  if (cell === null) return NULL_WIRE
  return { t: 'v', v: editText(column, cell) }
}

/**
 * Dirty flag (FR-ROW-016). A partial cell (cut text, long binary) has no known original, so it is dirty
 * only after the user changed it (`touched`); every other cell is dirty when it differs from the original.
 */
export function isDirty(
  column: RowColumn,
  original: Cell,
  current: WireValue,
  touched: boolean,
): boolean {
  const wholeBinary =
    original !== null &&
    typeof original === 'object' &&
    'binary' in original &&
    original.size <= GRID_BINARY_BYTES
  if (isPartialCell(original) && !wholeBinary) return touched
  return !wireEqual(initialWire(column, original), current)
}

/**
 * Guard value for the conflict check of one column, or null when the value cannot be compared (a digest
 * kind without a digest, a cut value, a binary value over 32 bytes without a digest).
 */
export function tryGuard(column: RowColumn, original: Cell, digest?: string): GuardValue | null {
  if (digest !== undefined && (DIGEST_KINDS.has(column.kind) || needsDigest(column, original))) {
    return { t: 'digest', v: digest }
  }
  if (needsDigest(column, original)) return null
  if (original === null) return { t: 'null' }
  const wire = initialWire(column, original)
  return wire.t === 'v' ? { t: 'v', v: wire.v } : { t: 'null' }
}

export const guardOf = (column: RowColumn, original: Cell, digest?: string): GuardValue =>
  tryGuard(column, original, digest) ?? { t: 'null' }

/** The guard values of every column that can be compared exactly (delete, FR-ROW-005). */
export function snapshotGuards(
  model: RowTable,
  columns: string[],
  cells: Cell[],
): Record<string, GuardValue> {
  const out: Record<string, GuardValue> = {}
  columns.forEach((name, i) => {
    const column = model.columns.find((c) => c.name === name)
    const cell = cells[i]
    if (!column || cell === undefined) return
    const guard = tryGuard(column, cell)
    if (guard) out[name] = guard
  })
  return out
}

/** The key values of one row for `readRow`, `readCell` and the writes; null when a key cell is cut. */
export function rowKeyOf(
  identity: Identity,
  model: RowTable,
  columns: string[],
  cells: Cell[],
): Record<string, GuardValue> | null {
  if (identity.kind === 'none') return null
  const key: Record<string, GuardValue> = {}
  for (const name of identity.columns) {
    const column = model.columns.find((c) => c.name === name)
    const index = columns.indexOf(name)
    const cell = index >= 0 ? cells[index] : undefined
    if (!column || cell === undefined) return null
    const guard = tryGuard(column, cell)
    if (!guard) return null
    key[name] = guard
  }
  return key
}

// ---- Initial state of a field --------------------------------------------------------------------------------

/** What an untouched field of the insert form starts as (FR-ROW-015, 018, DATA-ISS-124). */
export function insertInitial(column: RowColumn): WireValue {
  if (
    column.autoIncrement ||
    column.default.kind === 'literal' ||
    column.default.kind === 'expression'
  ) {
    return DEFAULT_WIRE
  }
  if (column.nullable) return NULL_WIRE
  if (column.kind === 'enum') return { t: 'v', v: column.members?.[0] ?? '' }
  return { t: 'v', v: '' }
}

/** An insert field is sent unless it still stands at DEFAULT, or at the NULL it started with. */
export function sendInInsert(column: RowColumn, initial: WireValue, current: WireValue): boolean {
  if (current.t === 'default') return false
  if (current.t === 'null' && initial.t === 'null') return false
  return !(column.generated !== undefined)
}

// ---- Functions the form may choose (FR-ROW-018) ----------------------------------------------------------------

export function functionsFor(column: RowColumn): FnName[] {
  switch (column.kind) {
    case 'datetime':
    case 'timestamp':
      return ['now', 'currentTimestamp6', 'utcTimestamp', 'currentDate']
    case 'date':
      return ['currentDate', 'now']
    case 'time':
      return ['now', 'utcTimestamp']
    case 'int':
      return ['unixTimestamp']
    case 'uuid':
      return ['uuid']
    case 'char':
      return (column.length ?? 0) >= 36 ? ['uuid'] : []
    default:
      return []
  }
}

// ---- Validation (FR-ROW-025, DATA-ISS-014) -----------------------------------------------------------------------

export type FieldError = { key: MessageKey; values?: Record<string, string | number> }

const INT_BITS: Record<string, number> = {
  tinyint: 8,
  smallint: 16,
  mediumint: 24,
  int: 32,
  integer: 32,
  bigint: 64,
}

export function intRange(column: RowColumn): { min: bigint; max: bigint } {
  const bits = BigInt(INT_BITS[column.baseType] ?? 64)
  if (column.unsigned) return { min: 0n, max: (1n << bits) - 1n }
  return { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n }
}

/** Integer from decimal or hex text (`0x10`, `X'10'`, DATA-ISS-108); null when it is neither. */
export function parseInteger(text: string): bigint | null {
  if (/^[+-]?\d+$/.test(text)) return BigInt(text.startsWith('+') ? text.slice(1) : text)
  const hex = /^0x([0-9a-f]+)$/i.exec(text) ?? /^x'([0-9a-f]+)'$/i.exec(text)
  return hex ? BigInt(`0x${hex[1]}`) : null
}

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

function checkFraction(column: RowColumn, fraction: string | undefined): FieldError | null {
  const fsp = column.fsp ?? 0
  if (fraction !== undefined && fraction.length > fsp) {
    return { key: 'rows.form.err.fraction', values: { fsp } }
  }
  return null
}

const inRange = (n: number, min: number, max: number) => n >= min && n <= max

function validateTemporal(column: RowColumn, v: string): FieldError | null {
  const kind = column.kind
  if (kind === 'year') {
    return /^\d{1,4}$/.test(v) ? null : { key: 'rows.form.err.year' }
  }
  if (kind === 'time') {
    const m = /^-?(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(v)
    if (!m) return { key: 'rows.form.err.time' }
    return checkFraction(column, m[4])
  }
  const datePart = /^(\d{4})-(\d{2})-(\d{2})$/
  if (kind === 'date') {
    const m = datePart.exec(v)
    if (!m) return { key: 'rows.form.err.date' }
    return inRange(Number(m[2]), 0, 12) && inRange(Number(m[3]), 0, 31)
      ? null
      : { key: 'rows.form.err.date' }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(v)
  if (!m) return { key: 'rows.form.err.datetime' }
  if (!inRange(Number(m[2]), 0, 12) || !inRange(Number(m[3]), 0, 31) || Number(m[4]) > 23) {
    return { key: 'rows.form.err.datetime' }
  }
  return checkFraction(column, m[7])
}

const TEXT_BYTE_LIMITS: Record<string, number> = {
  tinytext: 255,
  text: 65_535,
  mediumtext: 16_777_215,
  longtext: 4_294_967_295,
}

const characters = (v: string) => Array.from(v).length

/** Position of a JSON syntax error as line and column, 1-based, from the engine's message or the offset. */
export function jsonErrorPosition(text: string, error: unknown): { line: number; column: number } {
  const message = error instanceof Error ? error.message : ''
  const lc = /line (\d+) column (\d+)/i.exec(message)
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) }
  const pos = /position (\d+)/i.exec(message)
  const offset = pos ? Math.min(Number(pos[1]), text.length) : text.length
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - (before.lastIndexOf('\n') + 1) + 1
  return { line, column }
}

export function validateJson(text: string): FieldError | null {
  if (text.trim() === '') return { key: 'rows.form.err.jsonEmpty' }
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    const { line, column } = jsonErrorPosition(text, error)
    return { key: 'rows.form.err.json', values: { line, column } }
  }
}

const WKT = /^\s*(SRID=\d+;\s*)?[A-Za-z]+\s*(ZM|Z|M)?\s*(\(|EMPTY)/i

export function validateText(column: RowColumn, v: string): FieldError | null {
  switch (column.kind) {
    case 'int': {
      const n = parseInteger(v)
      if (n === null) return { key: 'rows.form.err.integer' }
      const { min, max } = intRange(column)
      return n < min || n > max
        ? { key: 'rows.form.err.range', values: { min: min.toString(), max: max.toString() } }
        : null
    }
    case 'decimal': {
      if (!DECIMAL.test(v)) return { key: 'rows.form.err.decimal' }
      const [whole = '', fraction = ''] = v.replace(/^[+-]/, '').split('.')
      const scale = column.scale ?? 0
      const precision = column.precision ?? 10
      if (fraction.length > scale) return { key: 'rows.form.err.scale', values: { scale } }
      const digits = whole.replace(/^0+/, '').length
      return digits > precision - scale
        ? { key: 'rows.form.err.precision', values: { digits: precision - scale } }
        : null
    }
    case 'float':
      return FLOAT.test(v) ? null : { key: 'rows.form.err.number' }
    case 'bit': {
      // Input forms of the server codec: b'..', 0b.., 0x.. or a plain decimal number ("101" is 101).
      const bits = column.length ?? 1
      const bin = /^b'([01]*)'$/i.exec(v) ?? /^0b([01]+)$/i.exec(v)
      let n: bigint | null = null
      if (bin) n = bin[1] ? BigInt('0b' + bin[1]) : 0n
      else if (/^0x[0-9a-f]+$/i.test(v) || /^\d+$/.test(v)) n = BigInt(v)
      if (n === null || n >= 1n << BigInt(bits))
        return { key: 'rows.form.err.bit', values: { bits } }
      return null
    }
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
    case 'year':
      return validateTemporal(column, v)
    case 'char':
    case 'text': {
      const limitBytes = TEXT_BYTE_LIMITS[column.baseType]
      if (limitBytes !== undefined) {
        const bytes = new TextEncoder().encode(v).length
        return bytes > limitBytes
          ? { key: 'rows.form.err.tooLongBytes', values: { max: limitBytes } }
          : null
      }
      if (column.length !== undefined && characters(v) > column.length) {
        return { key: 'rows.form.err.tooLong', values: { max: column.length } }
      }
      return null
    }
    case 'enum':
      return column.members?.includes(v) ? null : { key: 'rows.form.err.member' }
    case 'set': {
      if (v === '') return null
      const members = column.members ?? []
      return v.split(',').every((m) => members.includes(m)) ? null : { key: 'rows.form.err.member' }
    }
    case 'binary':
    case 'blob':
      return /^0x([0-9a-f]{2})*$/i.test(v) ? null : { key: 'rows.form.err.hex' }
    case 'json':
      return validateJson(v)
    case 'geometry':
      return WKT.test(v) ? null : { key: 'rows.form.err.geometry' }
    case 'uuid':
      return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v)
        ? null
        : { key: 'rows.form.err.uuid' }
    case 'inet6':
      return v.trim() === '' ? { key: 'rows.form.err.required' } : null
    case 'unknown':
      return { key: 'rows.form.err.unsupported' }
  }
}

/** Whether an empty text is acceptable for this kind (an empty string is a value, FR-ROW-018). */
const EMPTY_OK: ReadonlySet<TypeKind> = new Set<TypeKind>(['char', 'text', 'set', 'binary', 'blob'])

export function validateWire(column: RowColumn, wire: WireValue): FieldError | null {
  switch (wire.t) {
    case 'null':
      return column.nullable || column.autoIncrement ? null : { key: 'rows.form.err.notNull' }
    case 'default':
    case 'fn':
      return null
    case 'bin':
      return isBinaryKind(column.kind) ? null : { key: 'rows.form.err.unsupported' }
    case 'v':
      if (wire.v === '' && !EMPTY_OK.has(column.kind)) return { key: 'rows.form.err.required' }
      if (wire.v === '' && (column.kind === 'binary' || column.kind === 'blob')) return null
      return validateText(column, wire.v)
  }
}

// ---- Text helpers ------------------------------------------------------------------------------------------------------

/**
 * A textarea hands back LF only, even for a value with CR LF. After an edit the original line terminators
 * are put back by position, so editing one line of a Windows-style text keeps its CR LF (DATA-ISS-010, 115).
 */
export function restoreLineBreaks(original: string, next: string): string {
  const terminators = original.match(/\r\n|\n|\r/g)
  if (!terminators || !terminators.some((x) => x !== '\n')) return next
  const dominant = terminators[terminators.length - 1] ?? '\n'
  let index = 0
  return next.replace(/\n/g, () => terminators[index++] ?? dominant)
}

/** What a textarea shows and holds: LF only (its own normalisation, so React never fights the caret). */
export const toTextareaValue = (value: string) => value.replace(/\r\n?/g, '\n')

export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

export function compactJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return null
  }
}

// ---- Bytes and the hex view (FR-ROW-011) ----------------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '')
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const textToBytes = (text: string) => new TextEncoder().encode(text)

/** Classic dump: offset, 16 bytes in hex, printable ASCII. Read-only, never changes the value. */
export function hexDump(bytes: Uint8Array, maxBytes = 65_536): string {
  const shown = bytes.subarray(0, maxBytes)
  const lines: string[] = []
  for (let offset = 0; offset < shown.length; offset += 16) {
    const chunk = shown.subarray(offset, offset + 16)
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0'))
    const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${hex.join(' ').padEnd(47, ' ')}  ${ascii.join('')}`,
    )
  }
  return lines.join('\n')
}

// ---- Visible markers for control and special characters (UI-ISS-114) ------------------------------------------------------

export type MarkerKind = 'cr' | 'lf' | 'tab' | 'nbsp' | 'zeroWidth' | 'space' | 'control'
export type TextSegment = { text: string; marker?: { kind: MarkerKind; glyph: string } }

const MARKERS: Record<string, { kind: MarkerKind; glyph: string }> = {
  '\r': { kind: 'cr', glyph: '␍' },
  '\n': { kind: 'lf', glyph: '␊' },
  '\t': { kind: 'tab', glyph: '␉' },
  ' ': { kind: 'nbsp', glyph: '⍽' },
}

function markerFor(ch: string): { kind: MarkerKind; glyph: string } | undefined {
  const known = MARKERS[ch]
  if (known) return known
  const code = ch.codePointAt(0) ?? 0
  if ([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].includes(code))
    return { kind: 'zeroWidth', glyph: '·' }
  if (
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0x1680
  ) {
    return { kind: 'space', glyph: '␣' }
  }
  if (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xad
  ) {
    return { kind: 'control', glyph: '�' }
  }
  return undefined
}

const MAX_SEGMENTS = 20_000

/** Splits a text into plain runs and marked characters; a run of spaces stays a plain run, as typed. */
export function markControls(text: string): TextSegment[] {
  const out: TextSegment[] = []
  let run = ''
  for (const ch of text) {
    const marker = out.length < MAX_SEGMENTS ? markerFor(ch) : undefined
    if (marker) {
      if (run) out.push({ text: run })
      run = ''
      out.push({ text: ch, marker })
    } else {
      run += ch
    }
  }
  if (run) out.push({ text: run })
  return out
}

export function formatBytes(n: number, locale = 'en-US'): string {
  if (n < 1024) return `${new Intl.NumberFormat(locale).format(n)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = n
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`
}
