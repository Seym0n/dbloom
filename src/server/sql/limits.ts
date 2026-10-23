import type { Config } from '../config'
import { DEFAULT_SQL_LIMITS, type SqlLimits } from './types'

/** Hard ceilings so a typo in `.env` cannot turn the guard rail off (ST-114, ST-115). */
const CEILING = {
  rowCap: 10_000_000,
  responseBytes: 1024 * 1024 * 1024,
  cellBytes: 64 * 1024 * 1024,
  maxStatements: 10_000,
  maxConcurrentRuns: 3, // the pool has 4 connections and one stays free for cancel (FR-SQL-029)
} as const

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a whole number greater than zero`)
  return n
}

/**
 * Limits for one run (FR-SQL-028): each value is the minimum of the `.env` bound (or the default) and the
 * user preference, never above the ceiling. The timeout comes from `Config.statementTimeoutMs`;
 * a preference of 0 or less is rejected (ST-110).
 */
export function resolveSqlLimits(
  config?: Pick<Config, 'statementTimeoutMs'>,
  prefs: Partial<SqlLimits> = {},
  env: NodeJS.ProcessEnv = process.env,
): SqlLimits {
  const bound: SqlLimits = {
    ...DEFAULT_SQL_LIMITS,
    timeoutMs: config?.statementTimeoutMs ?? DEFAULT_SQL_LIMITS.timeoutMs,
    rowCap: Math.min(
      CEILING.rowCap,
      positiveInt(env, 'DBLOOM_SQL_ROW_CAP', DEFAULT_SQL_LIMITS.rowCap),
    ),
    responseBytes: Math.min(
      CEILING.responseBytes,
      positiveInt(env, 'DBLOOM_SQL_RESPONSE_MB', DEFAULT_SQL_LIMITS.responseBytes / 1048576) *
        1048576,
    ),
    cellBytes: Math.min(
      CEILING.cellBytes,
      positiveInt(env, 'DBLOOM_SQL_CELL_KB', DEFAULT_SQL_LIMITS.cellBytes / 1024) * 1024,
    ),
    maxStatements: Math.min(
      CEILING.maxStatements,
      positiveInt(env, 'DBLOOM_SQL_MAX_STATEMENTS', DEFAULT_SQL_LIMITS.maxStatements),
    ),
    maxConcurrentRuns: Math.min(
      CEILING.maxConcurrentRuns,
      positiveInt(env, 'DBLOOM_SQL_MAX_CONCURRENT_RUNS', DEFAULT_SQL_LIMITS.maxConcurrentRuns),
    ),
  }
  const out = { ...bound }
  for (const key of Object.keys(prefs) as (keyof SqlLimits)[]) {
    const v = prefs[key]
    if (v === undefined) continue
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`invalid_request: ${key} must be greater than zero`)
    }
    out[key] = Math.min(bound[key], Math.floor(v))
  }
  return out
}
