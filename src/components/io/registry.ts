/**
 * Option registry (FR-IO-026): every format option panel renders from these declarations. Types: boolean, text,
 * number, select, radio, note. An option may carry a documentation link; only the fixed hosts below are linked.
 */
import type { MessageKey } from '~/i18n'
import type { OptionValue, OptionValues } from '~/lib/io/api'
import type { IoFormat } from '~/server/io/types'
import { DEFAULT_EXTENDED_INSERT_BYTES } from '~/server/io/types'

/** Documentation lives on the products' own sites only (FR-SQL-030 style fixed host list). */
export const DOC_HOSTS = ['dev.mysql.com', 'mariadb.com'] as const

export function safeDocUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return undefined
    return (DOC_HOSTS as readonly string[]).includes(u.hostname) ? u.href : undefined
  } catch {
    return undefined
  }
}

/** Facts around the panel that decide what is shown (the format, refused statements, ...). */
export type OptionContext = {
  format?: IoFormat
  refused?: number
  /** Names of the tables in a DBLoom JSON export; when present the table option is a choice. */
  jsonTables?: string[]
}

export type Choice = { value: string; label: MessageKey }

type Common = {
  key: string
  label: MessageKey
  hint?: MessageKey
  /** Link to the vendor documentation; ignored unless the host is in DOC_HOSTS. */
  doc?: string
  showWhen?: (values: OptionValues, ctx: OptionContext) => boolean
}

export type OptionSpec = Common &
  (
    | { type: 'boolean'; default: boolean }
    | { type: 'text'; default: string; maxLength: number }
    | {
        type: 'number'
        default: number
        min: number
        max: number
        /** The stored value is the shown value times `scale` (bytes shown as KiB). */
        scale?: number
        unit?: MessageKey
      }
    | { type: 'select'; default: string; choices: Choice[] }
    | { type: 'radio'; default: string; choices: Choice[] }
    | { type: 'note' }
  )

const MYSQL = 'https://dev.mysql.com/doc/refman/8.4/en/'

const sep: Choice[] = [
  { value: ',', label: 'io.opt.sep.comma' },
  { value: ';', label: 'io.opt.sep.semicolon' },
  { value: '\t', label: 'io.opt.sep.tab' },
  { value: '|', label: 'io.opt.sep.pipe' },
  { value: ':', label: 'io.opt.sep.colon' },
]
const enclosure: Choice[] = [
  { value: '"', label: 'io.opt.enc.double' },
  { value: "'", label: 'io.opt.enc.single' },
  { value: '', label: 'io.opt.enc.none' },
]
const escape: Choice[] = [
  { value: '"', label: 'io.opt.esc.double' },
  { value: '\\', label: 'io.opt.esc.backslash' },
  { value: '', label: 'io.opt.esc.none' },
]

const structureOn = (v: OptionValues) => v['content'] !== 'data'
const dataOn = (v: OptionValues) => v['content'] !== 'structure'

export const SQL_EXPORT_OPTIONS: OptionSpec[] = [
  {
    key: 'content',
    type: 'radio',
    label: 'io.opt.sql.content',
    default: 'both',
    choices: [
      { value: 'structure', label: 'io.opt.sql.content.structure' },
      { value: 'data', label: 'io.opt.sql.content.data' },
      { value: 'both', label: 'io.opt.sql.content.both' },
    ],
  },
  {
    key: 'statement',
    type: 'select',
    label: 'io.opt.sql.statement',
    default: 'insert',
    showWhen: dataOn,
    choices: [
      { value: 'insert', label: 'io.opt.sql.statement.insert' },
      { value: 'insertIgnore', label: 'io.opt.sql.statement.insertIgnore' },
      { value: 'replace', label: 'io.opt.sql.statement.replace' },
    ],
  },
  { key: 'comments', type: 'boolean', label: 'io.opt.sql.comments', default: true },
  {
    key: 'customComment',
    type: 'text',
    label: 'io.opt.sql.customComment',
    default: '',
    maxLength: 500,
    showWhen: (v) => v['comments'] === true,
  },
  {
    key: 'foreignKeyChecksOff',
    type: 'boolean',
    label: 'io.opt.sql.fkOff',
    default: true,
    doc: `${MYSQL}server-system-variables.html#sysvar_foreign_key_checks`,
  },
  { key: 'transaction', type: 'boolean', label: 'io.opt.sql.transaction', default: true },
  {
    key: 'createDatabase',
    type: 'boolean',
    label: 'io.opt.sql.createDatabase',
    default: false,
    showWhen: structureOn,
  },
  {
    key: 'dropDatabase',
    type: 'boolean',
    label: 'io.opt.sql.dropDatabase',
    hint: 'io.opt.sql.dropDatabase.hint',
    default: false,
    showWhen: structureOn,
  },
  {
    key: 'dropObjects',
    type: 'boolean',
    label: 'io.opt.sql.dropObjects',
    default: false,
    showWhen: structureOn,
  },
  {
    key: 'ifNotExists',
    type: 'boolean',
    label: 'io.opt.sql.ifNotExists',
    default: false,
    showWhen: structureOn,
  },
  {
    key: 'keysInCreateTable',
    type: 'boolean',
    label: 'io.opt.sql.keysInCreate',
    default: true,
    showWhen: structureOn,
  },
  {
    key: 'autoIncrementValue',
    type: 'boolean',
    label: 'io.opt.sql.autoIncrement',
    default: true,
    showWhen: structureOn,
  },
  {
    key: 'views',
    type: 'boolean',
    label: 'io.opt.sql.views',
    default: true,
    showWhen: structureOn,
  },
  {
    key: 'triggers',
    type: 'boolean',
    label: 'io.opt.sql.triggers',
    default: true,
    showWhen: structureOn,
  },
  {
    key: 'routines',
    type: 'boolean',
    label: 'io.opt.sql.routines',
    default: false,
    showWhen: structureOn,
  },
  {
    key: 'events',
    type: 'boolean',
    label: 'io.opt.sql.events',
    default: false,
    showWhen: structureOn,
  },
  {
    key: 'extendedInserts',
    type: 'boolean',
    label: 'io.opt.sql.extended',
    default: true,
    showWhen: dataOn,
  },
  {
    key: 'extendedInsertBytes',
    type: 'number',
    label: 'io.opt.sql.extendedBytes',
    default: DEFAULT_EXTENDED_INSERT_BYTES,
    min: 1024,
    max: 16 * 1024 * 1024,
    scale: 1024,
    unit: 'io.opt.unit.kib',
    showWhen: (v) => dataOn(v) && v['extendedInserts'] === true,
  },
  {
    key: 'tableStatementsTogether',
    type: 'boolean',
    label: 'io.opt.sql.together',
    default: false,
    showWhen: (v) => v['content'] === 'both',
  },
]

export const CSV_EXPORT_OPTIONS: OptionSpec[] = [
  {
    key: 'preset',
    type: 'select',
    label: 'io.opt.csv.preset',
    hint: 'io.opt.csv.preset.hint',
    default: 'plain',
    choices: [
      { value: 'plain', label: 'io.opt.csv.preset.plain' },
      { value: 'excel', label: 'io.opt.csv.preset.excel' },
    ],
  },
  { key: 'separator', type: 'select', label: 'io.opt.csv.separator', default: ',', choices: sep },
  {
    key: 'enclosure',
    type: 'select',
    label: 'io.opt.csv.enclosure',
    default: '"',
    choices: enclosure,
  },
  { key: 'escape', type: 'select', label: 'io.opt.csv.escape', default: '"', choices: escape },
  {
    key: 'lineEnding',
    type: 'select',
    label: 'io.opt.csv.lineEnding',
    default: 'lf',
    choices: [
      { value: 'lf', label: 'io.opt.le.lf' },
      { value: 'crlf', label: 'io.opt.le.crlf' },
    ],
  },
  { key: 'nullText', type: 'text', label: 'io.opt.csv.nullText', default: '', maxLength: 16 },
  { key: 'header', type: 'boolean', label: 'io.opt.csv.header', default: true },
  {
    key: 'bom',
    type: 'boolean',
    label: 'io.opt.csv.bom',
    hint: 'io.opt.csv.bom.hint',
    default: false,
  },
  { key: 'removeLineBreaks', type: 'boolean', label: 'io.opt.csv.removeBreaks', default: false },
  {
    key: 'neutraliseFormulas',
    type: 'boolean',
    label: 'io.opt.csv.formulas',
    hint: 'io.opt.csv.formulas.hint',
    default: true,
  },
]

export const JSON_EXPORT_OPTIONS: OptionSpec[] = [
  { key: 'pretty', type: 'boolean', label: 'io.opt.json.pretty', default: true },
  { key: 'unicode', type: 'boolean', label: 'io.opt.json.unicode', default: true },
  { key: 'note', type: 'note', label: 'io.opt.json.note' },
]

export const EXPORT_OPTIONS: Record<IoFormat, OptionSpec[]> = {
  sql: SQL_EXPORT_OPTIONS,
  csv: CSV_EXPORT_OPTIONS,
  json: JSON_EXPORT_OPTIONS,
}

export const SQL_IMPORT_OPTIONS: OptionSpec[] = [
  {
    key: 'skipStatements',
    type: 'number',
    label: 'io.opt.imp.skip',
    default: 0,
    min: 0,
    max: 1_000_000_000,
  },
  { key: 'ignoreErrors', type: 'boolean', label: 'io.opt.imp.ignoreErrors', default: false },
  {
    key: 'rollbackOnError',
    type: 'boolean',
    label: 'io.opt.imp.rollback',
    hint: 'io.opt.imp.rollback.hint',
    default: false,
  },
  {
    key: 'foreignKeyChecks',
    type: 'select',
    label: 'io.opt.imp.fkChecks',
    default: 'default',
    choices: [
      { value: 'default', label: 'io.opt.imp.fk.default' },
      { value: 'off', label: 'io.opt.imp.fk.off' },
      { value: 'on', label: 'io.opt.imp.fk.on' },
    ],
  },
  {
    key: 'skipRefused',
    type: 'boolean',
    label: 'io.opt.imp.skipRefused',
    hint: 'io.opt.imp.skipRefused.hint',
    default: false,
    showWhen: (_v, c) => (c.refused ?? 0) > 0,
  },
]

const csvOnly = (_v: OptionValues, c: OptionContext) => c.format === 'csv'

export const ROW_IMPORT_OPTIONS: OptionSpec[] = [
  {
    key: 'separator',
    type: 'select',
    label: 'io.opt.csv.separator',
    default: ',',
    choices: sep,
    showWhen: csvOnly,
  },
  {
    key: 'enclosure',
    type: 'select',
    label: 'io.opt.csv.enclosure',
    default: '"',
    choices: enclosure,
    showWhen: csvOnly,
  },
  {
    key: 'escape',
    type: 'select',
    label: 'io.opt.csv.escape',
    default: '"',
    choices: escape,
    showWhen: csvOnly,
  },
  {
    key: 'lineEnding',
    type: 'select',
    label: 'io.opt.csv.lineEnding',
    default: 'auto',
    showWhen: csvOnly,
    choices: [
      { value: 'auto', label: 'io.opt.le.auto' },
      { value: 'lf', label: 'io.opt.le.lf' },
      { value: 'crlf', label: 'io.opt.le.crlf' },
    ],
  },
  {
    key: 'nullText',
    type: 'text',
    label: 'io.opt.csv.nullText',
    default: '',
    maxLength: 16,
    showWhen: csvOnly,
  },
  { key: 'header', type: 'boolean', label: 'io.opt.row.header', default: false, showWhen: csvOnly },
  {
    key: 'skipRows',
    type: 'number',
    label: 'io.opt.row.skip',
    default: 0,
    min: 0,
    max: 1_000_000_000,
  },
  {
    key: 'conflict',
    type: 'select',
    label: 'io.opt.row.conflict',
    default: 'error',
    choices: [
      { value: 'error', label: 'io.opt.row.conflict.error' },
      { value: 'ignore', label: 'io.opt.row.conflict.ignore' },
      { value: 'replace', label: 'io.opt.row.conflict.replace' },
    ],
  },
  {
    key: 'mode',
    type: 'radio',
    label: 'io.opt.row.mode',
    default: 'allOrNothing',
    choices: [
      { value: 'allOrNothing', label: 'io.opt.row.mode.all' },
      { value: 'keepGoing', label: 'io.opt.row.mode.keep' },
    ],
  },
  {
    key: 'jsonTable',
    type: 'text',
    label: 'io.opt.row.jsonTable',
    hint: 'io.opt.row.jsonTable.hint',
    default: '',
    maxLength: 64,
    showWhen: (_v, c) => c.format === 'json',
  },
]

export const defaultValues = (specs: OptionSpec[]): OptionValues => {
  const out: OptionValues = {}
  for (const s of specs) if (s.type !== 'note') out[s.key] = s.default
  return out
}

export const visibleOptions = (
  specs: OptionSpec[],
  values: OptionValues,
  ctx: OptionContext = {},
): OptionSpec[] => specs.filter((s) => !s.showWhen || s.showWhen(values, ctx))

/** The Excel preset of the CSV options (FR-IO-006): a preset of the options, not a format. */
export const EXCEL_PRESET: OptionValues = {
  separator: ';',
  enclosure: '"',
  escape: '"',
  lineEnding: 'crlf',
  header: true,
  nullText: 'NULL',
}

/** Options after the user changed one; choosing the Excel preset applies its values at once. */
export function changeOption(
  specs: OptionSpec[],
  values: OptionValues,
  key: string,
  value: OptionValue,
): OptionValues {
  const next = { ...values, [key]: value }
  if (key === 'preset' && value === 'excel' && specs.some((s) => s.key === 'preset')) {
    return { ...next, ...EXCEL_PRESET }
  }
  return next
}

export type OptionErrorKey = 'io.err.required' | 'io.err.range' | 'io.err.integer'

/** Errors of the visible options by key (numbers in range, text length). */
export function validateOptions(
  specs: OptionSpec[],
  values: OptionValues,
  ctx: OptionContext = {},
): Record<string, { key: OptionErrorKey; min?: number; max?: number }> {
  const errors: Record<string, { key: OptionErrorKey; min?: number; max?: number }> = {}
  for (const s of visibleOptions(specs, values, ctx)) {
    if (s.type !== 'number') continue
    const raw = values[s.key]
    if (raw === '' || raw === undefined) {
      errors[s.key] = { key: 'io.err.required' }
      continue
    }
    const n = Number(raw)
    const scale = s.scale ?? 1
    if (!Number.isInteger(n)) errors[s.key] = { key: 'io.err.integer' }
    else if (n < s.min || n > s.max) {
      errors[s.key] = { key: 'io.err.range', min: s.min / scale, max: s.max / scale }
    }
  }
  return errors
}
