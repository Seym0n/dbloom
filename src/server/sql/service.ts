import type { RowDataPacket } from 'mysql2/promise'
import { getRuntime } from '../runtime'
import type { LiveSession } from '../sessions'
import { createTokenIssuer } from '../structure/deps'
import { StructureRefusal, toClientError } from '../structure/errors'
import { planStore } from '../structure/plans'
import {
  cancelRun,
  confirmSqlRun,
  estimateAffected,
  explainSql,
  planAnalyse,
  redactSql,
  resolveSqlLimits,
  runSqlText,
  type HistoryRecord,
  type SqlRunEnv,
} from './deps'
import { getSqlState, isStateless, ownerKeyOf, SqlStateError } from './state'
import {
  cancelSqlInput,
  completionSchemaInput,
  confirmSqlInput,
  deleteBookmarkInput,
  deleteHistoryInput,
  estimateAffectedInput,
  explainSqlInput,
  listHistoryInput,
  planAnalyseInput,
  renameBookmarkInput,
  runSqlInput,
  saveBookmarkInput,
  type Bookmark,
  type CancelSqlInput,
  type CompletionSchema,
  type CompletionSchemaInput,
  type ConfirmSqlInput,
  type DeleteHistoryInput,
  type EstimateAffectedInput,
  type ExplainSqlInput,
  type HistoryEntry,
  type ListHistoryInput,
  type PlanAnalyseInput,
  type RunSqlInput,
  type SaveBookmarkInput,
  type SqlEstimateResponse,
  type SqlExplainResponse,
  type SqlLimitsResponse,
  type SqlRunResponse,
  type SqlStateStore,
} from './types'

// Plain functions, testable without HTTP. Server functions are in ../sql.functions.ts.

export type SqlEnv = SqlRunEnv & {
  state: SqlStateStore
  /** Direct mode: `host[zone]:port|username`; stateless mode: the session id hash. */
  ownerKey: string
  /** Test seams; default to package B. */
  runner?: typeof runSqlText
  confirmer?: typeof confirmSqlRun
}

const tokens = createTokenIssuer()

export const targetKeyOf = (t: LiveSession['target']) => `${t.host}${t.zone ?? ''}:${t.port}`

export function ownerKeyFor(session: Pick<LiveSession, 'idHash' | 'target'>): string {
  return isStateless() ? session.idHash : ownerKeyOf(session.target)
}

/** FR-SQL-028: `DBLOOM_SQL_DISABLED=true` turns the whole module off. */
export const isSqlDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DBLOOM_SQL_DISABLED?.trim().toLowerCase() === 'true'

export function assertSqlEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (isSqlDisabled(env)) {
    throw toClientError(
      new StructureRefusal('sql_disabled', 'The SQL tab is disabled on this server'),
    )
  }
}

export function envOf(session: LiveSession, signal?: AbortSignal): SqlEnv {
  assertSqlEnabled()
  const runtime = getRuntime()
  const env: SqlEnv = {
    session,
    guard: { forcedReadOnly: runtime.config.readOnly, sessionReadOnly: session.readOnly },
    tokens,
    limits: resolveSqlLimits(runtime.config),
    plans: planStore,
    state: getSqlState(runtime),
    ownerKey: ownerKeyFor(session),
    ...(signal ? { signal } : {}),
  }
  env.recordHistory = historySink(env)
  return env
}

/** Wraps a run so the runner reports to the history; a failure to write never fails the run. */
export function historySink(env: SqlEnv): (record: HistoryRecord) => void {
  return (record) => {
    try {
      // null: redaction failed, keep the entry without text (spec 5.10)
      const sql = redactSql(record.text)
      env.state.addHistory(env.ownerKey, {
        createdAt: (env.now ?? Date.now)(),
        source: record.source ?? 'user',
        targetKey: targetKeyOf(env.session.target),
        db: record.db,
        sql,
        sqlOmitted: sql === null,
        statements: record.statements,
        executed: record.executed,
        failedIndex: record.failedIndex,
        maxClass: record.maxClass,
        outcome: record.outcome,
        durationMs: record.durationMs,
      })
    } catch {
      // never log the entry: it holds SQL text
    }
  }
}

/** State-store refusals become the `code: message` form the client sees. */
function clientError(error: unknown): Error {
  if (error instanceof SqlStateError)
    return toClientError(new StructureRefusal(error.code, error.message))
  return toClientError(error)
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw clientError(error)
  }
}

// ---- Input parsing (zod .strict(): unknown keys are errors, FR-SQL-001) ----------------------------------

export const parseRunInput = (raw: unknown): RunSqlInput => runSqlInput.parse(raw)
export const parseConfirmInput = (raw: unknown): ConfirmSqlInput => confirmSqlInput.parse(raw)
export const parseCancelInput = (raw: unknown): CancelSqlInput => cancelSqlInput.parse(raw)
export const parsePlanAnalyseInput = (raw: unknown): PlanAnalyseInput => planAnalyseInput.parse(raw)
export const parseExplainInput = (raw: unknown): ExplainSqlInput => explainSqlInput.parse(raw)
export const parseEstimateInput = (raw: unknown): EstimateAffectedInput =>
  estimateAffectedInput.parse(raw)
export const parseListHistoryInput = (raw: unknown): ListHistoryInput => listHistoryInput.parse(raw)
export const parseDeleteHistoryInput = (raw: unknown): DeleteHistoryInput =>
  deleteHistoryInput.parse(raw)
export const parseSaveBookmarkInput = (raw: unknown): SaveBookmarkInput =>
  saveBookmarkInput.parse(raw)
export const parseRenameBookmarkInput = (raw: unknown) => renameBookmarkInput.parse(raw)
export const parseDeleteBookmarkInput = (raw: unknown) => deleteBookmarkInput.parse(raw)
export const parseCompletionInput = (raw: unknown): CompletionSchemaInput =>
  completionSchemaInput.parse(raw)

// ---- Run, confirm, cancel, explain, estimate ----------------------------------------------------------------

export const runSqlImpl = (env: SqlEnv, input: RunSqlInput): Promise<SqlRunResponse> =>
  guarded(() => (env.runner ?? runSqlText)(env, input))

export const confirmSqlImpl = (env: SqlEnv, input: ConfirmSqlInput): Promise<SqlRunResponse> =>
  guarded(() => (env.confirmer ?? confirmSqlRun)(env, input))

export const cancelSqlImpl = (env: SqlEnv, input: CancelSqlInput): Promise<{ ok: true }> =>
  guarded(async () => {
    await cancelRun(env, input.runId)
    return { ok: true as const } // the same answer for an unknown or finished run
  })

export const explainSqlImpl = (env: SqlEnv, input: ExplainSqlInput): Promise<SqlExplainResponse> =>
  guarded(() => explainSql(env, input))

export const planAnalyseImpl = (
  env: SqlEnv,
  input: PlanAnalyseInput,
): Promise<Extract<SqlRunResponse, { kind: 'confirm' }>> => guarded(() => planAnalyse(env, input))

export const estimateAffectedImpl = (
  env: SqlEnv,
  input: EstimateAffectedInput,
): Promise<SqlEstimateResponse> => guarded(() => estimateAffected(env, input))

export const getSqlLimitsImpl = (env: SqlEnv): SqlLimitsResponse => ({
  ...env.limits,
  stateless: isStateless(),
})

// ---- History and bookmarks ----------------------------------------------------------------------------------

export const listHistoryImpl = (
  env: SqlEnv,
  input: ListHistoryInput,
): Promise<{ entries: HistoryEntry[]; nextCursor: number | null; stateless: boolean }> =>
  guarded(() => ({
    stateless: isStateless(),
    ...env.state.listHistory(env.ownerKey, {
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
    }),
  }))

export const deleteHistoryImpl = (
  env: SqlEnv,
  input: DeleteHistoryInput,
): Promise<{ deleted: number }> =>
  guarded(() => ({
    deleted:
      'all' in input
        ? env.state.clearHistory(env.ownerKey)
        : env.state.deleteHistory(env.ownerKey, input.ids),
  }))

export const saveBookmarkImpl = (env: SqlEnv, input: SaveBookmarkInput): Promise<Bookmark> =>
  guarded(() => {
    // Same redaction as the history; if it fails nothing is stored (a bookmark without text is useless).
    const sql = redactSql(input.sql)
    if (sql === null) throw new StructureRefusal('invalid_request', 'This text cannot be saved')
    return env.state.saveBookmark(env.ownerKey, {
      ...(input.id !== undefined ? { id: input.id } : {}),
      targetKey: targetKeyOf(env.session.target),
      name: input.name,
      sql,
      db: input.db ?? null,
    })
  })

export const listBookmarksImpl = (
  env: SqlEnv,
): Promise<{ bookmarks: Bookmark[]; stateless: boolean }> =>
  guarded(() => ({
    bookmarks: env.state.listBookmarks(env.ownerKey, {
      targetKey: targetKeyOf(env.session.target),
    }),
    stateless: isStateless(),
  }))

export const renameBookmarkImpl = (
  env: SqlEnv,
  input: { id: string; name: string },
): Promise<Bookmark> =>
  guarded(() => {
    const b = env.state.renameBookmark(env.ownerKey, input.id, input.name)
    if (!b) throw new StructureRefusal('not_found', 'Not found')
    return b
  })

export const deleteBookmarkImpl = (env: SqlEnv, input: { id: string }): Promise<{ ok: true }> =>
  guarded(() => {
    if (!env.state.deleteBookmark(env.ownerKey, input.id)) {
      throw new StructureRefusal('not_found', 'Not found')
    }
    return { ok: true as const }
  })

// ---- Completion schema --------------------------------------------------------------------------------------

const MAX_ITEMS = 20_000

/** Lazy metadata for the editor: databases, then tables of one database, then columns of one table. */
export function getCompletionSchemaImpl(
  env: SqlEnv,
  input: CompletionSchemaInput,
): Promise<CompletionSchema> {
  return guarded(async () => {
    const pool = env.session.pool
    const [dbRows] = await pool.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT ?',
      [MAX_ITEMS],
    )
    const databases = dbRows.map((r) => String(r.n))
    const out: CompletionSchema = { databases, tables: [] }
    if (input.db === undefined) return out
    // The name must exist on the server (SEC-TGT-116); compared exactly as the server reports it.
    if (!databases.includes(input.db)) throw new StructureRefusal('not_found', 'Not found')
    const [tRows] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ?`,
      [input.db, MAX_ITEMS],
    )
    out.tables = tRows.map((r) => ({
      name: String(r.n),
      kind: /VIEW/i.test(String(r.t)) ? ('view' as const) : ('table' as const),
    }))
    if (input.table === undefined) return out
    if (!out.tables.some((t) => t.name === input.table)) {
      throw new StructureRefusal('not_found', 'Not found')
    }
    const [cRows] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT ?`,
      [input.db, input.table, MAX_ITEMS],
    )
    out.columns = cRows.map((r) => ({ name: String(r.n), type: String(r.t) }))
    return out
  })
}
