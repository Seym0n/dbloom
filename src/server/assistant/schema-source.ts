/**
 * Schema reads of the assistant (SPEC/34 FR-AST-002): the outline for the first message, the columns of the tables a
 * statement names, and `describe_tables`. Metadata only, from information_schema, with the user's own rights. Names go in
 * as parameters, never into the SQL text.
 */
import type { RowDataPacket } from 'mysql2'
import type { TargetPool } from '../db/target-pool'
import type { OutlineTable } from './tools'

export type TableColumns = { columns: { name: string; type: string; key?: string }[]; view: boolean }

export type SchemaSource = {
  /** Tables of every database the user can see (system schemas left out), up to a fixed number of columns. */
  outline(pool: TargetPool): Promise<OutlineTable[]>
  /** Columns of named tables. Keys are `db.table` in lower case; a table that does not exist has no entry. */
  columns(pool: TargetPool, pairs: { db: string; table: string }[]): Promise<Map<string, TableColumns>>
}

export const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'] as const
export const OUTLINE_MAX_COLUMNS = 20_000
const TYPE_MAX = 60

export const schemaKey = (db: string, table: string): string => `${db}.${table}`.toLowerCase()
const clip = (s: string): string => (s.length > TYPE_MAX ? `${s.slice(0, TYPE_MAX - 1)}…` : s)

export const informationSchemaSource: SchemaSource = {
  async outline(pool) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.TABLE_SCHEMA AS db, c.TABLE_NAME AS tbl, c.COLUMN_NAME AS col, c.COLUMN_TYPE AS type, t.TABLE_TYPE AS ttype
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(',')})
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION LIMIT ?`,
      [...SYSTEM_SCHEMAS, OUTLINE_MAX_COLUMNS],
    )
    const tables: OutlineTable[] = []
    let current: OutlineTable | undefined
    for (const r of rows) {
      const db = String(r.db)
      const table = String(r.tbl)
      if (!current || current.db !== db || current.table !== table) {
        current = { db, table, columns: [], ...(r.ttype === 'BASE TABLE' ? {} : { view: true }) }
        tables.push(current)
      }
      current.columns.push({ name: String(r.col), type: clip(String(r.type)) })
    }
    return tables
  },

  async columns(pool, pairs) {
    const out = new Map<string, TableColumns>()
    const byDb = new Map<string, Set<string>>()
    for (const p of pairs) {
      if (!byDb.has(p.db)) byDb.set(p.db, new Set())
      byDb.get(p.db)!.add(p.table)
    }
    for (const [db, tables] of byDb) {
      const names = [...tables]
      const marks = names.map(() => '?').join(',')
      const [types] = await pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${marks})`,
        [db, ...names],
      )
      const [cols] = await pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS type, COLUMN_KEY AS ckey
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${marks})
          ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [db, ...names],
      )
      for (const t of types) out.set(schemaKey(db, String(t.name)), { columns: [], view: t.type !== 'BASE TABLE' })
      for (const c of cols) {
        const hit = out.get(schemaKey(db, String(c.tbl)))
        if (!hit) continue
        const key = String(c.ckey ?? '')
        hit.columns.push({ name: String(c.col), type: clip(String(c.type)), ...(key ? { key } : {}) })
      }
    }
    return out
  },
}
