/**
 * Contracts of module `sql-tab` (SPEC/23-module-sql-tab.md, task 0). Frozen: packages A-D build on this
 * file and only the coordinating agent changes it. Requirement ids are FR-SQL-nnn of file 23.
 */
import { z } from 'zod'
import type { Cell } from '../db/rows'
import type { StatementClass, StructureError } from '../structure/types'

// ---- Lexer, splitter (package A, section 5.2) ------------------------------------------------------

export type SqlStatementFlags = {
  /** Contains a `/*!` or `/*M!` executable comment. */
  executableComment: boolean
  /** The statement text is empty after comments are removed. */
  empty: boolean
}

export type SqlStatementText = {
  /** The text as typed, without the delimiter. */
  text: string
  /** Offsets into the original input; `end` is exclusive and excludes the delimiter. */
  start: number
  end: number
  /** Upper-case first keyword after comments ('' when empty). */
  firstKeyword: string
  flags: SqlStatementFlags
}

export type SplitOptions = {
  delimiter?: string
  noBackslashEscapes?: boolean
  ansiQuotes?: boolean
}

export type SplitError = { code: 'unterminated-string' | 'unterminated-comment'; at: number }
export type SplitResult = { statements: SqlStatementText[]; errors: SplitError[] }

// ---- Classification (package A, section 5.3) -------------------------------------------------------

export const SQL_KINDS = [
  'select',
  'show',
  'describe',
  'explain',
  'use',
  'setSession',
  'setGlobal',
  'txControl',
  'insert',
  'replace',
  'update',
  'delete',
  'call',
  'lock',
  'loadData',
  'selectInto',
  'createObject',
  'alterObject',
  'dropObject',
  'renameObject',
  'truncate',
  'account',
  'admin',
  'kill',
  'prepare',
  'unknown',
] as const
export type SqlKind = (typeof SQL_KINDS)[number]

/** Closed set of reason codes (FR-SQL-005). */
export type ClassificationReason =
  | 'no-where'
  | 'constant-where'
  | 'limit-only'
  | 'drop'
  | 'truncate'
  | 'alter-drop'
  | 'narrowing'
  | 'account'
  | 'global-set'
  | 'load-data'
  | 'into-outfile'
  | 'admin'
  | 'unparsed'
  | 'unknown-keyword'
  | 'multi-statement-explain'
  | 'parser-off'
  | 'budget'

export type Classification = {
  kind: SqlKind
  class: StatementClass
  /** True only for none-class reads; used for read-only connections (SEC-TGT-052). */
  readOnlySafe: boolean
  commitsImplicitly: boolean
  reasons: ClassificationReason[]
  /** Facts for estimate and `structure.changed`; never used to build SQL. */
  tables?: { db?: string; table: string }[]
  /** Databases created or dropped by CREATE/DROP DATABASE or SCHEMA (the parser reports no name for CREATE). */
  databases?: string[]
}

export type ClassifiedStatement = SqlStatementText & { classification: Classification }

// ---- Limits (package B, section 5.4; ST-110, 114, 115, 161 bounded by .env) --------------------------

export type SqlLimits = {
  rowCap: number // per result set
  responseBytes: number // per run
  cellBytes: number // per cell
  timeoutMs: number // per statement
  maxStatements: number // per run
  maxConcurrentRuns: number // per session
  historyEntries: number
  historyDays: number
  historyEntryBytes: number
}

export const DEFAULT_SQL_LIMITS: SqlLimits = {
  rowCap: 10_000,
  responseBytes: 16 * 1024 * 1024,
  cellBytes: 64 * 1024,
  timeoutMs: 60_000,
  maxStatements: 500,
  maxConcurrentRuns: 2,
  historyEntries: 100,
  historyDays: 30,
  historyEntryBytes: 64 * 1024,
}

// ---- Run input and output (server functions, section 5.7) ---------------------------------------------

export const sqlRunOptions = z
  .object({
    continueOnError: z.boolean().default(false),
    singleTransaction: z.boolean().default(false),
    disableForeignKeyChecks: z.boolean().default(false),
    /** User preference: also confirm soft-class statements. */
    confirmSoft: z.boolean().default(false),
  })
  .strict()
export type SqlRunOptions = z.infer<typeof sqlRunOptions>

const runId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
const dbName = z.string().min(1).max(64)

export const runSqlInput = z
  .object({
    runId,
    tabId: z.string().min(1).max(64),
    db: dbName.optional(),
    /** Whole editor text; at most 1 MiB. */
    text: z.string().min(1).max(1_048_576),
    /** Selection or statement under the cursor, as offsets into `text`. */
    range: z
      .object({ from: z.number().int().min(0), to: z.number().int().min(0) })
      .strict()
      .optional(),
    options: sqlRunOptions.default({
      continueOnError: false,
      singleTransaction: false,
      disableForeignKeyChecks: false,
      confirmSoft: false,
    }),
  })
  .strict()
export type RunSqlInput = z.infer<typeof runSqlInput>

export const confirmSqlInput = z
  .object({
    runId,
    planId: z.string().min(8).max(128),
    confirmToken: z.string().max(512).optional(),
  })
  .strict()
export type ConfirmSqlInput = z.infer<typeof confirmSqlInput>

export const cancelSqlInput = z.object({ runId }).strict()
export type CancelSqlInput = z.infer<typeof cancelSqlInput>

export const planAnalyseInput = z
  .object({ db: dbName.optional(), text: z.string().min(1).max(1_048_576) })
  .strict()
export type PlanAnalyseInput = z.infer<typeof planAnalyseInput>

export const explainSqlInput = z
  .object({
    db: dbName.optional(),
    text: z.string().min(1).max(1_048_576),
    mode: z.enum(['explain', 'analyse']),
    format: z.enum(['json', 'tree', 'text']).default('json'),
    planId: z.string().min(8).max(128).optional(),
    confirmToken: z.string().max(512).optional(),
  })
  .strict()
export type ExplainSqlInput = z.infer<typeof explainSqlInput>

export const estimateAffectedInput = z
  .object({ db: dbName.optional(), text: z.string().min(1).max(1_048_576) })
  .strict()
export type EstimateAffectedInput = z.infer<typeof estimateAffectedInput>

export type SqlColumnMeta = { name: string; type: string; table?: string }

export type SqlTruncation = { reason: 'rows' | 'bytes'; limit: number }

export type SqlWarning = { level: string; code: number; message: string }

/**
 * Where a server syntax error sits: 1-based `line` and `column`, relative to the text of the statement
 * (`sql` of the result as typed; line 1 is the statement's first line), not to the whole editor text.
 */
export type SqlErrorPosition = { line: number; column: number }

export type SqlStatementResult =
  | {
      status: 'rows'
      index: number
      /** The statement as typed, shortened for display; the full text stays in the editor. */
      sql: string
      columns: SqlColumnMeta[]
      rows: Cell[][]
      rowCount: number
      truncated?: SqlTruncation
      warnings: SqlWarning[]
      durationMs: number
    }
  | {
      status: 'ok'
      index: number
      sql: string
      affectedRows: number
      insertId?: string
      info?: string
      warnings: SqlWarning[]
      durationMs: number
    }
  | {
      status: 'failed'
      index: number
      sql: string
      error: StructureError & { position?: SqlErrorPosition }
      durationMs: number
    }
  | { status: 'not-run'; index: number; sql: string }

/**
 * What a run changed in the structure (FR-SQL-025): a table (`db`, `table`; `db` is absent when the statement
 * named none and the session had no database), or a database (`database: true`, `db` the name).
 */
export type SqlChange = { db?: string; table?: string; database?: true }

export type SqlPlanStatement = {
  index: number
  /** Shortened for display. */
  sql: string
  /** The full statement text, for the affected-rows estimate; absent when longer than 64 KiB. */
  fullSql?: string
  class: StatementClass
  reasons: ClassificationReason[]
}

/** Responses of the list functions and of getSqlLimits say whether the data lasts for the session only. */
export type StatelessFlag = { stateless: boolean }
export type SqlLimitsResponse = SqlLimits & StatelessFlag

export type SqlRunResponse =
  | {
      kind: 'done'
      runId: string
      ok: boolean
      results: SqlStatementResult[]
      /** Set when the text contained a USE (database after the run). */
      db?: string
      /** Server-reported warnings that came from the run options (e.g. FK checks off). */
      notes: string[]
      /** Structure changes of the statements that ran (create, alter, drop, rename, truncate). */
      changed?: SqlChange[]
    }
  | {
      kind: 'confirm'
      runId: string
      planId: string
      statements: SqlPlanStatement[]
      /** Statements in the whole batch (the list above holds only those needing confirmation). */
      totalStatements?: number
      /** `soft`: confirm button only; `hard`: typed acknowledgement plus token. */
      maxClass: StatementClass
      confirmRequired: boolean
      confirmToken?: string
      expiresAt: number
    }

export type SqlExplainResponse = {
  mode: 'explain' | 'analyse'
  format: 'json' | 'tree' | 'text'
  /** Raw server output (text or JSON string); the UI builds the tree with lib/sql/plan-tree. */
  raw: string
  durationMs: number
}

export type SqlEstimateResponse = { estimatedRows: number | null; note?: string }

// ---- History and bookmarks (package C, section 5.8) -----------------------------------------------------

export type HistorySource = 'user' | 'generated' | 'assistant'

export type HistoryEntry = {
  id: number
  createdAt: number
  source: HistorySource
  targetKey: string
  db: string | null
  /** Redacted; null when the entry was over the size limit (`sqlOmitted`). */
  sql: string | null
  sqlOmitted: boolean
  statements: number
  executed: number
  failedIndex: number | null
  maxClass: StatementClass
  outcome: 'ok' | 'failed' | 'cancelled' | 'timeout' | 'refused'
  durationMs: number
}

export type NewHistoryEntry = Omit<HistoryEntry, 'id'>

export type Bookmark = {
  id: string
  targetKey: string
  name: string
  sql: string
  db: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Store of history and bookmarks. Every method takes the owner key (direct mode: the normalised target
 * key; account mode: the DBLoom user id) and filters by it; there is no method without it (SCN-030).
 */
export interface SqlStateStore {
  addHistory(ownerKey: string, entry: NewHistoryEntry): HistoryEntry
  listHistory(
    ownerKey: string,
    opts: {
      cursor?: number
      limit: number
      source?: HistorySource
      targetKey?: string
      query?: string
    },
  ): { entries: HistoryEntry[]; nextCursor: number | null }
  deleteHistory(ownerKey: string, ids: number[]): number
  clearHistory(ownerKey: string): number
  pruneHistory(ownerKey: string, maxEntries: number, maxAgeMs: number, now?: number): number
  saveBookmark(
    ownerKey: string,
    b: { id?: string; targetKey: string; name: string; sql: string; db: string | null },
  ): Bookmark
  listBookmarks(ownerKey: string, opts?: { targetKey?: string }): Bookmark[]
  renameBookmark(ownerKey: string, id: string, name: string): Bookmark | undefined
  deleteBookmark(ownerKey: string, id: string): boolean
}

export const listHistoryInput = z
  .object({
    cursor: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    source: z.enum(['user', 'generated', 'assistant']).optional(),
    query: z.string().max(200).optional(),
  })
  .strict()
export type ListHistoryInput = z.infer<typeof listHistoryInput>

export const deleteHistoryInput = z.union([
  z.object({ ids: z.array(z.number().int()).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
])
export type DeleteHistoryInput = z.infer<typeof deleteHistoryInput>

export const saveBookmarkInput = z
  .object({
    id: z.string().max(64).optional(),
    name: z.string().min(1).max(100),
    sql: z.string().min(1).max(262_144),
    db: dbName.nullable().optional(),
  })
  .strict()
export type SaveBookmarkInput = z.infer<typeof saveBookmarkInput>

export const renameBookmarkInput = z
  .object({ id: z.string().max(64), name: z.string().min(1).max(100) })
  .strict()
export const deleteBookmarkInput = z.object({ id: z.string().max(64) }).strict()

export const completionSchemaInput = z
  .object({ db: dbName.optional(), table: z.string().min(1).max(64).optional() })
  .strict()
export type CompletionSchemaInput = z.infer<typeof completionSchemaInput>

export type CompletionSchema = {
  databases: string[]
  tables: { name: string; kind: 'table' | 'view' }[]
  columns?: { name: string; type: string }[]
}

// ---- Hooks for other modules (package B, FR-SQL-026, 027) -------------------------------------------------

/** Export of a result set re-runs the statement under the same guard (module io). */
export type ExportSource = { db?: string; text: string; limits: Partial<SqlLimits> }

/** The assistant runs read-only statements through this entry point (module assistant). */
export type AssistantRunRequest = { db?: string; text: string; conversationId: string }
