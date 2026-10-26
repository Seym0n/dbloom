/**
 * Value codecs of module `rows` (FR-ROW-003, spec 5.3): per type kind the read projection (what the SELECT
 * list asks the server for and how the answer becomes a `Cell`), the write form (validation and the `?`
 * parameter), the guard comparison used in WHERE (FR-ROW-005) and the digest rule. One table in code, so the
 * read and the write side of a kind cannot drift apart.
 *
 * Numbers are decimal strings, never JS numbers; BIT is written as a big-endian Buffer; FLOAT is read through
 * `CAST(col AS CHAR)` because the binary protocol widens a 32-bit float to a double. No value is ever put into
 * SQL text: the only literals here are fixed fragments and integers taken from the catalog model.
 */
import { quoteIdent as q } from '../db/identifiers'
import { BuildRefusal } from '../structure/types'
import type {
  Cell,
  FnName,
  GuardValue,
  RowColumn,
  RowRefusalCode,
  TypeKind,
  WireValue,
} from './types'

// ---- Errors ------------------------------------------------------------------------------------------------

/** A refusal before any statement exists (`RowRefusalCode`); `field` names the column the message is about. */
export class RowValueError extends BuildRefusal {
  constructor(
    code: RowRefusalCode,
    message: string,
    public field?: string,
    public rowIndex?: number,
  ) {
    super(code, message)
    this.name = 'RowValueError'
  }
}

function bad(col: RowColumn, message: string, code: RowRefusalCode = 'invalid-value'): never {
  throw new RowValueError(code, `${col.name}: ${message}`, col.name)
}

// ---- Shared small types --------------------------------------------------------------------------------------

/** Values that can be bound: text, bytes or NULL. Numbers travel as decimal strings. */
export type Param = string | Buffer | null

/** SQL text with `?` placeholders and the values for them, in order. */
export type SqlFragment = { sql: string; params: Param[] }

/** A value ready for a statement: `?`, `DEFAULT`, a fixed function template or `ST_GeomFromText(?, ?)`. */
export type EncodedValue = SqlFragment

export type ValueMode =
  /** Full validation: length, range, scale, membership. */
  | 'write'
  /** Filter values: syntax, range and membership. */
  | 'filter'
  /** Old and key values from the editor: syntax only. */
  | 'guard'

// ---- Kind helpers ---------------------------------------------------------------------------------------------

export function isWritable(col: RowColumn): boolean {
  return col.kind !== 'unknown' && col.generated === undefined
}

export function isTextKind(kind: TypeKind): boolean {
  return kind === 'char' || kind === 'text' || kind === 'enum' || kind === 'set'
}

/**
 * Columns compared by SHA-256 digest instead of by value (FR-ROW-005): float, JSON, geometry and the large
 * BLOB/TEXT types (over 64 KiB declared).
 */
export function usesDigest(col: RowColumn): boolean {
  if (col.kind === 'float' || col.kind === 'json' || col.kind === 'geometry') return true
  if (col.kind === 'text') return col.baseType === 'mediumtext' || col.baseType === 'longtext'
  if (col.kind === 'blob') return col.baseType === 'mediumblob' || col.baseType === 'longblob'
  return false
}

function digestAllowed(col: RowColumn): boolean {
  return usesDigest(col) || col.kind === 'text' || col.kind === 'blob' || col.kind === 'binary'
}

/** `SHA2(...)` of the stored bytes; equals the SHA-256 of the text `CAST(col AS CHAR)` returns (spike 0b). */
export function digestExpr(col: RowColumn): string {
  const c = q(col.name)
  return col.kind === 'geometry'
    ? `SHA2(ST_AsBinary(${c}), 256)`
    : `SHA2(CAST(${c} AS BINARY), 256)`
}

/** Column left-hand side of a comparison (BIT compares as its unsigned number). */
export function compareLhs(col: RowColumn): string {
  const c = q(col.name)
  return col.kind === 'bit' ? `(${c} + 0)` : c
}

const CHARSET_NAME = /^[a-z0-9_]+$/

/**
 * Placeholder of a text parameter that is compared as bytes with the column: the parameter arrives as
 * utf8mb4, so for any other column charset it is converted to that charset first (verified on both servers).
 */
export function bytesParam(col: RowColumn): string {
  const cs = col.charset?.toLowerCase()
  if (cs === undefined || cs === 'utf8mb4' || cs === 'binary') return 'CAST(? AS BINARY)'
  if (!CHARSET_NAME.test(cs)) bad(col, 'unsupported character set')
  return `CAST(CONVERT(? USING ${cs}) AS BINARY)`
}

/** Left-hand side for an exact (case and padding sensitive) comparison of a text column. */
export function bytesLhs(col: RowColumn): string {
  return `CAST(${q(col.name)} AS BINARY)`
}

/** Escapes `!`, `%` and `_` for `LIKE ... ESCAPE '!'`. */
export function likeEscape(text: string): string {
  return text.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')
}

// ---- Parsing and validation ----------------------------------------------------------------------------------

const INT_BITS: Record<string, number> = {
  tinyint: 8,
  smallint: 16,
  mediumint: 24,
  int: 32,
  integer: 32,
  bigint: 64,
}

const HEX_INT = /^(?:0x([0-9a-f]+)|x'([0-9a-f]+)')$/i
const DEC_INT = /^[+-]?\d+$/

function parseInteger(col: RowColumn, text: string): bigint {
  const hex = HEX_INT.exec(text)
  if (hex) return BigInt('0x' + (hex[1] ?? hex[2]!))
  if (DEC_INT.test(text)) return BigInt(text)
  return bad(col, 'not an integer')
}

function checkIntRange(col: RowColumn, n: bigint): void {
  const bits = INT_BITS[col.baseType]
  if (bits === undefined) return
  const b = BigInt(bits)
  const [min, max] = col.unsigned
    ? [0n, (1n << b) - 1n]
    : [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n]
  if (n < min || n > max) bad(col, `value out of range (${min} to ${max})`)
}

function parseDecimal(col: RowColumn, text: string, strict: boolean): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return bad(col, 'not a decimal number')
  const neg = m[1] === '-'
  const int = (m[2] ?? '').replace(/^0+(?=\d)/, '')
  let frac = m[3] ?? ''
  const scale = col.scale
  if (strict && scale !== undefined) {
    // Extra digits are tolerated only when they are zeros; the value is never rounded.
    const extra = frac.slice(scale)
    if (/[^0]/.test(extra)) bad(col, `more than ${scale} decimal places`)
    frac = frac.slice(0, scale)
    const maxInt = (col.precision ?? 65) - scale
    if (int.replace(/^0+/, '').length > maxInt)
      bad(col, `more than ${maxInt} digits before the point`)
  }
  const isZero = !/[1-9]/.test(int + frac)
  if (neg && !isZero && col.unsigned) bad(col, 'value must not be negative')
  return `${neg && !isZero ? '-' : ''}${int === '' ? '0' : int}${frac !== '' ? '.' + frac : ''}`
}

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function parseFloatText(col: RowColumn, text: string): string {
  if (!FLOAT_RE.test(text)) return bad(col, 'not a number')
  const n = Number(text)
  if (!Number.isFinite(n)) bad(col, 'number out of range')
  if (col.baseType === 'float' && Math.abs(n) > 3.4028235e38) bad(col, 'number out of range')
  return text.startsWith('+') ? text.slice(1) : text
}

const BIT_TEXT = /^(?:b'([01]*)'|0b([01]+))$/i

function parseBit(col: RowColumn, text: string): bigint {
  const bin = BIT_TEXT.exec(text)
  let n: bigint
  if (bin) {
    const digits = bin[1] ?? bin[2] ?? ''
    n = digits === '' ? 0n : BigInt('0b' + digits)
  } else {
    const hex = HEX_INT.exec(text)
    if (hex) n = BigInt('0x' + (hex[1] ?? hex[2]!))
    else if (/^\d+$/.test(text)) n = BigInt(text)
    else return bad(col, "not a bit value (use b'0101', 0x.. or a number)")
  }
  const width = col.length ?? 64
  if (n >= 1n << BigInt(width)) bad(col, `value does not fit in ${width} bits`)
  return n
}

/** Big-endian bytes of `n` in `ceil(width / 8)` bytes (the value of `b'...'`). */
export function bitBuffer(n: bigint, width: number): Buffer {
  const size = Math.max(1, Math.ceil(width / 8))
  const buf = Buffer.alloc(size)
  let v = n
  for (let i = size - 1; i >= 0; i--) {
    buf[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return buf
}

const DATE_RE = /^\d{4}-(?:0\d|1[0-2])-(?:[0-2]\d|3[01])$/
const TIME_RE = /^-?\d{1,3}:[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/
const DATETIME_RE =
  /^\d{4}-(?:0\d|1[0-2])-(?:[0-2]\d|3[01])(?:[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?)?$/

function checkTemporal(col: RowColumn, text: string): string {
  const ok =
    col.kind === 'date'
      ? DATE_RE.test(text)
      : col.kind === 'time'
        ? TIME_RE.test(text) && Math.abs(Number(text.split(':')[0])) <= 838
        : col.kind === 'year'
          ? /^\d{1,4}$/.test(text)
          : DATETIME_RE.test(text)
  if (!ok) {
    const hint =
      col.kind === 'date'
        ? 'YYYY-MM-DD'
        : col.kind === 'time'
          ? '[-]HH:MM:SS[.ffffff]'
          : col.kind === 'year'
            ? 'YYYY'
            : 'YYYY-MM-DD[ HH:MM:SS[.ffffff]]'
    bad(col, `expected ${hint}`)
  }
  return text
}

const HEX_BYTES = /^(?:0x([0-9a-f]*)|x'([0-9a-f]*)')$/i

/** `0x...` or `X'...'` to bytes; an odd digit count is refused, not padded. */
export function parseHexBytes(col: RowColumn, text: string): Buffer {
  const m = HEX_BYTES.exec(text)
  const digits = m ? (m[1] ?? m[2] ?? '') : ''
  if (!m || digits.length % 2 !== 0) {
    return bad(col, 'expected hexadecimal bytes such as 0x7F000001')
  }
  return Buffer.from(digits, 'hex')
}

function parseSrid(col: RowColumn, text: string): { wkt: string; srid: number } {
  const m = /^SRID=(\d{1,10});(.*)$/is.exec(text)
  const wkt = m ? m[2]! : text
  if (wkt.trim() === '') bad(col, 'empty geometry')
  const srid = m ? Number(m[1]) : (col.srid ?? 0)
  if (srid > 4294967295) bad(col, 'SRID out of range')
  return { wkt, srid }
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const INET6_RE = /^[0-9a-f:.]{2,45}$/i

const TEXT_BYTE_LIMIT: Record<string, number> = {
  tinytext: 255,
  text: 65535,
  mediumtext: 16777215,
  longtext: 4294967295,
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function checkString(col: RowColumn, v: string): void {
  if (LONE_SURROGATE.test(v)) bad(col, 'contains an invalid character')
}

function charCount(v: string): number {
  let n = 0
  for (const ch of v) {
    void ch
    n++
  }
  return n
}

/**
 * Validates `text` for `col` and returns the bound value. `write` is the strict mode of FR-ROW-025. The BIT
 * value is a Buffer for writes and a decimal string for comparisons (the comparison uses `col + 0`).
 */
export function parseText(col: RowColumn, text: string, mode: ValueMode): Param {
  checkString(col, text)
  const strict = mode === 'write'
  switch (col.kind) {
    case 'int': {
      const n = parseInteger(col, text)
      checkIntRange(col, n)
      return n.toString()
    }
    case 'decimal':
      return parseDecimal(col, text, strict || mode === 'filter')
    case 'float':
      return parseFloatText(col, text)
    case 'bit': {
      const n = parseBit(col, text)
      return strict ? bitBuffer(n, col.length ?? 64) : n.toString()
    }
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
    case 'year':
      return checkTemporal(col, text)
    case 'char': {
      if (strict && col.length !== undefined && charCount(text) > col.length) {
        bad(col, `longer than ${col.length} characters`)
      }
      return text
    }
    case 'text': {
      const limit = TEXT_BYTE_LIMIT[col.baseType]
      const cs = col.charset?.toLowerCase()
      if (strict && limit !== undefined && (cs === undefined || cs.startsWith('utf8'))) {
        if (Buffer.byteLength(text, 'utf8') > limit) bad(col, `longer than ${limit} bytes`)
      }
      return text
    }
    case 'enum': {
      if (mode !== 'guard' && col.members && !col.members.includes(text)) {
        bad(col, 'not one of the allowed values')
      }
      return text
    }
    case 'set': {
      if (mode !== 'guard' && col.members && text !== '') {
        const parts = text.split(',')
        if (parts.some((p) => !col.members!.includes(p))) bad(col, 'not one of the allowed values')
      }
      return text
    }
    case 'binary':
    case 'blob': {
      const buf = parseHexBytes(col, text)
      if (strict && col.kind === 'binary' && col.length !== undefined && buf.length > col.length) {
        bad(col, `longer than ${col.length} bytes`)
      }
      return buf
    }
    case 'json': {
      if (strict) {
        try {
          JSON.parse(text)
        } catch (e) {
          return bad(col, `invalid JSON (${(e as Error).message})`)
        }
      }
      return text
    }
    case 'geometry':
      return parseSrid(col, text).wkt
    case 'uuid':
      if (!UUID_RE.test(text)) bad(col, 'not a UUID')
      return text
    case 'inet6':
      if (!INET6_RE.test(text)) bad(col, 'not an IPv6 address')
      return text
    case 'unknown':
      return bad(col, 'This type is not supported for editing', 'not-editable')
  }
}

// ---- Write form --------------------------------------------------------------------------------------------------

const FN_TEMPLATES: Record<FnName, string> = {
  now: 'NOW()',
  currentTimestamp6: 'CURRENT_TIMESTAMP(6)',
  utcTimestamp: 'UTC_TIMESTAMP()',
  currentDate: 'CURRENT_DATE()',
  unixTimestamp: 'UNIX_TIMESTAMP()',
  uuid: 'UUID()',
}

/** Which kinds accept which function (FR-ROW-018); the list is fixed, `RAND()` and friends are not in it. */
const FN_KINDS: Record<FnName, TypeKind[]> = {
  now: ['datetime', 'timestamp', 'date', 'time'],
  currentTimestamp6: ['datetime', 'timestamp'],
  utcTimestamp: ['datetime', 'timestamp'],
  currentDate: ['date', 'datetime', 'timestamp'],
  unixTimestamp: ['int', 'decimal'],
  uuid: ['uuid', 'char'],
}

export type EncodeOptions = {
  /** Bytes of an upload staged by the caller (FR-ROW-012); undefined when the id is unknown. */
  resolveUpload?: (id: string) => Buffer | undefined
}

/** Validates one wire value for a column and returns the SQL piece and parameters (FR-ROW-003). */
export function encodeWire(
  col: RowColumn,
  wire: WireValue,
  options: EncodeOptions = {},
): EncodedValue {
  if (col.generated !== undefined) bad(col, 'generated columns cannot be written', 'not-editable')
  if (col.kind === 'unknown') bad(col, 'This type is not supported for editing', 'not-editable')
  switch (wire.t) {
    case 'null':
      return { sql: '?', params: [null] }
    case 'default':
      return { sql: 'DEFAULT', params: [] }
    case 'fn': {
      if (!FN_KINDS[wire.name].includes(col.kind)) bad(col, `function ${wire.name} does not fit`)
      return { sql: FN_TEMPLATES[wire.name], params: [] }
    }
    case 'bin': {
      if (col.kind !== 'binary' && col.kind !== 'blob') {
        bad(col, 'a file can only go into a binary column')
      }
      const bytes = options.resolveUpload?.(wire.upload)
      if (!bytes) throw new RowValueError('unknown-upload', `${col.name}: unknown upload`, col.name)
      if (col.kind === 'binary' && col.length !== undefined && bytes.length > col.length) {
        bad(col, `longer than ${col.length} bytes`)
      }
      return { sql: '?', params: [bytes] }
    }
    case 'v': {
      if (col.kind === 'geometry') {
        const { wkt, srid } = parseSrid(col, wire.v)
        checkString(col, wkt)
        return { sql: 'ST_GeomFromText(?, ?)', params: [wkt, String(srid)] }
      }
      return { sql: '?', params: [parseText(col, wire.v, 'write')] }
    }
  }
}

// ---- Guard comparison (key and old values) ------------------------------------------------------------------

/**
 * One WHERE condition for a key or old value (FR-ROW-004, 005). `key` uses plain `=` so an index serves it (a
 * unique key bounds the match); `old` compares exactly: null-safe, text as bytes (so PAD SPACE collations
 * cannot hide a change), float, JSON, geometry and large values by digest. The SQL text is the same for a
 * NULL and for a value of the same column, so statements of one shape share the server's statement cache.
 */
export function guardCondition(col: RowColumn, g: GuardValue, mode: 'key' | 'old'): SqlFragment {
  if (col.kind === 'unknown') bad(col, 'This type cannot be compared', 'not-editable')
  const op = mode === 'key' ? '=' : '<=>'
  if (mode === 'key' && g.t === 'null') bad(col, 'a key value must not be NULL')
  if (g.t === 'digest') {
    if (!digestAllowed(col)) bad(col, 'this column is not compared by digest')
    return { sql: `${digestExpr(col)} ${op} ?`, params: [g.v] }
  }
  if (usesDigest(col)) {
    if (g.t === 'null') return { sql: `${digestExpr(col)} ${op} ?`, params: [null] }
    bad(col, 'this column is compared by digest')
  }
  const lhs = compareLhs(col)
  if (g.t === 'null') {
    return mode === 'old' && isTextKind(col.kind)
      ? { sql: `${bytesLhs(col)} <=> ${bytesParam(col)}`, params: [null] }
      : { sql: `${lhs} ${op} ?`, params: [null] }
  }
  const value = parseText(col, g.v, 'guard')
  if (mode === 'old' && isTextKind(col.kind)) {
    return { sql: `${bytesLhs(col)} <=> ${bytesParam(col)}`, params: [value] }
  }
  return { sql: `${lhs} ${op} ?`, params: [value] }
}

// ---- Read projection --------------------------------------------------------------------------------------------

export type ReadOptions = {
  /** Largest value of one cell the server sends (ST-115). */
  cellBytes: number
  /**
   * Also ask for the full length of long text; default true. The length is read only where the value can be
   * cut (`OCTET_LENGTH` is the stored size and cheap, `CHAR_LENGTH` scans multi-byte text), see spec 5.3.
   */
  lengths?: boolean
}

export type Projection = {
  /** SELECT list items, no parameters. */
  exprs: string[]
  /** Turns the values of those items (in order) into a cell. */
  decode: (raw: unknown[]) => Cell
}

const numberOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (Buffer.isBuffer(v)) return v.toString('utf8')
  if (v !== null && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** `CHAR_LENGTH(expr)` evaluated only for values whose byte size exceeds the limit; NULL for the others. */
const lengthIfCut = (expr: string, limit: number) =>
  `CASE WHEN OCTET_LENGTH(${expr}) > ${limit} THEN CHAR_LENGTH(${expr}) END`

/** `full` is the character count where the SQL read it, null or undefined when the text is whole. */
function textCell(text: string, full: number | null | undefined, limit: number): Cell {
  const length = full ?? charCount(text)
  if (length <= limit) return text
  return { cut: Array.from(text).slice(0, limit).join(''), length }
}

/** The grid projection of one column (spec 5.3): big values never cross the wire whole. */
export function projectionFor(col: RowColumn, opts: ReadOptions): Projection {
  const c = q(col.name)
  const lengths = opts.lengths !== false
  const n = Math.max(1, Math.trunc(opts.cellBytes))
  switch (col.kind) {
    case 'float':
    case 'unknown':
      return {
        exprs: [`CAST(${c} AS CHAR)`],
        decode: (r) => (r[0] === null ? null : textCell(str(r[0]), undefined, n)),
      }
    case 'bit': {
      const width = Math.max(1, Math.trunc(col.length ?? 64))
      return {
        exprs: [`LPAD(BIN(${c} + 0), ${width}, '0')`],
        decode: (r) => (r[0] === null ? null : `b'${str(r[0])}'`),
      }
    }
    case 'binary':
    case 'blob':
      return {
        exprs: [`SUBSTRING(${c}, 1, 32)`, `OCTET_LENGTH(${c})`],
        decode: (r) =>
          r[0] === null
            ? null
            : { binary: Buffer.from(r[0] as Buffer).toString('hex'), size: Number(r[1]) },
      }
    case 'char':
    case 'text':
    case 'json':
      return {
        exprs: lengths ? [`LEFT(${c}, ${n + 1})`, lengthIfCut(c, n)] : [`LEFT(${c}, ${n + 1})`],
        decode: (r) =>
          r[0] === null ? null : textCell(str(r[0]), lengths ? numberOrNull(r[1]) : undefined, n),
      }
    case 'geometry': {
      const wkt = `ST_AsText(${c})`
      // MariaDB keeps the SRID per value and the catalog has no column SRID: carry it in the text.
      const withSrid = col.srid === undefined
      return {
        exprs: [
          `LEFT(${wkt}, ${n + 1})`,
          ...(lengths ? [lengthIfCut(wkt, n)] : []),
          ...(withSrid ? [`ST_SRID(${c})`] : []),
        ],
        decode: (r) => {
          if (r[0] === null) return null
          const srid = withSrid ? Number(r[lengths ? 2 : 1]) : 0
          const prefix = srid > 0 ? `SRID=${srid};` : ''
          const full = lengths ? numberOrNull(r[1]) : undefined
          return textCell(prefix + str(r[0]), full == null ? full : full + prefix.length, n)
        },
      }
    }
    case 'year':
      return { exprs: [c], decode: (r) => (r[0] === null ? null : str(r[0]).padStart(4, '0')) }
    case 'time':
    case 'datetime':
    case 'timestamp':
      // The binary protocol drops a zero fraction ('00:00:00' for a TIME(3)); CAST keeps the column's digits.
      return col.fsp
        ? { exprs: [`CAST(${c} AS CHAR)`], decode: (r) => (r[0] === null ? null : str(r[0])) }
        : { exprs: [c], decode: (r) => (r[0] === null ? null : str(r[0])) }
    case 'int':
    case 'decimal':
    case 'date':
    case 'enum':
    case 'set':
    case 'uuid':
    case 'inet6':
      return { exprs: [c], decode: (r) => (r[0] === null ? null : str(r[0])) }
  }
}

/**
 * Text of a key or old value for the editor, from the value of a plain column (foreign key picker keys):
 * bytes as `0x...`, BIT as its decimal number, everything else as the cell text.
 */
export function keyText(col: RowColumn, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (col.kind === 'binary' || col.kind === 'blob') {
    return '0x' + Buffer.from(raw as Buffer).toString('hex')
  }
  if (col.kind === 'year') return str(raw).padStart(4, '0')
  if (col.kind === 'bit') {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(str(raw), 'latin1')
    let n = 0n
    for (const b of buf) n = (n << 8n) | BigInt(b)
    return n.toString()
  }
  return str(raw)
}

// ---- Cell (full value) read -------------------------------------------------------------------------------------

export type CellValue =
  | { t: 'null' }
  | { t: 'text'; text: string; length: number; truncated: boolean }
  | { t: 'bytes'; hex: string; length: number; truncated: boolean }

/** Projection of one cell up to `maxBytes`: the value, its length and, where the column is digest-compared, the digest. */
export type CellReadProjection = {
  exprs: string[]
  decode: (raw: unknown[]) => { value: CellValue; digest?: string }
}

export function cellReadProjection(col: RowColumn, maxBytes: number): CellReadProjection {
  const c = q(col.name)
  const n = Math.max(1, Math.trunc(maxBytes))
  const digest = usesDigest(col) || col.kind === 'blob' || col.kind === 'text'
  const dx = digest ? [digestExpr(col)] : []
  const withDigest = (value: CellValue, raw: unknown[], at: number) => ({
    value,
    ...(digest && typeof raw[at] === 'string' ? { digest: raw[at] as string } : {}),
  })
  if (col.kind === 'binary' || col.kind === 'blob') {
    return {
      exprs: [`SUBSTRING(${c}, 1, ${n})`, `OCTET_LENGTH(${c})`, ...dx],
      decode: (r) =>
        withDigest(
          r[0] === null
            ? { t: 'null' }
            : {
                t: 'bytes',
                hex: Buffer.from(r[0] as Buffer).toString('hex'),
                length: Number(r[1]),
                truncated: Number(r[1]) > n,
              },
          r,
          2,
        ),
    }
  }
  const source =
    col.kind === 'geometry'
      ? `ST_AsText(${c})`
      : col.kind === 'float' || col.kind === 'unknown'
        ? `CAST(${c} AS CHAR)`
        : col.kind === 'bit'
          ? `LPAD(BIN(${c} + 0), ${Math.max(1, Math.trunc(col.length ?? 64))}, '0')`
          : c
  return {
    exprs: [`LEFT(${source}, ${n})`, `CHAR_LENGTH(${source})`, ...dx],
    decode: (r) =>
      withDigest(
        r[0] === null
          ? { t: 'null' }
          : {
              t: 'text',
              text: str(r[0]),
              length: Number(r[1]),
              truncated: Number(r[1]) > charCount(str(r[0])),
            },
        r,
        2,
      ),
  }
}
