/**
 * The only file of the module with fixed SQL fragments (SEC-TGT-051, 117). User text is never built here,
 * only sliced elsewhere; identifiers go through `quoteIdent`.
 */
import { quoteIdent } from '../db/identifiers'
import type { Product } from '../structure/types'

export const SET_READ_ONLY = 'SET SESSION TRANSACTION READ ONLY'
export const SET_FK_CHECKS_OFF = 'SET SESSION foreign_key_checks = 0'
export const START_TRANSACTION = 'START TRANSACTION'
export const COMMIT = 'COMMIT'
export const ROLLBACK = 'ROLLBACK'
export const SHOW_WARNINGS = 'SHOW WARNINGS'
export const SELECT_SQL_MODE = 'SELECT @@SESSION.sql_mode AS m'
export const SELECT_VERSION = 'SELECT VERSION() AS v, @@version_comment AS c'
export const SELECT_DATABASE = 'SELECT DATABASE() AS d'
export const SCHEMA_EXISTS =
  'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?'

export const useDatabase = (db: string): string => `USE ${quoteIdent(db)}`

/**
 * Server-side backstop for the statement timeout (FR-SQL-009). It is set one second above the watchdog's
 * limit, so the watchdog (which reports "time limit") fires first. MySQL: milliseconds, SELECT only
 * (a plain `SELECT SLEEP()` then returns 1 without an error); MariaDB: seconds, any statement but DO.
 */
export function setTimeoutVariable(product: Product, timeoutMs: number): string {
  const backstop = Math.max(1, Math.floor(timeoutMs) + 1000)
  return product === 'mariadb'
    ? `SET SESSION max_statement_time = ${(backstop / 1000).toFixed(3)}`
    : `SET SESSION max_execution_time = ${backstop}`
}

export function killQuery(threadId: number): string {
  if (!Number.isInteger(threadId) || threadId <= 0) throw new Error('invalid thread id')
  return `KILL QUERY ${threadId}`
}

export type ExplainFormat = 'json' | 'tree' | 'text'
export type ExplainPrefix = {
  prefix: string
  /** Format of the raw output the server returns (a requested `tree` may be served as JSON). */
  format: ExplainFormat
  /** True when the statement is executed by the server. */
  executes: boolean
}

/** Prefix per product, mode and format (FR-SQL-021; observed on MySQL 8.4 and MariaDB 10.11). */
export function explainPrefix(
  product: Product,
  mode: 'explain' | 'analyse',
  format: ExplainFormat,
): ExplainPrefix {
  if (product === 'mysql') {
    if (mode === 'analyse') return { prefix: 'EXPLAIN ANALYZE', format: 'tree', executes: true }
    if (format === 'text') return { prefix: 'EXPLAIN', format: 'text', executes: false }
    // the tree is built from JSON; MySQL's own FORMAT=TREE is text and is not needed
    return { prefix: 'EXPLAIN FORMAT=JSON', format: 'json', executes: false }
  }
  if (mode === 'analyse') {
    return format === 'text'
      ? { prefix: 'ANALYZE', format: 'text', executes: true }
      : { prefix: 'ANALYZE FORMAT=JSON', format: 'json', executes: true }
  }
  return format === 'text'
    ? { prefix: 'EXPLAIN', format: 'text', executes: false }
    : { prefix: 'EXPLAIN FORMAT=JSON', format: 'json', executes: false }
}

/** Plain `EXPLAIN` used by the affected-rows estimate. */
export const ESTIMATE_PREFIX = 'EXPLAIN'
