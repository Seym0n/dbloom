/**
 * Contracts of module `structure` (SPEC/22-module-structure.md, task 0). Frozen: packages A-D build on
 * this file and only the coordinating agent changes it.
 */
import { z } from 'zod'

// ---- Capabilities (spec 5.4) ---------------------------------------------------------------------

export const CAPABILITY_KEYS = [
  'check-constraint',
  'check-enforcement-toggle',
  'index-hide', // MySQL INVISIBLE, MariaDB IGNORED
  'generated-column',
  'column-invisible',
  'type-uuid',
  'type-inet6',
  'type-json',
  'compressed-column',
  'rename-column',
] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export type Product = 'mysql' | 'mariadb'
export type ServerInfo = { product: Product; version: string }
export type Capabilities = Record<CapabilityKey, boolean>

// ---- Names ----------------------------------------------------------------------------------------

/** A new object name typed by the user (FR-DTB-041): 1-64 chars, no NUL, no trailing space. */
export const objectName = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => !s.includes('\u0000') && s === s.trimEnd(), 'invalid name')

// ---- Model (spec 5.2) -----------------------------------------------------------------------------

export const COLUMN_TYPES = [
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'decimal',
  'float',
  'double',
  'bit',
  'boolean',
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'enum',
  'set',
  'json',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'uuid',
  'inet6',
] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

export const columnDefault = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('null') }),
  z.object({ kind: z.literal('literal'), value: z.union([z.string(), z.number()]) }),
  z.object({ kind: z.literal('currentTimestamp'), fsp: z.number().int().min(0).max(6).optional() }),
  z.object({ kind: z.literal('expression'), sql: z.string().min(1).max(2000) }), // FR-STR-011
])
export type ColumnDefault = z.infer<typeof columnDefault>

export const columnDef = z.object({
  name: objectName,
  type: z.enum(COLUMN_TYPES),
  length: z.number().int().min(1).max(65535).optional(),
  precision: z.number().int().min(1).max(65).optional(),
  scale: z.number().int().min(0).max(30).optional(),
  values: z.array(z.string().max(255)).max(4096).optional(), // enum / set
  unsigned: z.boolean().optional(),
  nullable: z.boolean(),
  default: columnDefault.default({ kind: 'none' }),
  autoIncrement: z.boolean().optional(),
  onUpdateCurrentTimestamp: z.boolean().optional(),
  generated: z
    .object({ sql: z.string().min(1).max(2000), storage: z.enum(['virtual', 'stored']) })
    .optional(),
  charset: z.string().max(64).optional(),
  collation: z.string().max(64).optional(),
  comment: z.string().max(1024).optional(),
  invisible: z.boolean().optional(),
})
export type ColumnDef = z.infer<typeof columnDef>

export const indexDef = z.object({
  name: objectName.optional(),
  kind: z.enum(['primary', 'unique', 'index', 'fulltext']),
  parts: z
    .array(
      z.object({
        column: objectName,
        length: z.number().int().min(1).max(3072).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      }),
    )
    .min(1)
    .max(16),
  visibility: z.enum(['visible', 'invisible']).optional(),
})
export type IndexDef = z.infer<typeof indexDef>

export const REFERENTIAL_ACTIONS = ['restrict', 'cascade', 'set null', 'no action'] as const
const referentialAction = z.enum(REFERENTIAL_ACTIONS)

export const fkDef = z.object({
  name: objectName.optional(),
  columns: z.array(objectName).min(1).max(16),
  refDb: objectName,
  refTable: objectName,
  refColumns: z.array(objectName).min(1).max(16),
  onDelete: referentialAction.default('restrict'),
  onUpdate: referentialAction.default('restrict'),
})
export type FkDef = z.infer<typeof fkDef>

export const checkDef = z.object({
  name: objectName.optional(),
  sql: z.string().min(1).max(2000),
  enforced: z.boolean().optional(),
})
export type CheckDef = z.infer<typeof checkDef>

export const tableOptions = z.object({
  engine: z.string().max(64).optional(), // checked against SHOW ENGINES, never passed through
  charset: z.string().max(64).optional(),
  collation: z.string().max(64).optional(),
  comment: z.string().max(2048).optional(),
  autoIncrement: z.number().int().min(1).optional(),
  rowFormat: z.enum(['default', 'dynamic', 'compact', 'redundant', 'compressed']).optional(),
})
export type TableOptions = z.infer<typeof tableOptions>

export const tableDefinition = tableOptions.extend({
  db: objectName,
  name: objectName,
  columns: z.array(columnDef).min(1).max(4096),
  indexes: z.array(indexDef).max(64).default([]),
  fks: z.array(fkDef).max(64).default([]),
  checks: z.array(checkDef).max(64).default([]),
})
export type TableDefinition = z.infer<typeof tableDefinition>

// ---- Alter operations ----------------------------------------------------------------------------

export const alterOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addColumn'),
    column: columnDef,
    after: objectName.nullable().optional(),
  }), // after null = FIRST
  z.object({
    op: z.literal('modifyColumn'),
    name: objectName,
    column: columnDef,
    after: objectName.nullable().optional(),
  }),
  z.object({ op: z.literal('renameColumn'), from: objectName, to: objectName }),
  z.object({ op: z.literal('dropColumn'), name: objectName }),
  z.object({ op: z.literal('addIndex'), index: indexDef }),
  z.object({ op: z.literal('dropIndex'), name: objectName }),
  z.object({
    op: z.literal('setIndexVisibility'),
    name: objectName,
    visibility: z.enum(['visible', 'invisible']),
  }),
  z.object({ op: z.literal('addFk'), fk: fkDef }),
  z.object({ op: z.literal('dropFk'), name: objectName }),
  z.object({ op: z.literal('addCheck'), check: checkDef }),
  z.object({ op: z.literal('dropCheck'), name: objectName }),
  z.object({ op: z.literal('setOptions'), options: tableOptions }),
])
export type AlterOp = z.infer<typeof alterOp>

// ---- Statements and plans (spec 5.3, 5.5) ---------------------------------------------------------

/** none: no data effect; soft: reversible-ish or confirm-by-preference; hard: data loss, token required. */
export type StatementClass = 'none' | 'soft' | 'hard'

export type StatementKind =
  | 'createDatabase'
  | 'dropDatabase'
  | 'createTable'
  | 'alterTable'
  | 'renameTable'
  | 'truncateTable'
  | 'dropTable'
  | 'setForeignKeyChecks'
  | 'userSql' // SQL typed in the SQL tab (module sql-tab)

export type Statement = {
  sql: string
  kind: StatementKind
  class: StatementClass
  /** One line for the preview, e.g. "Drops column `note` and its data". English; i18n later. */
  effect: string
}

export type PlanWarning = { code: string; message: string }

/** What the builder returns; the server wraps it into a stored plan. */
export type BuiltPlan = { statements: Statement[]; warnings: PlanWarning[] }

// ---- Server function inputs and outputs (spec 5.1) ------------------------------------------------

export const previewInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('createDatabase'),
    name: objectName,
    charset: z.string().max(64).optional(),
    collation: z.string().max(64).optional(),
  }),
  z.object({ action: z.literal('dropDatabase'), name: objectName }),
  z.object({ action: z.literal('createTable'), table: tableDefinition }),
  z.object({
    action: z.literal('alterTable'),
    db: objectName,
    table: objectName,
    ops: z.array(alterOp).min(1).max(200),
  }),
  z.object({
    action: z.literal('renameTable'),
    db: objectName,
    table: objectName,
    newName: objectName,
    newDb: objectName.optional(),
  }),
  z.object({
    action: z.literal('truncateTable'),
    db: objectName,
    table: objectName,
    ignoreForeignKeys: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('dropTable'),
    db: objectName,
    table: objectName,
    ignoreForeignKeys: z.boolean().optional(),
    /** True when the target is a view (DROP VIEW). The server checks it against the catalog. */
    view: z.boolean().optional(),
  }),
])
export type PreviewInput = z.infer<typeof previewInput>

export type PreviewResult = {
  planId: string
  statements: Statement[]
  warnings: PlanWarning[]
  /** True when any statement is class hard: execute needs `confirmToken`. */
  confirmRequired: boolean
  confirmToken?: string
  /** Name the user has to type for dropDatabase / dropTable / truncateTable (typed-name confirmation). */
  confirmName?: string
  expiresAt: number
}

export const executeInput = z.object({
  planId: z.string().min(8).max(128),
  confirmToken: z.string().max(512).optional(),
})
export type ExecuteInput = z.infer<typeof executeInput>

export type StructureError = {
  errno: number | null
  code: string
  /** The server's own text, shown escaped (SEC-TGT-112). */
  message: string
  hint?: string
}

export type StatementResult =
  | { status: 'executed'; sql: string; durationMs: number }
  | { status: 'failed'; sql: string; durationMs: number; error: StructureError }
  | { status: 'not-run'; sql: string }

export type ExecuteResult = { results: StatementResult[]; ok: boolean }

// ---- Lists for the forms ------------------------------------------------------------------------

export type StructureLists = {
  server: ServerInfo
  capabilities: Capabilities
  engines: string[]
  charsets: { name: string; defaultCollation: string }[]
  collations: { name: string; charset: string }[]
}

// ---- Audit (package B owns the writer) ------------------------------------------------------------

export type StructureAuditEvent = {
  user: string
  target: string
  kind: StatementKind
  class: StatementClass
  /** SHA-256 of the statement text; literals and defaults never reach the log (NFR-TGT-090). */
  statementHash: string
  outcome: 'executed' | 'failed' | 'refused'
  errno?: number
  durationMs?: number
}

// ---- Events -------------------------------------------------------------------------------------

/** Emitted after a successful change so the shell can refresh the sidebar tree. */
export type StructureChanged = { db?: string; table?: string }

// ---- Builder and guard interfaces (frozen with the contracts) -------------------------------------

/** Input of `buildStatements(input: PreviewInput, ctx: BuildContext): BuiltPlan` (package A). */
export type BuildContext = {
  server: ServerInfo
  capabilities: Capabilities
  /** Current definition of the table being altered/renamed (package C reads it from the catalog). */
  current?: TableDefinition
  /** Default collation per character set from the server (FR-TGT-243); used to spell out CREATE TABLE defaults. */
  charsetDefaults?: Record<string, string>
}

/** Thrown by the builder for input it must refuse (capability missing, invalid combination). */
export class BuildRefusal extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BuildRefusal'
  }
}

/** Read-only state the guard looks at (package B adds `readOnly` to Config and LiveSession). */
export type GuardContext = { forcedReadOnly: boolean; sessionReadOnly: boolean }

/** Bound into the confirmation token (spec 5.5). */
export type TokenClaims = {
  sessionId: string
  target: string
  planId: string
  statementsHash: string
  expiresAt: number
}
