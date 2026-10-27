/** Pure logic of the import tab: mapping, new-table review, start rules and the start request (FR-IO-016, 018, 019). */
import type { OptionValues } from '~/lib/io/api'
import type { ImportAnalysis } from '~/server/io/types'
import type { MessageKey } from '~/i18n'
import type {
  ColumnMap,
  ImportStatementClass,
  IoFormat,
  StartImportRequest,
} from '~/server/io/types'
import type { ColumnDef, ColumnType, TableDefinition } from '~/server/structure/types'

// ---- Statement classes (FR-IO-016) --------------------------------------------------------------------

export const CLASS_ORDER: ImportStatementClass[] = ['none', 'soft', 'hard', 'refused']

/** Kinds with counts as one line, e.g. "3 GRANT, 1 CREATE USER", largest first, stable for equal counts. */
export function kindsLine(kinds: Record<string, number>): string {
  return Object.entries(kinds)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ')
}

export const totalOf = (kinds: Record<string, number>): number =>
  Object.values(kinds).reduce((s, n) => s + n, 0)

// ---- Mapping ------------------------------------------------------------------------------------------

export type TargetColumn = { name: string; type: string; generated?: boolean }
export type MapRow = { source: string | number; label: string; target: string | null }

/** Maps by name (exact, then case-insensitive); without header names it maps by position. */
export function autoMap(fileColumns: string[], targets: TargetColumn[], byName: boolean): MapRow[] {
  const usable = targets.filter((c) => !c.generated)
  const taken = new Set<string>()
  return fileColumns.map((label, index) => {
    let pick: string | null = null
    if (byName) {
      const exact = usable.find((c) => c.name === label && !taken.has(c.name))
      const loose = usable.find(
        (c) => c.name.toLowerCase() === label.toLowerCase() && !taken.has(c.name),
      )
      pick = (exact ?? loose)?.name ?? null
    } else {
      pick = usable[index]?.name ?? null
    }
    if (pick) taken.add(pick)
    return { source: byName ? label : index, label, target: pick }
  })
}

export type MappingProblem = 'none' | 'duplicate'

export function validateMapping(rows: MapRow[]): {
  problem?: MappingProblem
  duplicates: string[]
} {
  const seen = new Map<string, number>()
  for (const r of rows) if (r.target) seen.set(r.target, (seen.get(r.target) ?? 0) + 1)
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([name]) => name)
  if (seen.size === 0) return { problem: 'none', duplicates }
  if (duplicates.length > 0) return { problem: 'duplicate', duplicates }
  return { duplicates }
}

export const toColumnMaps = (rows: MapRow[]): ColumnMap[] =>
  rows.map((r) => ({ source: r.source, target: r.target }))

// ---- New table (FR-IO-019) ----------------------------------------------------------------------------

export type ReviewColumn = {
  source: string | number
  name: string
  type: ColumnType
  length?: number
  precision?: number
  scale?: number
}

/** Types the review offers; `json` is never inferred, everything unclear stays text. */
export const REVIEW_TYPES: ColumnType[] = [
  'int',
  'bigint',
  'decimal',
  'double',
  'date',
  'datetime',
  'time',
  'varchar',
  'text',
  'longtext',
  'boolean',
  'json',
]

const INT_RE = /^-?\d+$/
const INT64_MAX = 9223372036854775807n
const DEC_RE = /^-?\d+\.\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/
const TIME_RE = /^-?\d{1,3}:\d{2}:\d{2}(\.\d+)?$/

/**
 * Proposal from the sample rows when the server did not infer types. Mirrors the rules of FR-IO-019 on the part
 * of the file the analysis sends; the server's own inference (all 10 000 rows) wins when it provides one.
 */
export function inferType(values: (string | null)[]): Omit<ReviewColumn, 'source' | 'name'> {
  const present = values.filter((v): v is string => v !== null && v !== '')
  if (present.length === 0) return { type: 'varchar', length: 255 }
  if (present.every((v) => INT_RE.test(v))) {
    const digits = Math.max(...present.map((v) => v.replace('-', '').length))
    // Beyond the signed 64-bit range the review has no unsigned type: an exact DECIMAL keeps every digit.
    if (present.some((v) => BigInt(v) > INT64_MAX || BigInt(v) < -INT64_MAX - 1n)) {
      return digits <= 65 ? { type: 'decimal', precision: digits, scale: 0 } : { type: 'text' }
    }
    return { type: digits >= 10 ? 'bigint' : 'int' }
  }
  if (present.every((v) => INT_RE.test(v) || DEC_RE.test(v))) {
    let intDigits = 1
    let scale = 0
    for (const v of present) {
      const [i = '', f = ''] = v.replace('-', '').split('.')
      intDigits = Math.max(intDigits, i.length)
      scale = Math.max(scale, f.length)
    }
    const precision = intDigits + scale
    return precision <= 65 && scale <= 30
      ? { type: 'decimal', precision: Math.max(precision, 1), scale }
      : { type: 'double' }
  }
  if (present.every((v) => DATETIME_RE.test(v))) return { type: 'datetime' }
  if (present.every((v) => DATE_RE.test(v))) return { type: 'date' }
  if (present.every((v) => TIME_RE.test(v))) return { type: 'time' }
  const longest = Math.max(...present.map((v) => [...v].length))
  if (longest > 65535) return { type: 'longtext' }
  if (longest > 255) return { type: 'text' }
  return { type: 'varchar', length: Math.min(255, Math.max(32, Math.ceil(longest / 32) * 32)) }
}

export function proposeColumns(
  columns: string[],
  sample: (string | null)[][],
  byName: boolean,
  inferred?: string[],
): ReviewColumn[] {
  return columns.map((label, index) => {
    // The server's own inference (all sampled rows) wins when it names a type the review offers.
    const server = /^([a-z]+)(?:\((\d+)(?:,(\d+))?\))?/.exec(inferred?.[index]?.toLowerCase() ?? '')
    const type = REVIEW_TYPES.find((x) => x === server?.[1])
    const unsigned = /^bigint unsigned/i.test(inferred?.[index] ?? '')
    const guess: Omit<ReviewColumn, 'source' | 'name'> = unsigned
      ? { type: 'decimal', precision: 20, scale: 0 }
      : type
        ? {
            type,
            ...(type === 'varchar' ? { length: Number(server?.[2] ?? 255) } : {}),
            ...(type === 'decimal'
              ? { precision: Number(server?.[2] ?? 10), scale: Number(server?.[3] ?? 0) }
              : {}),
          }
        : inferType(sample.map((row) => row[index] ?? null))
    return {
      source: byName ? label : index,
      name: byName && label.trim() !== '' ? label : `col_${index + 1}`,
      ...guess,
    }
  })
}

export type ReviewProblem = { field: string; key: MessageKey }

export function validateReview(tableName: string, cols: ReviewColumn[]): ReviewProblem[] {
  const out: ReviewProblem[] = []
  const bad = (n: string) =>
    n === '' || [...n].length > 64 || n !== n.trimEnd() || n.includes('\u0000')
  if (bad(tableName)) out.push({ field: 'table', key: 'io.err.name' })
  const seen = new Set<string>()
  cols.forEach((c, i) => {
    const lower = c.name.toLowerCase()
    if (bad(c.name)) out.push({ field: `col.${i}`, key: 'io.err.name' })
    else if (seen.has(lower)) out.push({ field: `col.${i}`, key: 'io.err.duplicate' })
    seen.add(lower)
    if (c.type === 'varchar' && (!c.length || c.length < 1 || c.length > 65535))
      out.push({ field: `col.${i}`, key: 'io.err.length' })
  })
  return out
}

/** The typed model of `structure`; SQL comes from its builder only (the server previews and builds it). */
export function toTableDefinition(db: string, name: string, cols: ReviewColumn[]): TableDefinition {
  const columns: ColumnDef[] = cols.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: true,
    default: { kind: 'none' as const },
    ...(c.type === 'varchar' ? { length: c.length ?? 255 } : {}),
    ...(c.type === 'decimal' ? { precision: c.precision ?? 10, scale: c.scale ?? 0 } : {}),
  }))
  return { db, name, columns, indexes: [], fks: [], checks: [] }
}

/** Mapping of a new table: every file column goes to the column of the same position, named as reviewed. */
export const reviewToMaps = (cols: ReviewColumn[]): ColumnMap[] =>
  cols.map((c) => ({ source: c.source, target: c.name }))

// ---- Start rules and request --------------------------------------------------------------------------

export type StartBlock = MessageKey | null

export function startBlock(input: {
  readOnly: boolean
  analysis: ImportAnalysis
  db: string | undefined
  optionErrors: number
  skipRefused: boolean
  rowsReady: boolean
}): StartBlock {
  const { analysis } = input
  if (input.readOnly) return 'io.import.block.readOnly'
  if (analysis.statements) {
    const s = analysis.statements
    if (s.needsDatabase && !s.usesDatabase && !input.db) return 'io.import.block.needsDatabase'
    if ((s.byClass.refused ?? 0) > 0 && !input.skipRefused) return 'io.import.block.refused'
  } else {
    if (!input.db) return 'io.import.block.needsDatabase'
    if (!input.rowsReady) return 'io.import.block.mapping'
  }
  if (input.optionErrors > 0) return 'io.import.block.options'
  return null
}

const rowKeys = [
  'separator',
  'enclosure',
  'escape',
  'lineEnding',
  'nullText',
  'header',
  'skipRows',
  'conflict',
  'mode',
  'jsonTable',
] as const

export function buildStartRequest(input: {
  analysis: ImportAnalysis
  format: IoFormat
  charset?: string
  db?: string
  table?: string
  newTable?: TableDefinition
  sqlOptions: OptionValues
  rowOptions: OptionValues
  mapping?: ColumnMap[]
  confirmToken?: string
}): StartImportRequest {
  const sql = input.format === 'sql'
  let options: Record<string, unknown>
  if (sql) {
    const o = input.sqlOptions
    options = {
      skipStatements: o['skipStatements'],
      ignoreErrors: o['ignoreErrors'],
      rollbackOnError: o['rollbackOnError'],
      skipRefused: o['skipRefused'] === true,
    }
    if (o['foreignKeyChecks'] === 'off') options['foreignKeyChecksOff'] = true
    else if (o['foreignKeyChecks'] === 'on') options['foreignKeyChecksOff'] = false
  } else {
    options = {}
    for (const k of rowKeys) {
      const v = input.rowOptions[k]
      if (v === undefined) continue
      if (k === 'jsonTable' && v === '') continue
      if (
        input.format === 'json' &&
        ['separator', 'enclosure', 'escape', 'lineEnding', 'nullText', 'header'].includes(k)
      )
        continue
      options[k] = v
    }
  }
  return {
    uploadId: input.analysis.uploadId,
    format: input.format,
    ...(input.charset ? { charset: input.charset } : {}),
    ...(input.db ? { db: input.db } : {}),
    ...(input.table ? { table: input.table } : {}),
    ...(input.newTable ? { newTable: input.newTable } : {}),
    options: options as StartImportRequest['options'],
    ...(input.mapping ? { mapping: input.mapping } : {}),
    ...(input.confirmToken ? { confirmToken: input.confirmToken } : {}),
  }
}

/** The name the user types when the analysis says confirmRequired: the database, else the server. */
export const confirmName = (db: string | undefined, server: string): string => db ?? server
