import type { RowDataPacket } from 'mysql2'
import type { TargetPool } from './target-pool'

export type DatabaseInfo = { name: string }
export type TableInfo = { name: string; kind: 'table' | 'view'; estimatedRows: number | null }
export type ColumnInfo = { name: string; type: string }
export type ResolvedTable = {
  db: string
  table: string
  kind: 'table' | 'view'
  estimatedRows: number | null
  columns: ColumnInfo[]
}

export class NotFoundError extends Error {
  constructor() {
    super('Not found')
    this.name = 'NotFoundError'
  }
}

export async function listDatabases(pool: TargetPool): Promise<DatabaseInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
  )
  return rows.map((r) => ({ name: String(r.name) }))
}

export async function listTables(pool: TargetPool, db: string): Promise<TableInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimated
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [db],
  )
  return rows.map((r) => ({
    name: String(r.name),
    kind: r.type === 'BASE TABLE' ? 'table' : 'view',
    estimatedRows: r.estimated === null ? null : Number(r.estimated),
  }))
}

/** Checks the names against what the server reports before they are used in SQL (SEC-TGT-116). */
export async function resolveTable(
  pool: TargetPool,
  db: string,
  table: string,
): Promise<ResolvedTable> {
  const [tables] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimated
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  )
  const found = tables[0]
  // information_schema compares case-insensitively on some platforms; require the exact name back.
  if (!found || String(found.name) !== table) throw new NotFoundError()
  const [columns] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
    [db, table],
  )
  return {
    db,
    table,
    kind: found.type === 'BASE TABLE' ? 'table' : 'view',
    estimatedRows: found.estimated === null ? null : Number(found.estimated),
    columns: columns.map((c) => ({ name: String(c.name), type: String(c.type) })),
  }
}
