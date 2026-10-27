/**
 * Contracts of module `io` (SPEC/25-module-io.md, task 0). Frozen: packages A-F build on this file and
 * only the coordinating agent changes it. Requirement ids are FR-IO-nnn of file 25; section numbers refer to it.
 */
import { z } from 'zod'
import type { StatementClass } from '../structure/types'

export type { StatementClass } from '../structure/types'

// ---- Closed lists (FR-IO-002, SEC-PLG-001: nothing outside these is accepted) -------------------------

export const EXPORT_FORMATS = ['sql', 'csv', 'json'] as const
export type IoFormat = (typeof EXPORT_FORMATS)[number]
export const ioFormat = z.enum(EXPORT_FORMATS)

export const COMPRESSIONS = ['none', 'gzip', 'zip'] as const
export type Compression = (typeof COMPRESSIONS)[number]
export const compression = z.enum(COMPRESSIONS)

/** Single characters only; fixed allow-lists (FR-IO-006, SEC-TGT-154). */
export const CSV_SEPARATORS = [',', ';', '\t', '|', ':'] as const
export const CSV_ENCLOSURES = ['"', "'", ''] as const
export const CSV_ESCAPES = ['"', '\\', ''] as const
export const CSV_LINE_ENDINGS = ['lf', 'crlf', 'auto'] as const

// ---- Names -----------------------------------------------------------------------------------------

const name = z.string().min(1).max(64)
const idString = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)

// ---- Limits (FR-IO-022, section 5.8) ---------------------------------------------------------------

export const MiB = 1024 * 1024
export const GiB = 1024 * MiB
/** Hard-wired, ENV-only (ST-151). */
export const MAX_COMPRESSION_RATIO = 100
export const MAX_ARCHIVE_ENTRIES = 1
export const JOB_RETENTION_MS = 24 * 3_600_000
export const JOB_RECORD_MAX_BYTES = 4096
export const MAX_EXPORTS_PER_USER = 2
export const TEXT_VIEW_MAX_BYTES = 2 * MiB
export const MAX_TEMPLATES = 50
export const MAX_TEMPLATE_NAME = 120
export const MAX_FILENAME_CHARS = 120
export const INSERT_BATCH_ROWS = 500
export const DEFAULT_EXTENDED_INSERT_BYTES = 1 * MiB
export const TYPE_SAMPLE_ROWS = 10_000
export const MAX_REJECT_DETAILS = 100
export const MAX_ALTER_EVENTS = 200

export type IoLimits = {
  uploadBytes: number
  decompressedBytes: number
  jobMs: number
  maxExportBytes: number
  concurrentImports: number
  formats: IoFormat[]
  compressions: Compression[]
  serverFolderEnabled: boolean
  formulaNeutralisation: boolean
  tempQuotaBytes: number
}

// ---- Export options (FR-IO-004 to 007) -------------------------------------------------------------

export const sqlExportOptions = z
  .object({
    content: z.enum(['structure', 'data', 'both']).default('both'),
    statement: z.enum(['insert', 'insertIgnore', 'replace']).default('insert'),
    comments: z.boolean().default(true),
    customComment: z.string().max(500).default(''),
    foreignKeyChecksOff: z.boolean().default(true),
    transaction: z.boolean().default(true),
    createDatabase: z.boolean().default(false),
    dropDatabase: z.boolean().default(false),
    dropObjects: z.boolean().default(false),
    ifNotExists: z.boolean().default(false),
    keysInCreateTable: z.boolean().default(true),
    autoIncrementValue: z.boolean().default(true),
    routines: z.boolean().default(false),
    triggers: z.boolean().default(true),
    events: z.boolean().default(false),
    views: z.boolean().default(true),
    extendedInserts: z.boolean().default(true),
    extendedInsertBytes: z.number().int().min(1024).max(16 * MiB).default(DEFAULT_EXTENDED_INSERT_BYTES),
    tableStatementsTogether: z.boolean().default(false),
  })
  .strict()
export type SqlExportOptions = z.infer<typeof sqlExportOptions>

export const csvExportOptions = z
  .object({
    preset: z.enum(['plain', 'excel']).default('plain'),
    separator: z.enum(CSV_SEPARATORS).default(','),
    enclosure: z.enum(CSV_ENCLOSURES).default('"'),
    escape: z.enum(CSV_ESCAPES).default('"'),
    lineEnding: z.enum(['lf', 'crlf']).default('lf'),
    nullText: z.string().max(16).default(''),
    header: z.boolean().default(true),
    bom: z.boolean().default(false),
    removeLineBreaks: z.boolean().default(false),
    /** Undefined = use the resolved default (ST-157); the administrator may forbid switching it off. */
    neutraliseFormulas: z.boolean().optional(),
  })
  .strict()
export type CsvExportOptions = z.infer<typeof csvExportOptions>

export const jsonExportOptions = z
  .object({
    pretty: z.boolean().default(true),
    unicode: z.boolean().default(true),
  })
  .strict()
export type JsonExportOptions = z.infer<typeof jsonExportOptions>

// ---- Export request (FR-IO-002, section 5.2) -------------------------------------------------------

const exportScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), databases: z.array(name).max(1000).optional() }).strict(),
  z
    .object({
      kind: z.literal('database'),
      db: name,
      tables: z.array(name).max(100_000).optional(),
      maxTableMiB: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('table'),
      db: name,
      table: name,
      range: z
        .object({ offset: z.number().int().min(0), count: z.number().int().min(1).max(2_000_000_000) })
        .strict()
        .optional(),
    })
    .strict(),
  /** Names a statement of the SQL tab; io re-splits and re-checks it through `openResultStream` (FR-IO-003). */
  z
    .object({
      kind: z.literal('result'),
      db: name.optional(),
      text: z.string().min(1).max(256 * 1024),
      statementIndex: z.number().int().min(0).max(10_000),
    })
    .strict(),
])
export type ExportScope = z.infer<typeof exportScope>

const exportCommon = {
  scope: exportScope,
  compression,
  separateFiles: z.boolean().default(false),
  view: z.enum(['file', 'text']).default('file'),
  fileNameTemplate: z.string().max(MAX_TEMPLATE_NAME).optional(),
  lock: z.boolean().default(false),
  skipUnreadable: z.boolean().default(false),
}

export const exportRequest = z.discriminatedUnion('format', [
  z.object({ ...exportCommon, format: z.literal('sql'), options: sqlExportOptions.default(() => sqlExportOptions.parse({})) }).strict(),
  z.object({ ...exportCommon, format: z.literal('csv'), options: csvExportOptions.default(() => csvExportOptions.parse({})) }).strict(),
  z.object({ ...exportCommon, format: z.literal('json'), options: jsonExportOptions.default(() => jsonExportOptions.parse({})) }).strict(),
])
export type ExportRequest = z.infer<typeof exportRequest>

// ---- Import (FR-IO-016 to 019) ---------------------------------------------------------------------

export const sqlImportOptions = z
  .object({
    skipStatements: z.number().int().min(0).max(1_000_000_000).default(0),
    ignoreErrors: z.boolean().default(false),
    rollbackOnError: z.boolean().default(false),
    /** Undefined = resolved default (ST-160). */
    foreignKeyChecksOff: z.boolean().optional(),
    skipRefused: z.boolean().default(false),
  })
  .strict()
export type SqlImportOptions = z.infer<typeof sqlImportOptions>

export const rowImportOptions = z
  .object({
    separator: z.enum(CSV_SEPARATORS).default(','),
    enclosure: z.enum(CSV_ENCLOSURES).default('"'),
    escape: z.enum(CSV_ESCAPES).default('"'),
    lineEnding: z.enum(CSV_LINE_ENDINGS).default('auto'),
    nullText: z.string().max(16).default(''),
    header: z.boolean().default(false),
    skipRows: z.number().int().min(0).max(1_000_000_000).default(0),
    conflict: z.enum(['error', 'ignore', 'replace']).default('error'),
    mode: z.enum(['allOrNothing', 'keepGoing']).default('allOrNothing'),
    /** JSON: which `table` element of a DBLoom export to read. */
    jsonTable: name.optional(),
    /** Undo the leading `'` that export puts before `= + - @` (FR-IO-023). */
    revertFormulaPrefix: z.boolean().default(true),
  })
  .strict()
export type RowImportOptions = z.infer<typeof rowImportOptions>

export const columnMap = z
  .object({ source: z.union([z.string().min(1).max(256), z.number().int().min(0).max(4096)]), target: name.nullable() })
  .strict()
export type ColumnMap = z.infer<typeof columnMap>

export const IMPORT_CHARSET_MAX = 40
export const analyseRequest = z
  .object({
    /** An upload id, or the id of a server import folder file (FR-IO-013). */
    uploadId: idString,
    format: ioFormat,
    charset: z.string().max(IMPORT_CHARSET_MAX).optional(),
    /** CSV/JSON row options, so the sample preview follows the user's choices. */
    rowOptions: rowImportOptions.optional(),
  })
  .strict()

export const startImportRequest = z
  .object({
    uploadId: idString,
    format: ioFormat,
    charset: z.string().max(IMPORT_CHARSET_MAX).optional(),
    db: name.optional(),
    table: name.optional(),
    /** New table: the typed model of `structure`, validated there; SQL comes only from its builder. */
    newTable: z.unknown().optional(),
    options: z.union([sqlImportOptions, rowImportOptions]),
    mapping: z.array(columnMap).max(4096).optional(),
    confirmToken: z.string().min(16).max(2048).optional(),
  })
  .strict()
export type StartImportRequest = z.infer<typeof startImportRequest>

// ---- Analysis (FR-IO-016) --------------------------------------------------------------------------

export type ImportStatementClass = StatementClass | 'refused'

export type ImportAnalysis = {
  uploadId: string
  /** Hash over everything the confirmation token binds to. */
  analysisHash: string
  fileName: string
  bytes: number
  compression: Compression
  format: IoFormat
  charset: string
  statements?: {
    total: number
    byClass: Record<ImportStatementClass, number>
    /** Kinds of hard and refused statements with counts, e.g. { 'GRANT': 3, 'DROP TABLE': 1 }. */
    hardKinds: Record<string, number>
    refusedKinds: Record<string, number>
    createsDatabases: string[]
    dropsDatabases: string[]
    usesDatabase: boolean
    needsDatabase: boolean
  }
  rows?: {
    columns: string[]
    sample: (string | null)[][]
    rowCount: number | null
    warnings: ParseProblem[]
    /** Inferred SQL type per column (FR-IO-019), from the first TYPE_SAMPLE_ROWS rows. */
    inferred?: string[]
    /** JSON: names of the `table` elements of a DBLoom export. */
    jsonTables?: string[]
  }
  confirmRequired: boolean
  /** Issued only when confirmRequired; single use, bound to this analysis (FR-IO-016, SEC-TGT-118). */
  confirmToken?: string
}

export type ParseProblem = { row: number; column?: string; code: string; message: string }

// ---- Jobs (FR-IO-001) ------------------------------------------------------------------------------

export type JobKind = 'export' | 'import'
export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'done_with_skips' | 'done_with_rejects' | 'failed' | 'cancelled'

export type JobProgress = {
  bytes: number
  totalBytes?: number
  rows?: number
  statements?: number
  object?: { index: number; total: number; name: string }
}

export type JobResult = {
  fileName?: string
  skipped: { object: string; message: string }[]
  rejected: ParseProblem[]
  rejectedCount: number
  notes: string[]
  /** New table created by a row import, so the UI can offer to drop it. */
  createdTable?: { db: string; table: string }
  statements?: { run: number; skipped: number; failed: number }
  rows?: number
  error?: IoError
  /** Resume point of a paused import: byte offset of the decoded stream after the last whole statement. */
  resume?: { decodedOffset: number; statementNumber: number }
  durationMs: number
}

export type IoJob = {
  id: string
  kind: JobKind
  state: JobState
  progress: JobProgress
  result?: JobResult
  startedAt: number
  endedAt?: number
}

// ---- Errors (FR-IO-012, FR-IO-010: closed list; the server's text is data, escaped on output) --------

export const IO_ERROR_CODES = [
  'busy',
  'read_only',
  'format_disabled',
  'invalid_request',
  'upload_too_large',
  'upload_interrupted',
  'upload_empty',
  'quota_full',
  'upload_failed',
  'upload_unknown',
  'not_archive',
  'archive_not_allowed',
  'decompressed_too_large',
  'ratio_exceeded',
  'charset_unsupported',
  'invalid_bytes',
  'needs_database',
  'confirm_required',
  'confirm_invalid',
  'refused_statement',
  'statement_failed',
  'row_rejected',
  'export_too_large',
  'export_failed',
  'time_limit',
  'file_gone',
  'not_enabled',
  'path_refused',
  'cancelled',
] as const
export type IoErrorCode = (typeof IO_ERROR_CODES)[number]

export type IoError = {
  code: IoErrorCode
  message: string
  /** Server number and message when a statement failed; escaped on output (SEC-TGT-112). */
  errno?: number
  serverMessage?: string
  statementNumber?: number
  byteOffset?: number
  line?: number
  /** First 2 000 characters of a failing statement; never audited, only returned to the owner. */
  statementText?: string
}

// ---- Audit event shapes (FR-IO-021; no row values, no statement text) ----------------------------------

export type IoAuditEvent =
  | { event: 'io.export.start' | 'io.export.end' | 'io.import.start' | 'io.import.end' | 'io.job.cancel' | 'io.job.resume'; jobId: string }


// ---- Value-formatter contract (package A) -----------------------------------------------------------

/** A cell as the reader delivers it: exact text for numbers and dates, Buffer for binary, null for NULL. */
export type IoCell = string | Buffer | null

export interface ColumnInfo {
  name: string
  /** Type kind from `rows/codecs.ts`. */
  kind: string
  unsigned?: boolean
  binary?: boolean
  geometry?: boolean
  bit?: boolean
  generated?: boolean
}

// ---- Server functions (task 5-7, thin handlers; names fixed here) --------------------------------------

export const IO_SERVER_FUNCTIONS = [
  'getIoCapabilities',
  'startExport',
  'getJob',
  'cancelJob',
  'analyseImport',
  'startImport',
  'resumeImport',
  'listImportFolder',
  'listTemplates',
  'saveTemplate',
  'deleteTemplate',
  'getIoPrefs',
  'setIoPrefs',
] as const

export type IoCapabilities = {
  formats: IoFormat[]
  compressions: Compression[]
  limits: Pick<IoLimits, 'uploadBytes' | 'decompressedBytes' | 'jobMs' | 'maxExportBytes' | 'serverFolderEnabled' | 'formulaNeutralisation'> & {
    /** False when the administrator forbids switching formula neutralisation off (ST-157). */
    mayDisableFormulaNeutralisation: boolean
  }
  charsets: { name: string; label: string }[]
  /** Probe results that depend on the target (system versioning etc.), for hiding options. */
  target: { product: 'mysql' | 'mariadb'; version: string }
}
