/** Pure state and request logic of the export tab (FR-IO-002, 003, 009, 011, 026). */
import type { ExportScopeKey, IoPrefs, OptionValues } from '~/lib/io/api'
import type {
  Compression,
  ExportRequest,
  ExportScope,
  IoCapabilities,
  IoFormat,
} from '~/server/io/types'
import { MAX_FILENAME_CHARS, MAX_TEMPLATE_NAME } from '~/server/io/types'
import type { MessageKey } from '~/i18n'
import { defaultValues, EXPORT_OPTIONS, validateOptions } from './registry'

export type ExportTarget =
  | { kind: 'server' }
  | { kind: 'database'; db: string }
  | { kind: 'table'; db: string; table: string }
  | { kind: 'result'; db?: string; text: string; statementIndex: number }

export type ExportState = {
  format: IoFormat
  compression: Compression
  options: Record<IoFormat, OptionValues>
  separateFiles: boolean
  view: 'file' | 'text'
  fileNameTemplate: string
  lock: boolean
  skipUnreadable: boolean
  /** Unchecked names in the picker: databases at server scope, tables at database scope. */
  excluded: string[]
  maxTableMiB: number | ''
  rangeOn: boolean
  offset: number | ''
  count: number | ''
}

export const DEFAULT_TEMPLATES: Record<ExportScopeKey, string> = {
  server: '@SERVER@',
  database: '@DATABASE@',
  table: '@TABLE@_@DATABASE@',
  result: 'export',
}

/** Tokens of file name templates (section 5.5) with the message that explains each. */
export const FILE_TOKENS: { token: string; help: MessageKey }[] = [
  { token: '@SERVER@', help: 'io.token.server' },
  { token: '@DATABASE@', help: 'io.token.database' },
  { token: '@TABLE@', help: 'io.token.table' },
  { token: '@COLUMNS@', help: 'io.token.columns' },
  { token: '@YEAR@', help: 'io.token.year' },
  { token: '@MONTH@', help: 'io.token.month' },
  { token: '@DAY@', help: 'io.token.day' },
  { token: '@HOUR@', help: 'io.token.hour' },
  { token: '@MINUTE@', help: 'io.token.minute' },
  { token: '@SECOND@', help: 'io.token.second' },
  { token: '@HTTP_HOST@', help: 'io.token.host' },
]

export const scopeKey = (t: ExportTarget): ExportScopeKey => t.kind

/** A database or server export has many objects; its CSV goes into a zip (FR-IO-006). */
export const isMultiScope = (t: ExportTarget): boolean =>
  t.kind === 'server' || t.kind === 'database'

export function initialExportState(prefs: IoPrefs, target: ExportTarget): ExportState {
  return {
    format: prefs.exportFormat,
    compression: prefs.exportCompression,
    options: {
      sql: defaultValues(EXPORT_OPTIONS.sql),
      csv: defaultValues(EXPORT_OPTIONS.csv),
      json: defaultValues(EXPORT_OPTIONS.json),
    },
    separateFiles: false,
    view: 'file',
    fileNameTemplate:
      prefs.fileNameTemplates[scopeKey(target)] ?? DEFAULT_TEMPLATES[scopeKey(target)],
    lock: false,
    skipUnreadable: false,
    excluded: [],
    maxTableMiB: '',
    rangeOn: false,
    offset: 0,
    count: 1000,
  }
}

/** Why a control is fixed, for the explanation next to it. */
export type Forced = {
  compression?: 'csvZip'
  separate?: 'needsZip' | 'singleObject'
  text?: 'zip'
}

/**
 * Keeps the combination valid: formats and compressions the server offers, CSV of many tables as zip, text view
 * only for a single plain or gzip-free output, separate files only inside a zip.
 */
export function normalizeExport(
  state: ExportState,
  target: ExportTarget,
  caps: Pick<IoCapabilities, 'formats' | 'compressions'>,
): { state: ExportState; forced: Forced } {
  const forced: Forced = {}
  let { format, compression, view, separateFiles } = state
  if (!caps.formats.includes(format)) format = caps.formats[0] ?? 'sql'
  if (!caps.compressions.includes(compression)) compression = 'none'
  if (format === 'csv' && isMultiScope(target)) {
    compression = 'zip'
    forced.compression = 'csvZip'
  }
  if (compression === 'zip') {
    if (view === 'text') view = 'file'
    forced.text = 'zip'
  }
  if (!isMultiScope(target)) {
    separateFiles = false
    forced.separate = 'singleObject'
  } else if (compression !== 'zip') {
    separateFiles = false
    forced.separate = 'needsZip'
  }
  return { state: { ...state, format, compression, view, separateFiles }, forced }
}

// ---- File name preview ---------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
export const EXTENSION: Record<IoFormat, string> = { sql: '.sql', csv: '.csv', json: '.json' }
const COMPRESSION_EXT: Record<Compression, string> = { none: '', gzip: '.gz', zip: '.zip' }

/** Same rules as the server (section 5.5) so the preview is honest; the server's name is the one that counts. */
export function sanitizeFileName(raw: string): string {
  let s = raw
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}_.-]/gu, '_')
    .replace(/^\.+/, '')
  if (s.length > MAX_FILENAME_CHARS) s = s.slice(0, MAX_FILENAME_CHARS)
  return s === '' ? 'export' : s
}

export type NameContext = {
  server: string
  db?: string
  table?: string
  columns?: string[]
  host?: string
  now?: Date
}

export function expandTemplate(template: string, ctx: NameContext): string {
  const now = ctx.now ?? new Date()
  const map: Record<string, string> = {
    '@SERVER@': ctx.server,
    '@DATABASE@': ctx.db ?? '',
    '@TABLE@': ctx.table ?? '',
    '@COLUMNS@': (ctx.columns ?? []).slice(0, 3).join('-'),
    '@YEAR@': String(now.getFullYear()),
    '@MONTH@': pad(now.getMonth() + 1),
    '@DAY@': pad(now.getDate()),
    '@HOUR@': pad(now.getHours()),
    '@MINUTE@': pad(now.getMinutes()),
    '@SECOND@': pad(now.getSeconds()),
    '@HTTP_HOST@': ctx.host ?? '',
  }
  return template.replace(/@[A-Z_]+@/g, (m) => map[m] ?? m)
}

/** `customer_shop.sql`, `shop.csv.zip`: expanded, sanitised, extension chain added when missing. */
export function previewFileName(
  template: string,
  ctx: NameContext,
  format: IoFormat,
  compression: Compression,
): string {
  let name = sanitizeFileName(expandTemplate(template, ctx))
  const ext = EXTENSION[format]
  if (!name.toLowerCase().endsWith(ext)) name += ext
  const c = COMPRESSION_EXT[compression]
  return c && !name.toLowerCase().endsWith(c) ? name + c : name
}

// ---- Request ------------------------------------------------------------------------------------------

const without = (all: string[], excluded: string[]) => all.filter((n) => !excluded.includes(n))

/** Names chosen in the picker; undefined means all of them (the server then reads the live list). */
export const selectionList = (all: string[], excluded: string[]): string[] | undefined =>
  excluded.length === 0 ? undefined : without(all, excluded)

export type ExportProblem =
  | { code: 'noneSelected' }
  | { code: 'range' }
  | { code: 'template' }
  | { code: 'option'; key: string }
  | { code: 'maxTable' }

export function validateExport(
  state: ExportState,
  target: ExportTarget,
  allNames: string[],
): ExportProblem[] {
  const problems: ExportProblem[] = []
  if (
    isMultiScope(target) &&
    allNames.length > 0 &&
    without(allNames, state.excluded).length === 0
  ) {
    problems.push({ code: 'noneSelected' })
  }
  if (target.kind === 'table' && state.rangeOn) {
    const ok = (v: number | '', min: number) => v !== '' && Number.isInteger(v) && v >= min
    if (!ok(state.offset, 0) || !ok(state.count, 1)) problems.push({ code: 'range' })
  }
  if (
    state.maxTableMiB !== '' &&
    !(Number.isInteger(state.maxTableMiB) && state.maxTableMiB >= 1)
  ) {
    problems.push({ code: 'maxTable' })
  }
  if (state.fileNameTemplate.length > MAX_TEMPLATE_NAME) problems.push({ code: 'template' })
  const errors = validateOptions(EXPORT_OPTIONS[state.format], state.options[state.format], {
    format: state.format,
  })
  for (const key of Object.keys(errors)) problems.push({ code: 'option', key })
  return problems
}

function scopeOf(state: ExportState, target: ExportTarget, allNames: string[]): ExportScope {
  switch (target.kind) {
    case 'server': {
      const databases = selectionList(allNames, state.excluded)
      return { kind: 'server', ...(databases ? { databases } : {}) }
    }
    case 'database': {
      const tables = selectionList(allNames, state.excluded)
      return {
        kind: 'database',
        db: target.db,
        ...(tables ? { tables } : {}),
        ...(state.maxTableMiB !== '' ? { maxTableMiB: state.maxTableMiB } : {}),
      }
    }
    case 'table':
      return {
        kind: 'table',
        db: target.db,
        table: target.table,
        ...(state.rangeOn && state.offset !== '' && state.count !== ''
          ? { range: { offset: state.offset, count: state.count } }
          : {}),
      }
    case 'result':
      return {
        kind: 'result',
        ...(target.db ? { db: target.db } : {}),
        text: target.text,
        statementIndex: target.statementIndex,
      }
  }
}

/** Only the options of the chosen format travel; numbers are stored as typed, booleans as booleans. */
function typedOptions(
  format: IoFormat,
  values: OptionValues,
  caps: Pick<IoCapabilities, 'limits'>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of EXPORT_OPTIONS[format]) {
    if (spec.type === 'note') continue
    const v = values[spec.key]
    if (v !== undefined) out[spec.key] = v
  }
  if (format === 'csv') {
    // Undefined = the resolved server default (ST-157); only an explicit difference is sent.
    if (!caps.limits.mayDisableFormulaNeutralisation)
      out['neutraliseFormulas'] = caps.limits.formulaNeutralisation
    if (out['neutraliseFormulas'] === caps.limits.formulaNeutralisation)
      delete out['neutraliseFormulas']
  }
  return out
}

export function buildExportRequest(
  state: ExportState,
  target: ExportTarget,
  caps: Pick<IoCapabilities, 'limits'>,
  allNames: string[],
): ExportRequest {
  const base = {
    scope: scopeOf(state, target, allNames),
    compression: state.compression,
    separateFiles: state.separateFiles,
    view: state.view,
    fileNameTemplate: state.fileNameTemplate,
    lock: state.lock,
    skipUnreadable: state.skipUnreadable,
  }
  const options = typedOptions(state.format, state.options[state.format], caps)
  return { ...base, format: state.format, options } as ExportRequest
}

export function nameContext(
  target: ExportTarget,
  server: string,
  columns?: string[],
  now?: Date,
): NameContext {
  return {
    server,
    ...(target.kind !== 'server' && target.db ? { db: target.db } : {}),
    ...(target.kind === 'table' ? { table: target.table } : {}),
    ...(columns ? { columns } : {}),
    ...(now ? { now } : {}),
  }
}
