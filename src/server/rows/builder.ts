/**
 * The one statement builder of module `rows` (FR-ROW-001, spec 5.1). Pure and synchronous: no connection, no
 * I/O. Every function returns `{sql, params, preview, kind, effect}`; `sql` holds quoted identifiers
 * (`quoteIdent`), `?` placeholders and fixed fragments only, every value is an element of `params` and is
 * executed with `pool.execute` (server-side prepared statements, immune to NO_BACKSLASH_ESCAPES). Names come
 * from the catalog model, values from the codec; integers in the text (LIMIT, OFFSET, widths) are produced
 * here from validated numbers. No charset alias is ever emitted. The `preview` substitutes the parameters for
 * display only and is never executed.
 */
import { quoteIdent as q } from '../db/identifiers'
import {
  cellReadProjection,
  digestExpr,
  encodeWire,
  guardCondition,
  isTextKind,
  isWritable,
  keyText,
  likeEscape,
  projectionFor,
  RowValueError,
  usesDigest,
  type CellReadProjection,
  type EncodedValue,
  type EncodeOptions,
  type Param,
  type ReadOptions,
  type SqlFragment,
} from './codecs'
import {
  MAX_PAGE_SIZE,
  type BuiltStatement,
  type Cell,
  type GuardValue,
  type Identity,
  type LookupOption,
  type RowChange,
  type RowColumn,
  type RowTable,
  type SortEntry,
  type Statement,
  type StatementClass,
  type TypeKind,
  type WireValue,
} from './types'

// ---- Preview (display only) ------------------------------------------------------------------------------------------

const PREVIEW_MAX_CHARS = 500
const PREVIEW_HEX_BYTES = 32

function previewValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (Buffer.isBuffer(v)) {
    const head = v.subarray(0, PREVIEW_HEX_BYTES).toString('hex')
    return v.length > PREVIEW_HEX_BYTES ? `0x${head}… (${v.length} bytes)` : `0x${head}`
  }
  const s = String(v)
  const cut = s.length > PREVIEW_MAX_CHARS ? s.slice(0, PREVIEW_MAX_CHARS) + '…' : s
  const escaped = cut
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "''")
    .replaceAll('\u0000', '\\0')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\u001a', '\\Z')
  return `'${escaped}'`
}

/** Substitutes the `?` outside quoted names and fixed literals with display text of the parameters. */
export function renderPreview(sql: string, params: readonly unknown[]): string {
  let out = ''
  let i = 0
  let p = 0
  let state: 'text' | 'ident' | 'string' = 'text'
  while (i < sql.length) {
    const ch = sql[i]!
    if (state === 'ident') {
      out += ch
      if (ch === '`') state = 'text'
    } else if (state === 'string') {
      out += ch
      if (ch === "'") state = 'text'
    } else if (ch === '`') {
      out += ch
      state = 'ident'
    } else if (ch === "'") {
      out += ch
      state = 'string'
    } else if (ch === '?') {
      out += p < params.length ? previewValue(params[p]) : '?'
      p++
    } else {
      out += ch
    }
    i++
  }
  return out
}

function built(
  kind: BuiltStatement['kind'],
  sql: string,
  params: Param[],
  effect: string,
): BuiltStatement {
  return { sql, params, preview: renderPreview(sql, params), kind, effect }
}

/** Wraps a built statement as the plan statement type of the guard (class decided by `classes.ts`). */
export function toStatement(b: BuiltStatement, cls: StatementClass): Statement {
  if (b.kind === 'rowSelect') throw new Error('A read is not a plan statement')
  return { sql: b.sql, kind: b.kind, class: cls, effect: b.effect, params: b.params }
}

function refuse(
  code: ConstructorParameters<typeof RowValueError>[0],
  message: string,
  field?: string,
): never {
  throw new RowValueError(code, message, field)
}

function tableName(t: RowTable): string {
  return `${q(t.db)}.${q(t.table)}`
}

function integer(n: number, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    refuse('invalid-value', `${what} is out of range`)
  return n
}

function columnOf(table: RowTable, name: string): RowColumn {
  const col = table.columns.find((c) => c.name === name)
  if (!col) return refuse('unknown-column', 'Unknown column', name)
  return col
}

// ---- Projection layout (select list <-> cells) -----------------------------------------------------------------------

export type LayoutColumn = {
  name: string
  kind: TypeKind
  invisible: boolean
  start: number
  count: number
  decode: (raw: unknown[]) => Cell
  /** Position of the SHA-256 digest in the raw row, for columns compared by digest. */
  digestAt?: number
}

/** Which SELECT items belong to which column; `decodeRow` turns a raw row (`rowsAsArray`) into cells. */
export type ProjectionLayout = { columns: LayoutColumn[]; width: number }

export function decodeRow(
  layout: ProjectionLayout,
  raw: unknown[],
): { cells: Cell[]; digests: Record<string, string> } {
  const cells: Cell[] = []
  const digests: Record<string, string> = {}
  for (const c of layout.columns) {
    cells.push(c.decode(raw.slice(c.start, c.start + c.count)))
    if (c.digestAt !== undefined && typeof raw[c.digestAt] === 'string') {
      digests[c.name] = raw[c.digestAt] as string
    }
  }
  return { cells, digests }
}

type SelectOptions = {
  read: ReadOptions
  /** Names to select, in this order; default all visible columns. */
  columns?: string[]
  includeInvisible?: boolean
  digests?: boolean
}

function select(
  table: RowTable,
  identity: Identity,
  options: SelectOptions,
): { list: string; layout: ProjectionLayout } {
  const keyCols = new Set(identity.kind === 'none' ? [] : identity.columns)
  const chosen = options.columns
    ? options.columns.map((n) => columnOf(table, n))
    : table.columns.filter(
        (c) => !c.invisible || options.includeInvisible === true || keyCols.has(c.name),
      )
  const items: string[] = []
  const columns: LayoutColumn[] = []
  for (const col of chosen) {
    const proj = projectionFor(col, options.read)
    const start = items.length
    items.push(...proj.exprs)
    const entry: LayoutColumn = {
      name: col.name,
      kind: col.kind,
      invisible: col.invisible,
      start,
      count: proj.exprs.length,
      decode: proj.decode,
    }
    if (options.digests && usesDigest(col)) {
      entry.digestAt = items.length
      items.push(digestExpr(col))
    }
    columns.push(entry)
  }
  if (items.length === 0) refuse('invalid-value', 'No column to select')
  return { list: items.join(', '), layout: { columns, width: items.length } }
}

// ---- Identity and WHERE ------------------------------------------------------------------------------------------------

export type RowKey = Record<string, GuardValue>

/** WHERE conditions that pick the row (FR-ROW-004). `all-columns` compares every column null-safely. */
function identityConditions(table: RowTable, identity: Identity, key: RowKey): SqlFragment[] {
  if (identity.kind === 'none') return refuse('no-identity', 'This row cannot be identified')
  for (const name of Object.keys(key)) columnOf(table, name)
  return identity.columns.map((name) => {
    const col = columnOf(table, name)
    const g = key[name]
    if (g === undefined) return refuse('invalid-value', 'Missing key value', name)
    return guardCondition(col, g, identity.kind === 'all-columns' ? 'old' : 'key')
  })
}

function sameGuard(a: GuardValue, b: GuardValue): boolean {
  return a.t === b.t && (a.t === 'null' || a.v === (b as { v: string }).v)
}

function andAll(parts: SqlFragment[]): SqlFragment {
  return { sql: parts.map((p) => p.sql).join(' AND '), params: parts.flatMap((p) => p.params) }
}

function whereClause(where: SqlFragment | null | undefined): SqlFragment {
  return where ? { sql: ` WHERE ${where.sql}`, params: where.params } : { sql: '', params: [] }
}

// ---- Page, count, row, cell, lookup (reads) ---------------------------------------------------------------------------

export type PageInput = {
  page: number
  pageSize: number
  sort: SortEntry[]
  where?: SqlFragment | null
  read: ReadOptions
  includeInvisible?: boolean
}

/**
 * The page query (FR-ROW-006): `pageSize + 1` rows so the caller can tell whether a next page exists, ordered
 * by the sort list and then by the identity columns so paging is deterministic.
 */
export function buildPage(
  table: RowTable,
  identity: Identity,
  input: PageInput,
): { statement: BuiltStatement; layout: ProjectionLayout; limit: number; offset: number } {
  const pageSize = integer(input.pageSize, 1, MAX_PAGE_SIZE, 'Page size')
  const page = integer(input.page, 0, 1_000_000_000, 'Page')
  const offset = page * pageSize
  const sel = select(table, identity, {
    read: input.read,
    ...(input.includeInvisible !== undefined ? { includeInvisible: input.includeInvisible } : {}),
  })
  const order: string[] = []
  const seen = new Set<string>()
  for (const s of input.sort) {
    const col = columnOf(table, s.column)
    if (seen.has(col.name)) continue
    seen.add(col.name)
    order.push(`${q(col.name)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
  }
  if (identity.kind === 'primary' || identity.kind === 'unique') {
    for (const name of identity.columns) {
      if (!seen.has(name)) order.push(`${q(name)} ASC`)
    }
  }
  const w = whereClause(input.where)
  const sql =
    `SELECT ${sel.list} FROM ${tableName(table)}${w.sql}` +
    `${order.length > 0 ? ` ORDER BY ${order.join(', ')}` : ''}` +
    ` LIMIT ${pageSize + 1}${offset > 0 ? ` OFFSET ${offset}` : ''}`
  return {
    statement: built('rowSelect', sql, w.params, `Reads page ${page + 1} of ${tableName(table)}`),
    layout: sel.layout,
    limit: pageSize,
    offset,
  }
}

/**
 * `COUNT(*)` of the filtered rows. With `cap` (views, CON-DTB-001) the count stops at `cap + 1` rows through
 * a derived table, so the caller shows "cap+" as a lower bound.
 */
export function buildCount(
  table: RowTable,
  where?: SqlFragment | null,
  cap?: number,
): BuiltStatement {
  const w = whereClause(where)
  if (cap !== undefined) {
    const n = integer(cap, 1, 1_000_000_000, 'Count cap')
    const sql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${tableName(table)}${w.sql} LIMIT ${n + 1}) AS capped`
    return built('rowSelect', sql, w.params, `Counts up to ${n} rows of ${tableName(table)}`)
  }
  return built(
    'rowSelect',
    `SELECT COUNT(*) FROM ${tableName(table)}${w.sql}`,
    w.params,
    `Counts rows of ${tableName(table)}`,
  )
}

export type RowReadInput = {
  key: RowKey
  read: ReadOptions
  includeInvisible?: boolean
  /** Columns to select; default the visible columns plus the key. */
  columns?: string[]
  /** Also select the digests of the columns compared by digest (FR-ROW-005). */
  digests?: boolean
}

/** One row by identity (re-read after a write, edit form, conflict answer). */
export function buildRowByIdentity(
  table: RowTable,
  identity: Identity,
  input: RowReadInput,
): { statement: BuiltStatement; layout: ProjectionLayout } {
  const where = andAll(identityConditions(table, identity, input.key))
  const sel = select(table, identity, {
    read: input.read,
    ...(input.includeInvisible !== undefined ? { includeInvisible: input.includeInvisible } : {}),
    ...(input.columns ? { columns: input.columns } : {}),
    ...(input.digests !== undefined ? { digests: input.digests } : {}),
  })
  const sql = `SELECT ${sel.list} FROM ${tableName(table)} WHERE ${where.sql} LIMIT 1`
  return {
    statement: built('rowSelect', sql, where.params, `Reads one row of ${tableName(table)}`),
    layout: sel.layout,
  }
}

/** One value up to `maxBytes` with its length and digest (cell viewer, FR-ROW-011). */
export function buildCellRead(
  table: RowTable,
  identity: Identity,
  key: RowKey,
  column: string,
  maxBytes: number,
): { statement: BuiltStatement; projection: CellReadProjection } {
  const col = columnOf(table, column)
  const where = andAll(identityConditions(table, identity, key))
  const projection = cellReadProjection(col, integer(maxBytes, 1, 16 * 1024 * 1024, 'Size'))
  const sql = `SELECT ${projection.exprs.join(', ')} FROM ${tableName(table)} WHERE ${where.sql} LIMIT 1`
  return {
    statement: built('rowSelect', sql, where.params, `Reads one value of ${q(col.name)}`),
    projection,
  }
}

/** Stored byte size of one value (download route, FR-ROW-012). */
export function buildCellSize(
  table: RowTable,
  identity: Identity,
  key: RowKey,
  column: string,
): BuiltStatement {
  const col = columnOf(table, column)
  const where = andAll(identityConditions(table, identity, key))
  const sql = `SELECT OCTET_LENGTH(${q(col.name)}) FROM ${tableName(table)} WHERE ${where.sql} LIMIT 1`
  return built('rowSelect', sql, where.params, 'Reads the size of a value')
}

/** `length` bytes from 0-based byte `offset` of one stored value (download route, FR-ROW-012). */
export function buildCellChunk(
  table: RowTable,
  identity: Identity,
  key: RowKey,
  column: string,
  offset: number,
  length: number,
): BuiltStatement {
  const col = columnOf(table, column)
  integer(offset, 0, Number.MAX_SAFE_INTEGER - 1, 'Offset')
  integer(length, 1, Number.MAX_SAFE_INTEGER, 'Length')
  const where = andAll(identityConditions(table, identity, key))
  const sql = `SELECT SUBSTRING(${q(col.name)}, ${offset + 1}, ${length}) FROM ${tableName(table)} WHERE ${where.sql} LIMIT 1`
  return built('rowSelect', sql, where.params, 'Reads a part of a value')
}

export type LookupSpec = {
  /** Referenced columns of the foreign key, in key order. */
  keyColumns: string[]
  /** Columns that make the display value (default: the caller picks the first text column). */
  displayColumns: string[]
  query?: string
  /** Display values for exactly these key tuples (one query per page, FR-ROW-014). */
  keys?: RowKey[]
  page: number
  pageSize: number
}

const DISPLAY_CHARS = 200

/** Foreign key picker and display values of the referenced table. */
export function buildLookup(
  ref: RowTable,
  spec: LookupSpec,
): {
  statement: BuiltStatement
  decode: (rows: unknown[][]) => { options: LookupOption[]; hasNext: boolean }
} {
  const keyCols = spec.keyColumns.map((n) => columnOf(ref, n))
  const displayCols = spec.displayColumns.map((n) => columnOf(ref, n))
  if (keyCols.length === 0) refuse('invalid-value', 'A foreign key has columns')
  const pageSize = integer(spec.pageSize, 1, MAX_PAGE_SIZE, 'Page size')
  const page = integer(spec.page, 0, 100_000, 'Page')
  const items = [
    ...keyCols.map((c) => q(c.name)),
    ...displayCols.map((c) => `LEFT(CAST(${q(c.name)} AS CHAR), ${DISPLAY_CHARS})`),
  ]
  const conds: SqlFragment[] = []
  if (spec.keys) {
    const tuples = spec.keys.map((k) =>
      andAll(
        keyCols.map((c) => {
          const g = k[c.name]
          if (g === undefined) return refuse('invalid-value', 'Missing key value', c.name)
          return guardCondition(c, g, 'key')
        }),
      ),
    )
    if (tuples.length === 0) refuse('invalid-value', 'No keys given')
    conds.push({
      sql:
        tuples.length === 1 ? tuples[0]!.sql : `(${tuples.map((t) => `(${t.sql})`).join(' OR ')})`,
      params: tuples.flatMap((t) => t.params),
    })
  }
  if (spec.query !== undefined && spec.query !== '') {
    const pattern = `%${likeEscape(spec.query)}%`
    const cols = [...displayCols, ...keyCols]
    conds.push({
      sql: `(${cols.map((c) => `CAST(${q(c.name)} AS CHAR) LIKE ? ESCAPE '!'`).join(' OR ')})`,
      params: cols.map(() => pattern),
    })
  }
  const where = conds.length > 0 ? andAll(conds) : null
  const w = whereClause(where)
  const offset = page * pageSize
  const sql =
    `SELECT ${items.join(', ')} FROM ${tableName(ref)}${w.sql}` +
    ` ORDER BY ${keyCols.map((c) => `${q(c.name)} ASC`).join(', ')}` +
    ` LIMIT ${pageSize + 1}${offset > 0 ? ` OFFSET ${offset}` : ''}`
  return {
    statement: built('rowSelect', sql, w.params, `Reads display values of ${tableName(ref)}`),
    decode: (rows) => {
      const options = rows.slice(0, pageSize).map((r) => {
        const key: Record<string, string | null> = {}
        keyCols.forEach((c, i) => {
          key[c.name] = keyText(c, r[i])
        })
        const shown = displayCols
          .map((_, i) => r[keyCols.length + i])
          .filter((v) => v !== null && v !== undefined && v !== '')
          .map(String)
        const display =
          shown.length > 0 ? shown.join(' ') : keyCols.map((c) => key[c.name] ?? 'NULL').join(', ')
        return { key, display }
      })
      return { options, hasNext: rows.length > pageSize }
    },
  }
}

// ---- Writes ------------------------------------------------------------------------------------------------------------------

function writableColumn(table: RowTable, name: string): RowColumn {
  const col = columnOf(table, name)
  if (!isWritable(col)) {
    refuse('not-editable', 'This column cannot be written', name)
  }
  return col
}

function requireBase(table: RowTable): void {
  if (table.kind === 'view') refuse('view-read-only', 'Views are read-only')
}

/** `INSERT [IGNORE] INTO t (cols) VALUES (...)`, columns in model order; no field at all gives `() VALUES ()`. */
export function buildInsert(
  table: RowTable,
  row: Record<string, EncodedValue>,
  ignore = false,
): BuiltStatement {
  requireBase(table)
  const cols = table.columns.filter((c) => Object.hasOwn(row, c.name))
  for (const name of Object.keys(row)) writableColumn(table, name)
  const values = cols.map((c) => row[c.name]!)
  const sql =
    `INSERT${ignore ? ' IGNORE' : ''} INTO ${tableName(table)} (${cols.map((c) => q(c.name)).join(', ')})` +
    ` VALUES (${values.map((v) => v.sql).join(', ')})`
  return built(
    'rowInsert',
    sql,
    values.flatMap((v) => v.params),
    `Inserts one row into ${tableName(table)}`,
  )
}

export type RowTargetKey = { key: RowKey; old: Record<string, GuardValue> }

function oldConditions(
  table: RowTable,
  identity: Identity,
  target: RowTargetKey,
  names: string[],
  strict: boolean,
): SqlFragment[] {
  const out: SqlFragment[] = []
  const inKey = new Set(identity.kind === 'none' ? [] : identity.columns)
  for (const name of names) {
    const col = columnOf(table, name)
    if (col.kind === 'unknown') continue
    const g = target.old[name] ?? (inKey.has(name) ? target.key[name] : undefined)
    if (g === undefined) {
      if (strict) refuse('invalid-value', 'Missing old value', name)
      continue
    }
    // Already covered by the identity with the same value: do not compare twice.
    const k = target.key[name]
    if (
      inKey.has(name) &&
      k !== undefined &&
      sameGuard(g, k) &&
      (identity.kind === 'all-columns' || !isTextKind(col.kind))
    ) {
      continue
    }
    out.push(guardCondition(col, g, 'old'))
  }
  return out
}

/**
 * `UPDATE t SET changed columns WHERE <identity> AND <old values of the changed columns> [LIMIT 1]`
 * (FR-ROW-005, spec 5.4). Success is judged by the found-rows count, never by changed rows.
 */
export function buildUpdate(
  table: RowTable,
  identity: Identity,
  target: RowTargetKey,
  set: Record<string, EncodedValue>,
): BuiltStatement {
  requireBase(table)
  const cols = table.columns.filter((c) => Object.hasOwn(set, c.name))
  if (cols.length === 0) refuse('invalid-value', 'Nothing to set')
  for (const name of Object.keys(set)) writableColumn(table, name)
  const conds = [
    ...identityConditions(table, identity, target.key),
    ...oldConditions(
      table,
      identity,
      target,
      cols.map((c) => c.name),
      true,
    ),
  ]
  const where = andAll(conds)
  const assignments = cols.map((c) => `${q(c.name)} = ${set[c.name]!.sql}`)
  const sql =
    `UPDATE ${tableName(table)} SET ${assignments.join(', ')} WHERE ${where.sql}` +
    (identity.kind === 'all-columns' ? ' LIMIT 1' : '')
  return built(
    'rowUpdate',
    sql,
    [...cols.flatMap((c) => set[c.name]!.params), ...where.params],
    `Changes ${cols.length} column${cols.length === 1 ? '' : 's'} of one row in ${tableName(table)}`,
  )
}

/** `DELETE FROM t WHERE <identity> AND <old values of the row as loaded> [LIMIT 1]`. */
export function buildDelete(
  table: RowTable,
  identity: Identity,
  target: RowTargetKey,
): BuiltStatement {
  requireBase(table)
  const conds = [
    ...identityConditions(table, identity, target.key),
    ...oldConditions(table, identity, target, Object.keys(target.old), false),
  ]
  const where = andAll(conds)
  const sql =
    `DELETE FROM ${tableName(table)} WHERE ${where.sql}` +
    (identity.kind === 'all-columns' ? ' LIMIT 1' : '')
  return built('rowDelete', sql, where.params, `Deletes one row from ${tableName(table)}`)
}

/**
 * Validates and encodes a record of wire values (columns must exist and be writable) with the codec of each
 * column. A failure carries the column (`field`) and, when given, the row index of the request.
 */
export function encodeSet(
  table: RowTable,
  wire: Record<string, WireValue>,
  options: EncodeOptions = {},
  rowIndex?: number,
): Record<string, EncodedValue> {
  const out: Record<string, EncodedValue> = {}
  try {
    for (const [name, value] of Object.entries(wire)) {
      out[name] = encodeWire(writableColumn(table, name), value, options)
    }
  } catch (e) {
    if (e instanceof RowValueError && rowIndex !== undefined) e.rowIndex = rowIndex
    throw e
  }
  return out
}

/**
 * All statements of a change, in request order: one `INSERT` per row, one `UPDATE` or `DELETE` per target
 * (FR-ROW-015, 019). The index of a statement is the index of its row or target. Throws `RowValueError` (a
 * `BuildRefusal`) before anything runs.
 */
export function buildChange(
  table: RowTable,
  identity: Identity,
  change: RowChange,
  options: EncodeOptions = {},
): BuiltStatement[] {
  requireBase(table)
  switch (change.op) {
    case 'insert':
      return change.rows.map((row, i) => {
        try {
          return buildInsert(table, encodeSet(table, row, options, i), change.ignore)
        } catch (e) {
          if (e instanceof RowValueError && e.rowIndex === undefined) e.rowIndex = i
          throw e
        }
      })
    case 'update': {
      const set = encodeSet(table, change.set, options)
      return change.targets.map((t, i) => {
        try {
          return buildUpdate(table, identity, t, set)
        } catch (e) {
          if (e instanceof RowValueError && e.rowIndex === undefined) e.rowIndex = i
          throw e
        }
      })
    }
    case 'delete':
      return change.targets.map((t, i) => {
        try {
          return buildDelete(table, identity, t)
        } catch (e) {
          if (e instanceof RowValueError && e.rowIndex === undefined) e.rowIndex = i
          throw e
        }
      })
  }
}
