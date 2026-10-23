import type { RowDataPacket } from 'mysql2'
import { quoteIdent } from './identifiers'
import type { ResolvedTable } from './schema'
import type { TargetPool } from './target-pool'

export const PAGE_SIZES = [25, 50, 100, 250, 500] as const
export const MAX_PAGE_SIZE = 1000
export const DEFAULT_PAGE_SIZE = 50
const MAX_CELL_CHARS = 500

/** Values leave the server as strings; binary and long values are summarised (SEC-TGT-070). */
export type Cell =
  null | string | { cut: string; length: number } | { binary: string; size: number }

export type RowsRequest = {
  page: number
  pageSize: number
  sort?: string
  direction?: 'asc' | 'desc'
}
export type ColumnKind = 'number' | 'temporal' | 'text'
export type RowsResult = { columns: string[]; kinds: ColumnKind[]; rows: Cell[][]; sql: string }

const NUMBER_TYPE = /^(tiny|small|medium|big)?int|^(decimal|numeric|float|double|real|bit|year)/i
const TEMPORAL_TYPE = /^(date|datetime|timestamp|time)/i

function kindOf(columnType: string): ColumnKind {
  if (NUMBER_TYPE.test(columnType)) return 'number'
  if (TEMPORAL_TYPE.test(columnType)) return 'temporal'
  return 'text'
}

function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    return { binary: value.subarray(0, 32).toString('hex'), size: value.length }
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_CELL_CHARS
    ? { cut: text.slice(0, MAX_CELL_CHARS), length: text.length }
    : text
}

export async function pageRows(
  pool: TargetPool,
  table: ResolvedTable,
  request: RowsRequest,
): Promise<RowsResult> {
  const pageSize = Math.min(Math.max(1, Math.trunc(request.pageSize)), MAX_PAGE_SIZE)
  const offset = Math.max(0, Math.trunc(request.page)) * pageSize
  const names = table.columns.map((c) => c.name)

  let orderBy = ''
  if (request.sort !== undefined) {
    // Only a column the server reported for this table can be sorted by.
    if (!names.includes(request.sort)) throw new Error('Unknown column')
    orderBy = ` ORDER BY ${quoteIdent(request.sort)} ${request.direction === 'desc' ? 'DESC' : 'ASC'}`
  }
  const sql =
    `SELECT ${names.map(quoteIdent).join(', ')} FROM ${quoteIdent(table.db)}.${quoteIdent(table.table)}` +
    `${orderBy} LIMIT ${pageSize} OFFSET ${offset}`

  const [rows] = await pool.query<RowDataPacket[][]>({ sql, rowsAsArray: true })
  return {
    columns: names,
    kinds: table.columns.map((c) => kindOf(c.type)),
    rows: rows.map((row) => row.map(toCell)),
    sql,
  }
}
