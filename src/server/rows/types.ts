/**
 * Contracts of module `rows` (SPEC/24-module-rows.md, task 0). Frozen: packages A-E build on this file and
 * only the coordinating agent changes it. Requirement ids are FR-ROW-nnn of file 24; section numbers refer to it.
 */
import { z } from 'zod'
import type { Cell } from '../db/rows'
import type { SqlWarning } from '../sql/types'
import type { PlanWarning, StatementClass, StructureError } from '../structure/types'

// Statement, Plan and class types are reused from `structure` (FR-ROW-020, section 5.6); `Statement.params`
// carries the bound values of a row statement.
export type { PlanWarning, Statement, StatementClass, StructureError } from '../structure/types'
export type { Cell } from '../db/rows'

// ---- Names and small schemas (FR-ROW-026: structured data only, strict objects) ------------------------

/** A database, table or column name as the client sends it; accepted only if it exists in the model (SEC-TGT-116). */
const name = z.string().min(1).max(64)
const dbName = name
const tableName = name
const columnName = name

const planId = z.string().min(8).max(128)
const requestId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

// ---- Limits (FR-ROW-029) ---------------------------------------------------------------------------

export const MAX_PAGE_SIZE = 1000
export const MAX_SORT_ENTRIES = 4
export const MAX_FILTER_DEPTH = 4
export const MAX_FILTER_CONDITIONS = 50
export const MAX_FILTER_VALUE_BYTES = 4096
export const MAX_FILTER_IN_VALUES = 200
export const MAX_SEARCH_COLUMNS = 30
export const MAX_BULK_ROWS = 1000
export const MAX_INSERT_ROWS = 100
export const MAX_KEY_COLUMNS = 16
/** Largest value of one field in a write request (a text value; bytes arrive through uploads). */
export const MAX_WIRE_VALUE_CHARS = 16 * 1024 * 1024

export type RowLimits = {
  pageSizes: number[]
  defaultPageSize: number
  maxPageSize: number
  /** Exact count runs by itself at or below this many estimated rows (ST-118; F 1 000 / D 50 000 / C 1 000 000). */
  exactCountThreshold: number
  /** `rows.viewCountCap`: the count of a view stops here and is shown as a lower bound (CON-DTB-001). */
  viewCountCap: number
  /** Bytes of one cell the server sends in the grid projection (ST-115). */
  cellBytes: number
  /** Characters of a cell shown in partial mode (ST-117; 20 to 1 000). */
  displayChars: number
  uploadBytes: number
  /** Selected rows per bulk delete or bulk edit. */
  bulkSize: number
  insertRows: number
}

export const DEFAULT_ROW_LIMITS: RowLimits = {
  pageSizes: [25, 50, 100, 250, 500, 1000],
  defaultPageSize: 50,
  maxPageSize: MAX_PAGE_SIZE,
  exactCountThreshold: 50_000,
  viewCountCap: 10_000,
  cellBytes: 64 * 1024,
  displayChars: 100,
  uploadBytes: 8 * 1024 * 1024,
  bulkSize: MAX_BULK_ROWS,
  insertRows: 1,
}

/** Responses of the limit function say whether preferences last for the session only (stateless mode, 5.9). */
export type RowLimitsResponse = RowLimits & { stateless: boolean }

// ---- Typed row model (section 5.2, FR-ROW-002) ------------------------------------------------------

export const TYPE_KINDS = [
  'int',
  'decimal',
  'float',
  'bit',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'char',
  'text',
  'enum',
  'set',
  'binary',
  'blob',
  'json',
  'geometry',
  'uuid',
  'inet6',
  'unknown',
] as const
export type TypeKind = (typeof TYPE_KINDS)[number]

export type RowColumn = {
  name: string
  ordinal: number
  kind: TypeKind
  /** Base type as the server spells it (`int`, `varchar`), lower case. */
  baseType: string
  /** `COLUMN_TYPE`, e.g. `int(10) unsigned`, shown for unknown kinds too (DATA-ISS-118). */
  fullType: string
  nullable: boolean
  unsigned?: boolean
  /** Declared length in characters or bytes (`char`, `binary` kinds), or bit width for `bit`. */
  length?: number
  precision?: number
  scale?: number
  /** Fractional-seconds precision of temporal kinds. */
  fsp?: number
  members?: string[]
  srid?: number
  default: { kind: 'none' | 'null' | 'literal' | 'expression'; text?: string }
  autoIncrement: boolean
  generated?: 'virtual' | 'stored'
  invisible: boolean
  onUpdate?: string
  charset?: string
  collation?: string
  comment: string
  /** Advisory only (FR-ROW-022); the server decides. */
  privileges?: { select: boolean; insert: boolean; update: boolean }
}

export type FkInfo = {
  name: string
  /** Columns of this table (outgoing) or of the referencing table (incoming), in key order. */
  columns: string[]
  refDb: string
  refTable: string
  refColumns: string[]
  onDelete: string
  onUpdate: string
}

export type RowTable = {
  db: string
  table: string
  kind: 'table' | 'view'
  engine?: string
  /** False for MyISAM, MEMORY and similar; drives the `no-rollback` warning (FR-ROW-023). */
  transactional: boolean
  columns: RowColumn[]
  primaryKey?: string[]
  uniqueKeys: { name: string; columns: string[]; allNotNull: boolean }[]
  outgoing: FkInfo[]
  incoming: FkInfo[]
  /** `TABLE_ROWS`; null when the server gives no statistic. */
  estimatedRows: number | null
}

export const IDENTITY_REASONS = [
  'view',
  'no-key-unsafe-columns',
  'columns-not-selected',
  'unknown-type',
  'no-privilege',
] as const
export type IdentityReason = (typeof IDENTITY_REASONS)[number]

/** Row identity (FR-ROW-004, G1). `none` disables the row actions and says why. */
export type Identity =
  | { kind: 'primary' | 'unique' | 'all-columns'; columns: string[] }
  | { kind: 'none'; reason: IdentityReason }

// ---- Wire values (FR-ROW-003) -------------------------------------------------------------------------

/** Side-effect-free zero-argument functions the form may choose (FR-ROW-018); sent as a name, never as text. */
export const FN_NAMES = [
  'now',
  'currentTimestamp6',
  'utcTimestamp',
  'currentDate',
  'unixTimestamp',
  'uuid',
] as const
export type FnName = (typeof FN_NAMES)[number]

const uploadId = z.string().min(8).max(128)

/** A value to write. Numbers are decimal strings, never JS numbers; bytes arrive as an upload id. */
export const wireValue = z.discriminatedUnion('t', [
  z.object({ t: z.literal('null') }).strict(),
  z.object({ t: z.literal('default') }).strict(),
  z.object({ t: z.literal('v'), v: z.string().max(MAX_WIRE_VALUE_CHARS) }).strict(),
  z.object({ t: z.literal('fn'), name: z.enum(FN_NAMES) }).strict(),
  z.object({ t: z.literal('bin'), upload: uploadId }).strict(),
])
export type WireValue = z.infer<typeof wireValue>

/**
 * A value that identifies or guards a row (key and old values, FR-ROW-004, 005): `null`, a text value, or the
 * SHA-256 hex digest `readCell` returned for columns compared by digest (float, JSON, geometry, large blobs).
 */
export const guardValue = z.discriminatedUnion('t', [
  z.object({ t: z.literal('null') }).strict(),
  z.object({ t: z.literal('v'), v: z.string().max(MAX_WIRE_VALUE_CHARS) }).strict(),
  z.object({ t: z.literal('digest'), v: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
])
export type GuardValue = z.infer<typeof guardValue>

const keyRecord = z
  .record(columnName, guardValue)
  .refine((r) => Object.keys(r).length <= MAX_KEY_COLUMNS, 'too many key columns')
const oldRecord = z
  .record(columnName, guardValue)
  .refine((r) => Object.keys(r).length <= 4096, 'too many columns')
const setRecord = z
  .record(columnName, wireValue)
  .refine((r) => Object.keys(r).length <= 4096, 'too many columns')

// ---- Sort and filter (FR-ROW-006, 008, 009, section 5.5) ------------------------------------------------

export const sortEntry = z
  .object({ column: columnName, direction: z.enum(['asc', 'desc']) })
  .strict()
export type SortEntry = z.infer<typeof sortEntry>

/** Every operator name of the allow-list; `OPERATORS_BY_KIND` (lib/rows/filter-tree.ts) says which kind accepts which. */
export const FILTER_OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'between',
  'not between',
  'in',
  'not in',
  'is null',
  'is not null',
  'contains',
  'not contains',
  'starts with',
  'ends with',
  'empty',
  'not empty',
  'like',
  'not like',
  'regexp',
  'has',
  'has not',
  'text contains',
  'starts with hex',
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export type FilterCondition = {
  type: 'condition'
  column: string
  op: FilterOperator
  /** Text as typed (numbers, dates, `0x..` for binary); one value, two for `between`, a list for `in`, none when unary. */
  values: string[]
  /** `char`/`text` kinds only: compare as bytes (match case). */
  matchCase?: boolean
}
export type FilterGroup = {
  type: 'group'
  op: 'and' | 'or'
  negate?: boolean
  children: FilterNode[]
}
export type FilterNode = FilterCondition | FilterGroup

const filterCondition = z
  .object({
    type: z.literal('condition'),
    column: columnName,
    op: z.enum(FILTER_OPERATORS),
    values: z.array(z.string().max(MAX_FILTER_VALUE_BYTES)).max(MAX_FILTER_IN_VALUES),
    matchCase: z.boolean().optional(),
  })
  .strict()
const filterGroup: z.ZodType<FilterGroup> = z.lazy(() =>
  z
    .object({
      type: z.literal('group'),
      op: z.enum(['and', 'or']),
      negate: z.boolean().optional(),
      children: z.array(filterNode).max(MAX_FILTER_CONDITIONS),
    })
    .strict(),
)
export const filterNode: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([filterCondition, filterGroup]),
)

/** Depth and condition count of a tree (a lone condition has depth 0, a group adds one). */
export function filterStats(node: FilterNode): { depth: number; conditions: number } {
  if (node.type === 'condition') return { depth: 0, conditions: 1 }
  let depth = 0
  let conditions = 0
  for (const child of node.children) {
    const s = filterStats(child)
    depth = Math.max(depth, s.depth)
    conditions += s.conditions
  }
  return { depth: depth + 1, conditions }
}

/** The limits of FR-ROW-008 (depth at most 4, at most 50 conditions, no duplicate `IN` values). */
export function filterWithinLimits(node: FilterNode): boolean {
  const s = filterStats(node)
  if (s.depth > MAX_FILTER_DEPTH || s.conditions > MAX_FILTER_CONDITIONS) return false
  const walk = (n: FilterNode): boolean =>
    n.type === 'group'
      ? n.children.every(walk)
      : !(n.op === 'in' || n.op === 'not in') || new Set(n.values).size === n.values.length
  return walk(node)
}

const filter = filterNode.refine(filterWithinLimits, 'filter too large')

/** Quick search over text-like columns (FR-ROW-009); compiled to an OR group of `contains`. */
export const searchInput = z
  .object({
    text: z.string().min(1).max(MAX_FILTER_VALUE_BYTES),
    /** Also numeric and temporal columns, through `CAST(col AS CHAR)`. */
    allColumns: z.boolean().default(false),
    matchCase: z.boolean().default(false),
  })
  .strict()
export type SearchInput = z.infer<typeof searchInput>

// ---- Built statements (FR-ROW-001, 021, section 5.1) -------------------------------------------------------

export type BuiltStatementKind = 'rowSelect' | 'rowInsert' | 'rowUpdate' | 'rowDelete'

/** What `builder.ts` returns. `sql` has `?` and quoted names only; `preview` is for display and never runs. */
export type BuiltStatement = {
  sql: string
  params: unknown[]
  preview: string
  kind: BuiltStatementKind
  effect: string
}

// ---- getRows (FR-ROW-006, 007, 010; extends the skeleton function, additive) --------------------------------

export const getRowsInput = z
  .object({
    db: dbName,
    table: tableName,
    page: z.number().int().min(0).max(1_000_000_000),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    sort: z.array(sortEntry).max(MAX_SORT_ENTRIES).default([]),
    filter: filter.optional(),
    search: searchInput.optional(),
    /** Identifies this read for the audit line and the cancel function. */
    requestId: requestId.optional(),
  })
  .strict()
export type GetRowsInput = z.infer<typeof getRowsInput>

export type RowsTotal = {
  kind: 'exact' | 'estimate' | 'lowerBound' | 'unknown'
  value: number | null
}

export type RowPermissions = {
  /** True when the connection is read-only (forced or chosen); every write control is disabled. */
  readOnly: boolean
  insert: boolean
  update: boolean
  delete: boolean
  /** Columns the account may update when column-level privileges apply; absent means all. */
  updateColumns?: string[]
  /** Why the actions are off, for a tooltip (stable code: read-only, view, no-identity, privilege). */
  reason?: string
}

export type GetRowsResponse = {
  table: RowTable
  /** Column names in grid order (the model's order; invisible columns only when requested). */
  columns: string[]
  /** Skeleton field: coarse kind per column for alignment. */
  kinds: ('number' | 'temporal' | 'text')[]
  rows: Cell[][]
  /** The page that was answered (clamped, FR-ROW-006). */
  page: number
  hasNext: boolean
  hasPrev: boolean
  sqlShown: string
  total: RowsTotal
  timings: { pageMs: number; countMs?: number }
  identity: Identity
  permissions: RowPermissions
  /** `@@session.time_zone` resolved, for `TIMESTAMP` labels (FR-ROW-027). */
  timeZone: string
  /** Set when the offset is large (G8 hint). */
  deepOffset?: boolean
}

// ---- countRows (cancellable, FR-ROW-007, section 5.8) --------------------------------------------------------

export const countRowsInput = z
  .object({
    db: dbName,
    table: tableName,
    filter: filter.optional(),
    search: searchInput.optional(),
    requestId,
  })
  .strict()
export type CountRowsInput = z.infer<typeof countRowsInput>

export const cancelCountInput = z.object({ requestId }).strict()
export type CancelCountInput = z.infer<typeof cancelCountInput>

export type CountRowsResponse =
  | { status: 'done'; total: RowsTotal; durationMs: number }
  | { status: 'timeout'; total: RowsTotal; durationMs: number }
  | { status: 'cancelled'; total: RowsTotal }

// ---- readRow, readCell, openCell (FR-ROW-011, 012, 016) ------------------------------------------------------

export const readRowInput = z
  .object({
    db: dbName,
    table: tableName,
    key: keyRecord,
    includeInvisible: z.boolean().optional(),
  })
  .strict()
export type ReadRowInput = z.infer<typeof readRowInput>

export type ReadRowResponse =
  | {
      found: true
      /** Same order as `columns` of the table model; the form's original server values. */
      columns: string[]
      cells: Cell[]
      /** SHA-256 hex of columns compared by digest (FR-ROW-005), by column name. */
      digests: Record<string, string>
    }
  | { found: false }

export const readCellInput = z
  .object({
    db: dbName,
    table: tableName,
    key: keyRecord,
    column: columnName,
    /** Up to 16 MiB; larger values are download only. */
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
export type ReadCellInput = z.infer<typeof readCellInput>

export type ReadCellResponse =
  | { found: false }
  | {
      found: true
      value:
        | { t: 'null' }
        | { t: 'text'; text: string; length: number; truncated: boolean }
        | { t: 'bytes'; hex: string; length: number; truncated: boolean }
      digest?: string
    }

export const openCellInput = z
  .object({
    db: dbName,
    table: tableName,
    key: keyRecord,
    column: columnName,
    disposition: z.enum(['download', 'preview']),
  })
  .strict()
export type OpenCellInput = z.infer<typeof openCellInput>

export const PREVIEW_TYPES = ['png', 'jpeg', 'gif', 'webp', 'pdf'] as const
export type PreviewType = (typeof PREVIEW_TYPES)[number]

export type OpenCellResponse =
  | { found: false }
  | {
      found: true
      /** One use, 60 s, owning session only; fetched from `GET /api/rows/cell/<id>`. */
      id: string
      expiresAt: number
      size: number
      /** Download file name derived from table and column; the extension from the magic bytes. */
      fileName: string
      /** Set only for a preview-able type within the size cap (Q6). */
      previewType?: PreviewType
    }

/** Response of `POST /api/rows/upload` (FR-ROW-012). */
export type UploadResponse = {
  uploadId: string
  sha256: string
  size: number
  fileName?: string
  previewType?: PreviewType
}

// ---- Foreign key picker and referencing rows (FR-ROW-014) -----------------------------------------------------

export const lookupInput = z
  .object({
    db: dbName,
    table: tableName,
    /** Name of the outgoing foreign key of `table` whose referenced table is searched. */
    fk: name,
    query: z.string().max(200).optional(),
    page: z.number().int().min(0).max(100_000).default(0),
    /** Display values for these key tuples (one query per page, never one per cell). */
    keys: z.array(keyRecord).max(MAX_PAGE_SIZE).optional(),
  })
  .strict()
export type LookupInput = z.infer<typeof lookupInput>

export type LookupOption = { key: Record<string, string | null>; display: string }
export type LookupResponse = { options: LookupOption[]; hasNext: boolean }

export const referencingRowsInput = z
  .object({ db: dbName, table: tableName, key: keyRecord })
  .strict()
export type ReferencingRowsInput = z.infer<typeof referencingRowsInput>

export type ReferencingGroup = {
  db: string
  table: string
  fk: string
  columns: string[]
  count: number
  /** True when the count stopped at its cap. */
  atLeast: boolean
}
export type ReferencingRowsResponse = { groups: ReferencingGroup[] }

// ---- Writes: preview, change, confirm (FR-ROW-015..023, section 5.6) -------------------------------------------

export const insertChange = z
  .object({
    op: z.literal('insert'),
    rows: z.array(setRecord).min(1).max(MAX_INSERT_ROWS),
    ignore: z.boolean().default(false),
  })
  .strict()

const target = z.object({ key: keyRecord, old: oldRecord }).strict()
export type RowTarget = z.infer<typeof target>

export const updateChange = z
  .object({
    op: z.literal('update'),
    targets: z.array(target).min(1).max(MAX_BULK_ROWS),
    set: setRecord.refine((r) => Object.keys(r).length > 0, 'nothing to set'),
  })
  .strict()

export const deleteChange = z
  .object({
    op: z.literal('delete'),
    targets: z.array(target).min(1).max(MAX_BULK_ROWS),
  })
  .strict()

/** No field carries SQL, a WHERE, an ORDER BY, a LIMIT or a class (FR-ROW-026). */
export const rowChange = z.discriminatedUnion('op', [insertChange, updateChange, deleteChange])
export type RowChange = z.infer<typeof rowChange>

export const previewRowsInput = z
  .object({ db: dbName, table: tableName, change: rowChange })
  .strict()
export type PreviewRowsInput = z.infer<typeof previewRowsInput>

export const changeRowsInput = z
  .object({
    db: dbName,
    table: tableName,
    change: rowChange,
    /** Second explicit click after a `conflict` (FR-ROW-005): resends with the current values as the old ones. */
    overwrite: z.boolean().default(false),
    /** User preference: skip the confirmation of soft plans (ST-120). Hard plans ignore it. */
    acceptSoft: z.boolean().default(false),
    /** Confirmation of a single `all-columns` edit (G1) is the hard plan itself; no extra flag exists. */
  })
  .strict()
export type ChangeRowsInput = z.infer<typeof changeRowsInput>

export const confirmRowsInput = z
  .object({
    planId,
    confirmToken: z.string().max(512).optional(),
  })
  .strict()
export type ConfirmRowsInput = z.infer<typeof confirmRowsInput>

/** Reasons a plan has its class (FR-ROW-020, section 5.6). */
export type RowClassReason =
  'no-key' | 'bulk' | 'cascade' | 'no-rollback' | 'delete' | 'engine-nontransactional'

export type RowPlanStatement = {
  /** The parameterised text, for display (FR-ROW-021). */
  sql: string
  /** Parameters substituted for display only; never executed, never sent back. */
  preview: string
  effect: string
  class: StatementClass
}

export type RowPlanInfo = {
  statements: RowPlanStatement[]
  /** Statements in the whole plan (the list above may be shortened for a bulk change). */
  totalStatements: number
  maxClass: StatementClass
  reasons: RowClassReason[]
  warnings: PlanWarning[]
  identityKind: 'primary' | 'unique' | 'all-columns'
  /** Rows an `all-columns` statement would match (counted before the confirmation, G1). */
  matchCount?: number
  /** Referencing tables with CASCADE rules (from the catalog). */
  cascadeTables?: { db: string; table: string; fk: string }[]
}

export type PreviewRowsResponse = RowPlanInfo

/** Error shape of the module: the structure error plus the field the message names (FR-ROW-025). */
export type RowsError = StructureError & {
  field?: string
  /** Index into `targets` / `rows` of the request. */
  rowIndex?: number
}

/** Stable refusal codes the module raises before or around execution (`StructureRefusal.code`). */
export const ROW_REFUSAL_CODES = [
  'read-only',
  'no-identity',
  'unknown-column',
  'unknown-table',
  'invalid-value',
  'operator-not-allowed',
  'bulk-limit',
  'unknown-upload',
  'plan-missing',
  'token-missing',
  'token-invalid',
  'token-expired',
  'token-used',
  'not-editable',
  'view-read-only',
] as const
export type RowRefusalCode = (typeof ROW_REFUSAL_CODES)[number]

export type RowOutcome = {
  /** Index into `targets` / `rows`. */
  index: number
  status: 'applied' | 'rolled-back' | 'not-run' | 'conflict' | 'gone' | 'failed'
  affectedRows?: number
  insertId?: string
  error?: RowsError
}

export type ChangeRowsResponse =
  | {
      kind: 'done'
      operation: 'insert' | 'update' | 'delete'
      affectedRows: number
      outcomes: RowOutcome[]
      /** Statements that ran, as shown under the grid. */
      statements: { sql: string; preview: string }[]
      warnings: SqlWarning[]
      /** Re-read rows by identity after the write (FR-ISS-110), same column order as `columns`. */
      columns: string[]
      rows: Cell[][]
      /** True when no field was dirty and no statement ran. */
      noChanges?: boolean
    }
  | ({
      kind: 'confirm'
      planId: string
      confirmRequired: boolean
      confirmToken?: string
      expiresAt: number
    } & RowPlanInfo)
  | {
      /** The row changed meanwhile (FR-ROW-005); `current` holds its values, aligned with `columns`. */
      kind: 'conflict'
      index: number
      columns: string[]
      current: Cell[]
      digests: Record<string, string>
      /** Columns whose old value no longer matches. */
      changed: string[]
      /** Rows applied before the conflict (non-transactional engines) or rolled back (transactional). */
      outcomes: RowOutcome[]
    }
  | { kind: 'gone'; index: number; outcomes: RowOutcome[] }
  | {
      kind: 'error'
      error: RowsError
      outcomes: RowOutcome[]
      /** False when the connection dropped: it is not known whether the write applied (G5). */
      known: boolean
    }

// ---- Preferences (FR-ROW-010, section 5.9) -----------------------------------------------------------------------

/** Fixed allow-list of keys of the `ui_prefs` table; `rows.autoRefresh` is never persisted. */
export const PREF_KEYS = [
  'rows.pageSize',
  'rows.displayChars',
  'rows.fullText',
  'rows.protectBinary',
  'rows.columns',
  'rows.sort',
  'rows.relationMode',
  'rows.fkDisplay',
  'rows.defaultStringOperator',
  'rows.gridEditing',
  'rows.insertRows',
  'rows.countThreshold',
] as const
export type PrefKey = (typeof PREF_KEYS)[number]

export const PREF_VALUE_MAX_BYTES = 8 * 1024
export const MAX_TABLE_SCOPES = 500

export type RelationMode = 'full' | 'links' | 'none'

export type ColumnLayout = {
  /** Column names in display order; unknown names are dropped and new ones appended on load. */
  order: string[]
  hidden: string[]
  widths: Record<string, number>
}

export const getPrefsInput = z
  .object({ db: dbName.optional(), table: tableName.optional() })
  .strict()
export type GetPrefsInput = z.infer<typeof getPrefsInput>

export const setPrefInput = z
  .object({
    db: dbName.optional(),
    table: tableName.optional(),
    key: z.enum(PREF_KEYS),
    value: z
      .unknown()
      .refine(
        (v) => v !== undefined && JSON.stringify(v).length <= PREF_VALUE_MAX_BYTES,
        'value too large',
      ),
  })
  .strict()
export type SetPrefInput = z.infer<typeof setPrefInput>

export type PrefsResponse = {
  /** Values by key, global scope overlaid by the table scope. */
  values: Partial<Record<PrefKey, unknown>>
  stateless: boolean
}
