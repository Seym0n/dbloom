import { EventEmitter } from 'node:events'
import type { PoolConnection } from 'mysql2/promise'
import type { TargetPool } from '../db/target-pool'
import { auditStructure, hashStatements, runWithTimeout } from './deps'
import { mapMysqlError, StructureRefusal } from './errors'
import { fingerprintTable } from './introspect'
import type { StoredPlan } from './plans'
import type { ExecuteResult, StatementResult, StructureChanged } from './types'

/** Server-side `structure.changed` event (FR-STR-014); other modules subscribe with `.on('changed', ...)`. */
export const structureEvents = new EventEmitter()

export type ExecuteEnv = {
  pool: TargetPool
  /** DBLoom user name (target user in direct mode) and target label, for the audit line. */
  user: string
  target: string
  statementTimeoutMs: number
}

const RESET_FOREIGN_KEY_CHECKS = 'SET SESSION foreign_key_checks = 1'
const RESET_LOCK_WAIT_TIMEOUT = 'SET SESSION lock_wait_timeout = DEFAULT'
const MAX_LOCK_WAIT_SECONDS = 300

/**
 * Seconds a statement may wait for a metadata lock (FR-STR-017): 80 percent of the statement timeout,
 * so the server's own lock error (1205) arrives before the watchdog's KILL QUERY; at least 1, at most 300.
 */
export function lockWaitSeconds(statementTimeoutMs: number): number {
  const seconds = Math.floor(
    (Number.isFinite(statementTimeoutMs) ? statementTimeoutMs : 0) * 0.0008,
  )
  return Math.min(MAX_LOCK_WAIT_SECONDS, Math.max(1, seconds))
}

/**
 * Runs the statements of a plan, one `query` each, on one dedicated connection. Stops at the first
 * failure; later statements are reported as not run. There is no rollback (FR-STR-006).
 * An alter or rename whose table changed since the preview is refused before anything runs.
 */
export async function executePlan(env: ExecuteEnv, plan: StoredPlan): Promise<ExecuteResult> {
  if (plan.fingerprint !== undefined && plan.db !== undefined && plan.table !== undefined) {
    let now: string | undefined
    try {
      now = await fingerprintTable(env.pool, plan.db, plan.table)
    } catch {
      now = undefined // table vanished or unreadable: also stale
    }
    if (now !== plan.fingerprint) {
      throw new StructureRefusal('stale_plan', 'The table changed since the preview; review again')
    }
  }

  const connection = await env.pool.getConnection()
  const results: StatementResult[] = []
  let touchedForeignKeyChecks = false
  let destroy = false
  let failed = false
  try {
    try {
      await connection.query(
        `SET SESSION lock_wait_timeout = ${lockWaitSeconds(env.statementTimeoutMs)}`,
      )
    } catch (error) {
      destroy = true
      throw error
    }
    for (const [index, statement] of plan.statements.entries()) {
      if (failed) {
        results.push({ status: 'not-run', sql: statement.sql })
        continue
      }
      if (statement.kind === 'setForeignKeyChecks') touchedForeignKeyChecks = true
      const started = Date.now()
      try {
        await runWithTimeout(env.pool, connection, env.statementTimeoutMs, statement.sql)
        const durationMs = Date.now() - started
        results.push({ status: 'executed', sql: statement.sql, durationMs })
        audit(env, statement, plan, 'executed', durationMs)
      } catch (error) {
        failed = true
        const durationMs = Date.now() - started
        const mapped = mapMysqlError(error, index)
        const e = error as { fatal?: unknown; connectionUsable?: unknown }
        if (e.fatal === true || e.connectionUsable === false) destroy = true
        results.push({ status: 'failed', sql: statement.sql, durationMs, error: mapped })
        audit(env, statement, plan, 'failed', durationMs, mapped.errno ?? undefined)
      }
    }
  } finally {
    await finish(connection, touchedForeignKeyChecks, destroy)
  }

  const ok = !failed
  if (results.some((r) => r.status === 'executed')) {
    const changed: StructureChanged = {
      ...(plan.db !== undefined ? { db: plan.db } : {}),
      ...(plan.table !== undefined ? { table: plan.table } : {}),
    }
    structureEvents.emit('changed', changed)
  }
  return { results, ok }
}

function audit(
  env: ExecuteEnv,
  statement: StoredPlan['statements'][number],
  plan: StoredPlan,
  outcome: 'executed' | 'failed',
  durationMs: number,
  errno?: number,
): void {
  // The hash of the statement text only; defaults and comments never reach the log (NFR-TGT-090).
  void plan
  auditStructure({
    user: env.user,
    target: env.target,
    kind: statement.kind,
    class: statement.class,
    statementHash: hashStatements([statement]),
    outcome,
    durationMs,
    ...(errno !== undefined ? { errno } : {}),
  })
}

/** Resets FOREIGN_KEY_CHECKS if the plan touched it; a connection that cannot be reset is destroyed. */
async function finish(
  connection: PoolConnection,
  touchedForeignKeyChecks: boolean,
  destroy: boolean,
): Promise<void> {
  let bad = destroy
  if (touchedForeignKeyChecks && !bad) {
    try {
      await connection.query(RESET_FOREIGN_KEY_CHECKS)
    } catch {
      bad = true
    }
  }
  if (!bad) {
    // The connection goes back to the pool: it must not keep the short lock wait.
    try {
      await connection.query(RESET_LOCK_WAIT_TIMEOUT)
    } catch {
      bad = true
    }
  }
  if (bad) connection.destroy()
  else connection.release()
}
