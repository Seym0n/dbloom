/**
 * Catalog reads and row streaming of the export engine (FR-IO-003/004/005). Everything goes through the one
 * dedicated connection of the job. Names come from the server (SEC-TGT-116) and are quoted by `quoteIdent`;
 * no client text reaches a statement here. Values are read with the text protocol as exact strings (numbers,
 * dates), Buffers for binary, BIT and geometry (spec 5.4).
 */
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { quoteIdent as q } from '../db/identifiers'
import type { ColumnInfo, IoCell } from './types'

type Row = RowDataPacket

export const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

const text = (v: unknown): string => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''))
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A column as the export needs it: the writers' `ColumnInfo` plus the declared type for the JSON header. */
export interface ExportColumn extends ColumnInfo {
  type: string
  /** 4-byte FLOAT: the text protocol rounds it to 6 digits, so it is read widened to a double (exact). */
  single?: boolean
}

export type ObjectInfo = {
  name: string
  kind: 'table' | 'view'
  engine: string | null
  /** `DATA_LENGTH` from the catalog (estimate), null for views. */
  dataBytes: number | null
}

export type RoutineInfo = { name: string; kind: 'procedure' | 'function' }
export type TriggerInfo = { name: string; table: string }

/** The server rejected an object we may not read, or returned no text for it. */
export class ObjectUnreadable extends Error {
  constructor(
    public object: string,
    message: string,
  ) {
    super(message)
    this.name = 'ObjectUnreadable'
  }
}

// ---- Types ---------------------------------------------------------------------------------------------------

export function kindOfDataType(dataType: string): string {
  switch (dataType.toLowerCase()) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'integer':
    case 'bigint':
      return 'int'
    case 'decimal':
    case 'numeric':
      return 'decimal'
    case 'float':
    case 'double':
    case 'real':
      return 'float'
    case 'bit':
      return 'bit'
    case 'year':
      return 'year'
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return dataType.toLowerCase()
    case 'char':
    case 'varchar':
    case 'uuid':
    case 'inet4':
    case 'inet6':
      return 'char'
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
      return 'text'
    case 'enum':
    case 'set':
      return dataType.toLowerCase()
    case 'binary':
    case 'varbinary':
      return 'binary'
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
      return 'blob'
    case 'json':
      return 'json'
    case 'geometry':
    case 'point':
    case 'linestring':
    case 'polygon':
    case 'multipoint':
    case 'multilinestring':
    case 'multipolygon':
    case 'geometrycollection':
      return 'geometry'
    default:
      return 'unknown'
  }
}

/** Type kind of a result column from the wire type id and charset flag (DATA-ISS-105). */
export function kindOfWireType(columnType: number, binary: boolean): string {
  switch (columnType) {
    case 1:
    case 2:
    case 3:
    case 8:
    case 9:
      return 'int'
    case 0:
    case 246:
      return 'decimal'
    case 4:
    case 5:
      return 'float'
    case 13:
      return 'year'
    case 16:
      return 'bit'
    case 7:
      return 'timestamp'
    case 10:
    case 14:
      return 'date'
    case 11:
      return 'time'
    case 12:
      return 'datetime'
    case 245:
      return 'json'
    case 255:
      return 'geometry'
    case 247:
      return 'enum'
    case 248:
      return 'set'
    case 249:
    case 250:
    case 251:
    case 252:
      return binary ? 'blob' : 'text'
    case 253:
    case 254:
      return binary ? 'binary' : 'char'
    default:
      return 'unknown'
  }
}

// ---- Catalog ------------------------------------------------------------------------------------------------

export async function listUserDatabases(c: PoolConnection): Promise<string[]> {
  const [rows] = await c.query<Row[]>('SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA')
  return rows
    .map((r) => text(r.n))
    .filter((n) => !SYSTEM_SCHEMAS.has(n.toLowerCase()))
    .sort(byName)
}

/** Catalog spelling of a database name, or null when it does not exist. */
export async function findDatabase(c: PoolConnection, name: string): Promise<string | null> {
  const [rows] = await c.query<Row[]>('SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name])
  const hit = rows.map((r) => text(r.n)).find((n) => n === name)
  return hit ?? null
}

export async function listObjects(c: PoolConnection, db: string): Promise<ObjectInfo[]> {
  const [rows] = await c.query<Row[]>(
    'SELECT TABLE_NAME AS n, TABLE_TYPE AS t, ENGINE AS e, DATA_LENGTH AS d FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [db],
  )
  return rows
    .map((r): ObjectInfo => {
      const type = text(r.t).toUpperCase()
      const isView = type === 'VIEW'
      return {
        name: text(r.n),
        kind: isView ? 'view' : 'table',
        engine: r.e === null || r.e === undefined ? null : text(r.e),
        dataBytes: isView || r.d === null || r.d === undefined ? null : Number(r.d),
      }
    })
    .sort((a, b) => byName(a.name, b.name))
}

/** Columns of every table and view of one database, in table order of the catalog (`ORDINAL_POSITION`). */
export async function loadColumns(c: PoolConnection, db: string): Promise<Map<string, ExportColumn[]>> {
  const [rows] = await c.query<Row[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS n, DATA_TYPE AS dt, COLUMN_TYPE AS ct, EXTRA AS x
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [db],
  )
  const out = new Map<string, ExportColumn[]>()
  for (const r of rows) {
    const kind = kindOfDataType(text(r.dt))
    const columnType = text(r.ct)
    const extra = text(r.x).toUpperCase()
    const col: ExportColumn = {
      name: text(r.n),
      kind,
      type: columnType,
      ...(/\bunsigned\b/i.test(columnType) ? { unsigned: true } : {}),
      ...(kind === 'binary' || kind === 'blob' ? { binary: true } : {}),
      ...(kind === 'geometry' ? { geometry: true } : {}),
      ...(kind === 'bit' ? { bit: true } : {}),
      ...(text(r.dt).toLowerCase() === 'float' ? { single: true } : {}),
      ...(/\b(VIRTUAL|STORED) GENERATED\b/.test(extra) ? { generated: true } : {}),
    }
    const list = out.get(text(r.t))
    if (list) list.push(col)
    else out.set(text(r.t), [col])
  }
  return out
}

/** Referenced tables per table, same database only (cross-database references cannot be ordered here). */
export async function foreignKeyDeps(c: PoolConnection, db: string): Promise<Map<string, string[]>> {
  const [rows] = await c.query<Row[]>(
    `SELECT DISTINCT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS r FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [db, db],
  )
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const list = out.get(text(r.t))
    if (list) list.push(text(r.r))
    else out.set(text(r.t), [text(r.r)])
  }
  return out
}

export async function primaryKeyColumns(c: PoolConnection, db: string, table: string): Promise<string[]> {
  const [rows] = await c.query<Row[]>(
    `SELECT COLUMN_NAME AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`,
    [db, table],
  )
  return rows.map((r) => text(r.n))
}

export async function listRoutines(c: PoolConnection, db: string): Promise<RoutineInfo[]> {
  const [rows] = await c.query<Row[]>(
    'SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?',
    [db],
  )
  return rows
    .map((r): RoutineInfo => ({ name: text(r.n), kind: text(r.t).toUpperCase() === 'FUNCTION' ? 'function' : 'procedure' }))
    .sort((a, b) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === 'function' ? -1 : 1))
}

export async function listTriggers(c: PoolConnection, db: string): Promise<TriggerInfo[]> {
  const [rows] = await c.query<Row[]>(
    `SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER, TRIGGER_NAME`,
    [db],
  )
  return rows.map((r) => ({ name: text(r.n), table: text(r.t) }))
}

export async function listEvents(c: PoolConnection, db: string): Promise<string[]> {
  const [rows] = await c.query<Row[]>('SELECT EVENT_NAME AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [db])
  return rows.map((r) => text(r.n)).sort(byName)
}

export type CreateKind = 'database' | 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event'

const SHOW: Record<CreateKind, { sql: string; column: string }> = {
  database: { sql: 'SHOW CREATE DATABASE', column: 'Create Database' },
  table: { sql: 'SHOW CREATE TABLE', column: 'Create Table' },
  view: { sql: 'SHOW CREATE VIEW', column: 'Create View' },
  procedure: { sql: 'SHOW CREATE PROCEDURE', column: 'Create Procedure' },
  function: { sql: 'SHOW CREATE FUNCTION', column: 'Create Function' },
  trigger: { sql: 'SHOW CREATE TRIGGER', column: 'SQL Original Statement' },
  event: { sql: 'SHOW CREATE EVENT', column: 'Create Event' },
}

/** The server's own `SHOW CREATE` text (DATA-ISS-120). A missing text (no privilege shows NULL) is `ObjectUnreadable`. */
export async function showCreate(c: PoolConnection, kind: CreateKind, db: string, name: string): Promise<string> {
  const target = kind === 'database' ? q(name) : `${q(db)}.${q(name)}`
  const [rows] = await c.query<Row[]>(`${SHOW[kind].sql} ${target}`)
  const row = rows[0]
  const value = row?.[SHOW[kind].column]
  if (value === null || value === undefined || text(value) === '')
    throw new ObjectUnreadable(`${db}.${name}`, 'The server returned no definition (missing privilege)')
  return text(value)
}

/**
 * Views (of `candidates`) that the definition of a view refers to, found by their quoted names in the body of the
 * server's SHOW CREATE VIEW text (Q7 asks for the parser). MySQL writes unqualified names, MariaDB `db`.`name`;
 * a column alias with the name of another view only adds an order constraint, which does no harm.
 */
export function viewReferences(createText: string, _db: string, candidates: string[]): string[] {
  const at = createText.search(/\sAS\s/i)
  const body = at >= 0 ? createText.slice(at) : createText
  return candidates.filter((name) => body.includes(q(name)))
}

// ---- Row streaming --------------------------------------------------------------------------------------------

type CoreStream = AsyncIterable<unknown[]> & { destroy(): void }
type CoreQuery = { stream(o: { highWaterMark: number }): CoreStream }
type TypeCastField = { type: string; string(encoding?: string): string | null; buffer(): Buffer | null }
type CoreConnection = {
  query(o: { sql: string; rowsAsArray: boolean; typeCast: (f: TypeCastField, next: () => unknown) => unknown }): CoreQuery
}

const STRING_TYPES = new Set([
  'TINY',
  'SHORT',
  'LONG',
  'INT24',
  'LONGLONG',
  'DECIMAL',
  'NEWDECIMAL',
  'FLOAT',
  'DOUBLE',
  'YEAR',
  'DATE',
  'NEWDATE',
  'TIME',
  'DATETIME',
  'TIMESTAMP',
  'TIME2',
  'DATETIME2',
  'TIMESTAMP2',
  'JSON',
])

/** Exact text for numbers, dates and JSON, bytes for geometry, the driver's default (string or Buffer) otherwise. */
export function exportTypeCast(field: TypeCastField, next: () => unknown): unknown {
  // JSON arrives with the binary charset flag; its bytes are UTF-8 text
  if (field.type === 'JSON') return field.string('utf8')
  if (STRING_TYPES.has(field.type)) return field.string()
  if (field.type === 'GEOMETRY') return field.buffer()
  return next()
}

export function toCell(v: unknown): IoCell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v as boolean)
}

export const BATCH_ROWS = 500
export const BATCH_BYTES = 256 * 1024

const cellSize = (c: IoCell): number => (c === null ? 4 : typeof c === 'string' ? c.length + 4 : c.byteLength + 4)

/** Groups rows into batches of at most `BATCH_ROWS` rows or about `BATCH_BYTES` bytes. */
export async function* batchRows(rows: AsyncIterable<IoCell[]>): AsyncGenerator<IoCell[][]> {
  let batch: IoCell[][] = []
  let bytes = 0
  for await (const row of rows) {
    batch.push(row)
    for (const c of row) bytes += cellSize(c)
    if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) {
      yield batch
      batch = []
      bytes = 0
    }
  }
  if (batch.length > 0) yield batch
}

/** Streams the rows of one SELECT with back pressure on the job's connection. The stream is destroyed when the caller leaves. */
export async function* streamSelect(conn: PoolConnection, sql: string): AsyncGenerator<IoCell[]> {
  const core = (conn as unknown as { connection: CoreConnection }).connection
  const stream = core.query({ sql, rowsAsArray: true, typeCast: exportTypeCast }).stream({ highWaterMark: 64 })
  try {
    for await (const row of stream) yield row.map(toCell)
  } finally {
    stream.destroy()
  }
}

/** `SELECT` of the given columns; an optional row range is `LIMIT offset, count` ordered by the primary key. */
export function selectSql(
  db: string,
  table: string,
  columns: Pick<ExportColumn, 'name' | 'single'>[],
  range?: { offset: number; count: number },
  orderBy: string[] = [],
): string {
  let sql = `SELECT ${columns.map((c) => (c.single ? `(${q(c.name)} + 0e0) AS ${q(c.name)}` : q(c.name))).join(', ')} FROM ${q(db)}.${q(table)}`
  if (range) {
    if (orderBy.length > 0) sql += ` ORDER BY ${orderBy.map(q).join(', ')}`
    sql += ` LIMIT ${Math.trunc(range.offset)}, ${Math.trunc(range.count)}`
  }
  return sql
}
