import { isAuditEvent } from './audit/events'
import type { DatabaseSync } from 'node:sqlite'
import { addSink, dispatch, listSinks, removeSink, type AuditEntry } from './audit/sink'
import { createStoreSink, storeWriterFor } from './audit/store-sink'
import type { StructureAuditEvent } from './structure/types'

/** Thrown by `auditRequired` when the row cannot be committed: the caller must abort its change (FR-AAU-004). */
export class AuditUnavailable extends Error {
  constructor(reason: string) {
    super(`Audit log unavailable: ${reason}`)
    this.name = 'AuditUnavailable'
  }
}

type Fields = Record<string, string | number | boolean | undefined>

/** Request context of the current call: set by the server runtime (effective client address, FR-SVR-005); absent in the CLI. */
let contextProvider: (() => AuditEntry['ctx']) | undefined
export function setAuditContext(provider: (() => AuditEntry['ctx']) | undefined): void {
  contextProvider = provider
}

let storeDb: DatabaseSync | undefined
const STORE_SINK = 'store'

/** Opens the table sink on this handle (server runtime). `auditRequired` writes through the same handle. */
export function registerAuditStore(db: DatabaseSync): void {
  storeDb = db
  addSink(createStoreSink(db, Date.now, STORE_SINK))
}
/** True when the table sink is registered (stateful server runtime). */
export const auditRegistered = (): boolean => storeDb !== undefined
export function unregisterAuditStore(): void {
  storeDb = undefined
  removeSink(STORE_SINK)
}

function checkCatalog(event: string): void {
  if (isAuditEvent(event)) return
  const message = `Audit event "${event}" is not in the catalog (src/server/audit/events.ts)`
  if (process.env.NODE_ENV === 'test') throw new Error(message)
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: message })}
`)
}

function entryOf(event: string, fields: Fields): AuditEntry {
  let ctx: AuditEntry['ctx']
  try {
    ctx = contextProvider?.()
  } catch {
    ctx = undefined // outside a request
  }
  return { t: new Date().toISOString(), event, fields, ...(ctx ? { ctx } : {}) }
}

/**
 * One audit event: checked against the catalog, then written to every sink (stdout line first, see `audit/sink.ts`).
 * Best effort: a failing sink never throws here. Never pass passwords, tokens or cell values (SEC-TGT-023). An event
 * missing from the catalog throws under test and is logged as an error in production; the line is written either way.
 */
export function audit(event: string, fields: Fields = {}): void {
  checkCatalog(event)
  dispatch(entryOf(event, fields))
}

/**
 * Required write (FR-AAU-004): the row is committed before this returns; throws `AuditUnavailable` in stateless mode, on
 * a read-only or locked handle, or when the insert fails. Other sinks (stdout, file) get the entry after the commit.
 * With `db` inside an open transaction the row joins it (see `auditRequiredIn`).
 */
export function auditRequired(event: string, fields: Fields = {}): void {
  auditRequiredIn(storeDb, event, fields)()
}

/**
 * Transaction variant: the row joins the caller's open transaction on `db`, so the change and its row commit or roll back
 * together. Returns `publish`, which the caller invokes after COMMIT to send the entry to the other sinks.
 */
export function auditRequiredIn(db: DatabaseSync | undefined, event: string, fields: Fields = {}): () => void {
  checkCatalog(event)
  if (!db) throw new AuditUnavailable('not available in this mode')
  const entry = entryOf(event, fields)
  try {
    storeWriterFor(db).insert(entry)
  } catch (error) {
    throw new AuditUnavailable(error instanceof Error ? error.message : 'write failed')
  }
  return () => {
    for (const sink of listSinks()) {
      if (sink.name === STORE_SINK) continue
      try {
        sink.write(entry)
      } catch {
        // required row is already committed; other sinks are best effort
      }
    }
  }
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

export type RowsChangeAuditEvent = {
  user: string
  target: string
  db: string
  table: string
  operation: 'insert' | 'update' | 'delete'
  rowCount: number
  statementCount: number
  maxClass: 'none' | 'soft' | 'hard'
  identityKind: 'primary' | 'unique' | 'all-columns'
  outcome: 'ok' | 'conflict' | 'gone' | 'error' | 'partial'
  errno?: number
  durationMs?: number
  planId?: string
}

/** One line per applied or attempted row plan: counts and outcome only, never values, keys or SQL (FR-ROW-024). */
export function auditRowsChange(event: RowsChangeAuditEvent): void {
  audit('rows.change', {
    user: event.user,
    target: event.target,
    db: event.db,
    table: event.table,
    operation: event.operation,
    rowCount: event.rowCount,
    statementCount: event.statementCount,
    class: event.maxClass,
    identityKind: event.identityKind,
    outcome: event.outcome,
    errno: event.errno,
    durationMs: event.durationMs,
    planId: event.planId,
  })
}

export type RowsRefusedAuditEvent = {
  user: string
  target: string
  db: string
  table: string
  operation?: 'insert' | 'update' | 'delete'
  /** Stable refusal code (read-only, token-missing, ...). */
  code: string
}

/** One line per refused row write (FR-ROW-024). */
export function auditRowsRefused(event: RowsRefusedAuditEvent): void {
  audit('rows.refused', {
    user: event.user,
    target: event.target,
    db: event.db,
    table: event.table,
    operation: event.operation,
    code: event.code,
  })
}

export type IoAuditFields = {
  user: string
  target: string
  jobId?: string
  uploadId?: string
  kind?: 'export' | 'import'
  scope?: string
  format?: string
  compression?: string
  /** Database and object names are identifiers, not row values. */
  db?: string
  objects?: string
  fileName?: string
  bytes?: number
  rows?: number
  statements?: number
  /** Statement counts by class, e.g. "none:10,soft:3,hard:1". */
  classCounts?: string
  state?: string
  errorCode?: string
  errno?: number
  durationMs?: number
  /** Hash of a failing statement; never its text. */
  statementHash?: string
  statementNumber?: number
}

export type IoAuditEventName =
  | 'io.export.start'
  | 'io.export.end'
  | 'io.import.start'
  | 'io.import.end'
  | 'io.import.analyse'
  | 'io.job.cancel'
  | 'io.job.resume'
  | 'io.upload'
  | 'io.upload.refused'

/** One line per io event: names, counts and outcome only; no row values, statement text or credentials (FR-IO-021). */
export function auditIo(event: IoAuditEventName, fields: IoAuditFields): void {
  audit(event, {
    user: fields.user,
    target: fields.target,
    jobId: fields.jobId,
    uploadId: fields.uploadId,
    kind: fields.kind,
    scope: fields.scope,
    format: fields.format,
    compression: fields.compression,
    db: fields.db,
    objects: fields.objects,
    fileName: fields.fileName,
    bytes: fields.bytes,
    rows: fields.rows,
    statements: fields.statements,
    classCounts: fields.classCounts,
    state: fields.state,
    errorCode: fields.errorCode,
    errno: fields.errno,
    durationMs: fields.durationMs,
    statementHash: fields.statementHash,
    statementNumber: fields.statementNumber,
  })
}
