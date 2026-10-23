import type { StructureAuditEvent } from './structure/types'

/** One JSON line per event on stdout. Never pass passwords, tokens or cell values (SEC-TGT-023). */
export function audit(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), audit: event, ...fields }))
}

/** Structure statements: hash only, never SQL text or literals (NFR-TGT-090, SEC-TGT-023). */
export function auditStructure(event: StructureAuditEvent): void {
  audit('structure.statement', {
    user: event.user,
    target: event.target,
    kind: event.kind,
    class: event.class,
    statementHash: event.statementHash,
    outcome: event.outcome,
    errno: event.errno,
    durationMs: event.durationMs,
  })
}

export type SqlRunAuditEvent = {
  user: string
  target: string
  runId: string
  statements: number
  maxClass: 'none' | 'soft' | 'hard'
  outcome: 'ok' | 'failed' | 'cancelled' | 'timeout' | 'refused'
  /** Stable refusal code for `refused` (read-only, token-missing, ...). */
  code?: string
  source?: 'user' | 'assistant' | 'export'
  durationMs?: number
}

/** One line per SQL-tab run: counts and outcome only, never SQL text (FR-SQL-016, NFR-TGT-090). */
export function auditSqlRun(event: SqlRunAuditEvent): void {
  audit('sql.run', {
    user: event.user,
    target: event.target,
    runId: event.runId,
    statements: event.statements,
    class: event.maxClass,
    outcome: event.outcome,
    code: event.code,
    source: event.source,
    durationMs: event.durationMs,
  })
}

export type SqlStatementAuditEvent = {
  user: string
  target: string
  runId: string
  index: number
  kind: string
  class: 'none' | 'soft' | 'hard'
  /** SHA-256 of the statement text (the literals never reach the log). */
  statementHash: string
  outcome: 'executed' | 'failed' | 'refused' | 'cancelled' | 'timeout' | 'not-run'
  errno?: number
  affectedRows?: number
  durationMs?: number
}

/** One line per statement that is not class none or not read-only safe (FR-SQL-016). */
export function auditSqlStatement(event: SqlStatementAuditEvent): void {
  audit('sql.statement', {
    user: event.user,
    target: event.target,
    runId: event.runId,
    index: event.index,
    kind: event.kind,
    class: event.class,
    statementHash: event.statementHash,
    outcome: event.outcome,
    errno: event.errno,
    affectedRows: event.affectedRows,
    durationMs: event.durationMs,
  })
}
