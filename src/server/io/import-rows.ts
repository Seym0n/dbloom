/**
 * CSV and JSON import into a table (FR-IO-018, FR-IO-019, FR-IO-023, DATA-ISS-006/107, DATA-UPD-005/006).
 * Rows are read by streaming parsers (`csv.ts`, `json-rows.ts`), converted per column with the codecs of the
 * rows module, and written with multi-row prepared INSERT, INSERT IGNORE or REPLACE batches: values only as
 * parameters, identifiers only through `quoteIdent`. Mode `allOrNothing` is one transaction (the first problem
 * rolls everything back and names row and column); `keepGoing` commits per batch, isolates a failing batch row
 * by row and collects the rejects, and the job then ends `done_with_rejects`, never `done`.
 */
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import { killThreadQuery } from '../guard/statement-timeout'
import { quoteIdent } from '../db/identifiers'
import { mapMysqlError } from '../structure/errors'
import { auditIo } from '../audit'
import { loadRowTable } from '../rows/model'
import { RowValueError, isWritable, parseText, parseHexBytes, type Param } from '../rows/codecs'
import { fieldOf } from '../rows/execute'
import type { RowColumn, RowTable } from '../rows/types'
import * as fx from '../sql/fixed'
import { CsvParseError, ProblemList, readCsvRows } from './csv'
import { JsonNumber, JsonParseError, type JsonReadValue } from './json'
import { readJsonRows } from './json-rows'
import {
  ImportAccum,
  SET_NAMES,
  failResult,
  finishJob,
  resultOf,
  retainSource,
  classCountsText,
  type ImportRunEnv,
} from './import-job'
import { IoFailure, asIoFailure, failure, openDecoded, type DecodedText, type ImportSource } from './import-source'
import {
  INSERT_BATCH_ROWS,
  TYPE_SAMPLE_ROWS,
  type ColumnMap,
  type IoError,
  type ParseProblem,
  type RowImportOptions,
} from './types'

/** Row options of the contract plus the reversal of the formula prefix (see report: contract addition). */
export type RowSourceOptions = RowImportOptions & { revertFormulaPrefix?: boolean }

export type RowFormat = 'csv' | 'json'

const JSON_KEY_ROWS = 1000
const SAMPLE_ROWS = 20

// ---- Raw rows -------------------------------------------------------------------------------------------------------

type Cells = (string | null)[] | { [key: string]: string | null }

export type RawRow = {
  /** 1-based record number (CSV: header and skipped records count). */
  row: number
  line?: number
  cells: Cells
  problems: ParseProblem[]
}

export type RawEvent =
  | { kind: 'header'; names: string[]; problems: ParseProblem[] }
  | { kind: 'table'; name: string }
  | { kind: 'row'; raw: RawRow }

function serialize(v: JsonReadValue): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (v instanceof JsonNumber) return v.text
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return `[${v.map(serialize).join(',')}]`
  return `{${Object.entries(v)
    .map(([k, x]) => `${JSON.stringify(k)}:${serialize(x)}`)
    .join(',')}}`
}

/** A JSON value as the text a cell would have (numbers exact, booleans 1 and 0, nested values as JSON). */
export function jsonCellText(v: JsonReadValue): string | null {
  if (v === null) return null
  if (typeof v === 'string') return v
  if (v instanceof JsonNumber) return v.text
  if (typeof v === 'boolean') return v ? '1' : '0'
  return serialize(v)
}

const isPlainObject = (v: JsonReadValue): v is { [k: string]: JsonReadValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber)

export function parseFailure(e: unknown): unknown {
  if (e instanceof CsvParseError) {
    return failure('row_rejected', `The CSV cannot be read at line ${e.line}: ${e.message}`, { line: e.line })
  }
  if (e instanceof JsonParseError) return failure('row_rejected', `The JSON cannot be read: ${e.message}`)
  return asIoFailure(e)
}

/**
 * Raw records of the file. CSV: one `header` event (when the option is set), then rows. JSON: a plain array of
 * objects or arrays, or the DBLoom export shape, where the rows of the selected `table` element are read
 * (`options.jsonTable`, else the first).
 */
export async function* readRawRows(
  d: DecodedText,
  format: RowFormat,
  o: RowSourceOptions,
  tables?: string[],
): AsyncGenerator<RawEvent> {
  try {
    if (format === 'csv') {
      for await (const r of readCsvRows(d.text, {
        separator: o.separator,
        enclosure: o.enclosure,
        escape: o.escape,
        lineEnding: o.lineEnding,
        nullText: o.nullText,
        header: o.header,
        skipRows: o.skipRows,
      })) {
        if (r.isHeader) {
          yield { kind: 'header', names: r.fields.map((f) => f ?? ''), problems: r.problems }
        } else {
          yield { kind: 'row', raw: { row: r.row, line: r.line, cells: r.fields, problems: r.problems } }
        }
      }
      return
    }
    let dbloom: boolean | undefined
    let selected: string | undefined = o.jsonTable
    let inSelected = true
    let plainRow = 0
    let tableRow = 0
    for await (const ev of readJsonRows(d.text)) {
      if (ev.kind === 'table') {
        dbloom = true
        tables?.push(ev.name)
        selected ??= ev.name
        inSelected = ev.name === selected
        tableRow = 0
        if (inSelected) yield { kind: 'table', name: ev.name }
        continue
      }
      if (ev.kind === 'tableEnd') {
        inSelected = false
        continue
      }
      let value: JsonReadValue
      let row: number
      if (ev.kind === 'row') {
        if (!inSelected) continue
        value = ev.value
        row = ++tableRow
      } else {
        const v = ev.value
        if (dbloom === undefined) {
          dbloom = isPlainObject(v) && v.type === 'header' && v.generator === 'DBLoom'
        }
        if (dbloom) continue
        value = v
        row = ++plainRow
      }
      if (row <= o.skipRows) continue
      if (isPlainObject(value)) {
        const cells: { [k: string]: string | null } = Object.create(null) as { [k: string]: string | null }
        for (const [k, x] of Object.entries(value)) cells[k] = jsonCellText(x)
        yield { kind: 'row', raw: { row, cells, problems: [] } }
      } else if (Array.isArray(value)) {
        yield { kind: 'row', raw: { row, cells: value.map(jsonCellText), problems: [] } }
      } else {
        yield {
          kind: 'row',
          raw: { row, cells: [], problems: [{ row, code: 'row_not_object', message: 'The element is not an object or an array' }] },
        }
      }
    }
  } catch (e) {
    throw parseFailure(e)
  }
}

// ---- Type inference (FR-IO-019) ---------------------------------------------------------------------------------

const INT_RE = /^-?(0|[1-9]\d*)$/
const DEC_RE = /^-?(0|[1-9]\d*)\.(\d+)$/
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const DATETIME_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.(\d{1,6}))?$/
const TIME_RE = /^-?\d{1,3}:[0-5]\d:[0-5]\d(\.(\d{1,6}))?$/
const VARCHAR_STEPS = [16, 32, 64, 128, 255]
const INT32_MIN = -(2n ** 31n)
const INT32_MAX = 2n ** 31n - 1n
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n
const UINT64_MAX = 2n ** 64n - 1n

/** Collects what is needed to choose a column type from a sample. */
export class TypeInference {
  private n = 0
  private isInt = true
  private isDec = true
  private isDate = true
  private isDateTime = true
  private isTime = true
  private min = 0n
  private max = 0n
  private maxIntDigits = 0
  private maxFrac = 0
  private fsp = 0
  private maxChars = 0
  private maxBytes = 0

  add(v: string | null): void {
    if (v === null || v === '') return
    this.n++
    const chars = [...v].length
    if (chars > this.maxChars) this.maxChars = chars
    const bytes = Buffer.byteLength(v, 'utf8')
    if (bytes > this.maxBytes) this.maxBytes = bytes
    if (this.isInt) {
      if (INT_RE.test(v)) {
        const b = BigInt(v)
        if (this.n === 1 || b < this.min) this.min = b
        if (this.n === 1 || b > this.max) this.max = b
      } else this.isInt = false
    }
    if (this.isDec) {
      const dm = DEC_RE.exec(v)
      if (dm) {
        const frac = (dm[2] as string).length
        const int = v.replace(/^-/, '').split('.')[0] as string
        if (frac > this.maxFrac) this.maxFrac = frac
        if (int.length > this.maxIntDigits) this.maxIntDigits = int.length
      } else if (INT_RE.test(v)) {
        const int = v.replace(/^-/, '')
        if (int.length > this.maxIntDigits) this.maxIntDigits = int.length
      } else this.isDec = false
    }
    if (this.isDate && !DATE_RE.test(v)) this.isDate = false
    if (this.isDateTime) {
      const m = DATETIME_RE.exec(v)
      if (!m) this.isDateTime = false
      else if (m[5] && m[5].length > this.fsp) this.fsp = m[5].length
    }
    if (this.isTime && !TIME_RE.test(v)) this.isTime = false
  }

  /** The SQL type as text, e.g. `INT`, `DECIMAL(10,2)`, `VARCHAR(64)`, `TEXT`. */
  result(): string {
    if (this.n === 0) return 'VARCHAR(16)'
    if (this.isInt) {
      if (this.min >= INT32_MIN && this.max <= INT32_MAX) return 'INT'
      if (this.min >= INT64_MIN && this.max <= INT64_MAX) return 'BIGINT'
      if (this.min >= 0n && this.max <= UINT64_MAX) return 'BIGINT UNSIGNED'
      const digits = Math.max(this.min.toString().replace('-', '').length, this.max.toString().length)
      if (digits <= 65) return `DECIMAL(${digits},0)`
    } else if (this.isDec && this.maxFrac > 0) {
      const p = this.maxIntDigits + this.maxFrac
      if (p <= 65 && this.maxFrac <= 30) return `DECIMAL(${p},${this.maxFrac})`
    }
    if (this.isDate) return 'DATE'
    if (this.isDateTime) return this.fsp > 0 ? `DATETIME(${this.fsp})` : 'DATETIME'
    if (this.isTime) return 'TIME'
    if (this.maxChars <= 255) return `VARCHAR(${VARCHAR_STEPS.find((s) => s >= this.maxChars) ?? 255})`
    return this.maxBytes <= 65_535 ? 'TEXT' : 'LONGTEXT'
  }
}

// ---- Scan for the analysis ---------------------------------------------------------------------------------------------

export type RowScan = {
  columns: string[]
  sample: (string | null)[][]
  rowCount: number
  warnings: ParseProblem[]
  inferred: string[]
  jsonTables: string[]
  /** Column names come from a header or from JSON keys (else file positions). */
  named: boolean
}

const align = (cells: Cells, names: string[]): (string | null)[] =>
  Array.isArray(cells) ? cells : names.map((n) => (n in cells ? (cells[n] as string | null) : null))

/** Reads the whole file once: columns, a sample, the row count, problems and an inferred type per column. */
export async function scanRowFile(d: DecodedText, format: RowFormat, o: RowSourceOptions): Promise<RowScan> {
  let columns: string[] = []
  let named = false
  const infer: TypeInference[] = []
  const rawSample: Cells[] = []
  const problems = new ProblemList()
  const tables: string[] = []
  let count = 0
  const key = new Map<string, number>()
  const grow = (name: string) => {
    key.set(name, columns.length)
    columns.push(name)
    infer.push(new TypeInference())
  }
  for await (const ev of readRawRows(d, format, o, tables)) {
    if (ev.kind === 'header') {
      named = true
      columns = ev.names.map((n, i) => (n.trim() === '' ? `col_${i + 1}` : n))
      columns.forEach(() => infer.push(new TypeInference()))
      for (const p of ev.problems) problems.add(p)
      continue
    }
    if (ev.kind === 'table') continue
    const r = ev.raw
    count++
    for (const p of r.problems) problems.add(p)
    if (rawSample.length < SAMPLE_ROWS) rawSample.push(r.cells)
    if (Array.isArray(r.cells)) {
      while (columns.length < r.cells.length && (!named || columns.length === 0)) grow(`col_${columns.length + 1}`)
      if (count <= TYPE_SAMPLE_ROWS) r.cells.forEach((v, i) => infer[i]?.add(v))
    } else {
      named = true
      if (count <= JSON_KEY_ROWS) for (const k of Object.keys(r.cells)) if (!key.has(k)) grow(k)
      if (count <= TYPE_SAMPLE_ROWS) {
        for (const [k, v] of Object.entries(r.cells)) {
          const at = key.get(k)
          if (at !== undefined) infer[at]?.add(v)
        }
      }
    }
  }
  return {
    columns,
    sample: rawSample.map((c) => align(c, columns).slice(0, columns.length)),
    rowCount: count,
    warnings: problems.items,
    inferred: infer.map((t) => t.result()),
    jsonTables: tables,
    named,
  }
}

// ---- Conversion --------------------------------------------------------------------------------------------------------

const FORMULA_PREFIX = /^'[=+\-@\t\r]/
const TEXT_KINDS = new Set(['char', 'text', 'enum', 'set'])
const HEX_ONLY = /^(?:0x|x')[0-9a-f]*'?$/i

export type Converted = { frag: string; params: Param[] }

/**
 * One cell to a placeholder and its parameters. DBLoom's CSV export prefixes cells that start with a formula
 * character with `'` (FR-IO-023); for text columns that single quote is removed again. Decimals are not
 * checked for extra places: the server rounds them with a note (DATA-UPD-005).
 */
export function convertCell(col: RowColumn, text: string | null, revertFormula: boolean): Converted {
  if (text === null) {
    if (!col.nullable && !col.autoIncrement && col.kind !== 'timestamp') {
      throw new RowValueError('invalid-value', `${col.name}: this column cannot be empty (NULL)`, col.name)
    }
    return { frag: '?', params: [null] }
  }
  let t = text
  if (revertFormula && TEXT_KINDS.has(col.kind) && FORMULA_PREFIX.test(t)) t = t.slice(1)
  if (col.kind === 'geometry') {
    if (HEX_ONLY.test(t)) return { frag: '?', params: [parseHexBytes(col, t)] }
    const wkt = parseText(col, t, 'write') as string
    const m = /^SRID=(\d{1,10});/i.exec(t)
    return { frag: 'ST_GeomFromText(?, ?)', params: [wkt, m ? (m[1] as string) : String(col.srid ?? 0)] }
  }
  const p = parseText(col, t, col.kind === 'decimal' ? 'guard' : 'write')
  return { frag: '?', params: [p] }
}

// ---- Mapping -------------------------------------------------------------------------------------------------------------

export type PlanColumn = { index: number; col: RowColumn; label: string }

/**
 * File column -> table column. With `mapping` the user's choice is used (unknown names are refused); without
 * it, names are matched case-insensitively (header or JSON keys) or file position i goes to the i-th writable
 * column. Generated and unknown-type columns are never targets.
 */
export function resolveMapping(
  columns: string[],
  named: boolean,
  mapping: ColumnMap[] | undefined,
  table: RowTable,
): PlanColumn[] {
  const writable = table.columns.filter(isWritable)
  const byName = (n: string) => table.columns.find((c) => c.name === n) ?? table.columns.find((c) => c.name.toLowerCase() === n.toLowerCase())
  const plan: PlanColumn[] = []
  const used = new Set<string>()
  const add = (index: number, col: RowColumn, label: string) => {
    if (!isWritable(col)) throw failure('invalid_request', `Column ${col.name} cannot be written`)
    if (used.has(col.name)) throw failure('invalid_request', `Column ${col.name} is mapped twice`)
    used.add(col.name)
    plan.push({ index, col, label })
  }
  if (mapping) {
    for (const m of mapping) {
      if (m.target === null) continue
      let index: number
      if (typeof m.source === 'number') index = m.source
      else {
        index = columns.indexOf(m.source)
        if (index < 0) index = columns.findIndex((c) => c.toLowerCase() === (m.source as string).toLowerCase())
      }
      if (index < 0 || index >= Math.max(columns.length, typeof m.source === 'number' ? m.source + 1 : 0)) {
        throw failure('invalid_request', 'The mapping names a file column that does not exist')
      }
      const col = byName(m.target)
      if (!col) throw failure('invalid_request', `The table has no column ${m.target}`)
      add(index, col, columns[index] ?? String(index + 1))
    }
  } else if (named) {
    columns.forEach((name, index) => {
      const col = byName(name)
      if (col && isWritable(col) && !used.has(col.name)) add(index, col, name)
    })
  } else {
    columns.forEach((name, index) => {
      const col = writable[index]
      if (col) add(index, col, name)
    })
  }
  if (plan.length === 0) {
    throw failure('invalid_request', 'No file column is mapped to a column of the table; choose a mapping')
  }
  return plan
}

// ---- Runner ---------------------------------------------------------------------------------------------------------------

export type RowResume = {
  sourceId: string
  format: RowFormat
  charset?: string
  db: string
  table: string
  options: RowSourceOptions
  mapping?: ColumnMap[]
  totalBytes?: number
  lastRow: number
  acc: ImportAccum
  duplicates: number
}

export const rowResumes = new Map<string, RowResume>()

export type RowRunArgs = {
  env: ImportRunEnv
  source: ImportSource
  format: RowFormat
  charset?: string
  db: string
  table: string
  /** Statements of the structure builder that create the new table (run first, not on resume). */
  createSql?: string[]
  options: RowSourceOptions
  mapping?: ColumnMap[]
  totalBytes?: number
  resume?: RowResume
}

const BATCH_BYTES = 4 * 1024 * 1024
const MAX_PLACEHOLDERS = 60_000
const SAVEPOINT = 'SAVEPOINT dbloom_batch'
const ROLLBACK_TO = 'ROLLBACK TO SAVEPOINT dbloom_batch'

type Pending = { row: number; frag: string; params: Param[]; bytes: number }
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

export async function runRowImport(a: RowRunArgs): Promise<void> {
  const { env, options: o } = a
  const now = env.now ?? Date.now
  const acc = a.resume?.acc ?? new ImportAccum()
  let duplicates = a.resume?.duplicates ?? 0
  const segStart = now()
  const elapsed = () => acc.elapsedMs + (now() - segStart)
  const signal = env.jobs.signal(env.jobId)
  const revert = o.revertFormulaPrefix !== false
  const resumeAfter = a.resume?.lastRow ?? 0
  let conn: PoolConnection | undefined
  let txOpen = false
  let lastRow = resumeAfter
  let lastProgress = 0
  let warnReads = 0
  const ctl: { stop: 'none' | 'fail' | 'pause' | 'cancel'; failed?: IoError } = { stop: 'none' }
  const endAudit = () => ({ rows: acc.rows, classCounts: classCountsText(acc.classCounts) })
  let counter = { bytes: 0 }

  try {
    retainSource(env, a.source.id, a.source.kind)
    conn = await env.pool.getConnection()
    const c = conn
    env.jobs.setCancelHook(env.jobId, async () => {
      await killThreadQuery(env.pool, c.threadId)
      c.destroy()
    })
    await c.query(SET_NAMES)
    if (a.createSql && !a.resume) {
      for (const s of a.createSql) await c.query(s)
      acc.changes.add(a.db, a.table)
      acc.note(`Created table ${a.db}.${a.table}`)
      acc.createdTable = { db: a.db, table: a.table }
    }
    const table = await loadRowTable(env.pool, a.db, a.table)
    if (table.kind !== 'table') throw failure('invalid_request', 'Rows can only be imported into a table')

    // Pass 1: columns (CSV: header or first record; JSON: keys of the first rows).
    const probe = await openDecoded(a.source, env, a.charset)
    let columns: string[] = []
    let named = false
    try {
      let seen = 0
      const keys: string[] = []
      const keySet = new Set<string>()
      let width = 0
      probeLoop: for await (const ev of readRawRows(probe, a.format, o)) {
        if (ev.kind === 'header') {
          named = true
          columns = ev.names.map((n, i) => (n.trim() === '' ? `col_${i + 1}` : n))
          break
        }
        if (ev.kind !== 'row') continue
        seen++
        if (Array.isArray(ev.raw.cells)) {
          width = Math.max(width, ev.raw.cells.length)
          if (a.format === 'csv') break probeLoop
        } else {
          named = true
          for (const k of Object.keys(ev.raw.cells)) if (!keySet.has(k)) {
              keySet.add(k)
              keys.push(k)
            }
        }
        if (seen >= JSON_KEY_ROWS) break
      }
      if (columns.length === 0) {
        columns = keys.length > 0 ? keys : Array.from({ length: width }, (_, i) => `col_${i + 1}`)
      }
    } finally {
      await probe.text.return(undefined)
    }
    const plan = resolveMapping(columns, named, a.mapping, table)
    const verb = o.conflict === 'ignore' ? 'INSERT IGNORE' : o.conflict === 'replace' ? 'REPLACE' : 'INSERT'
    const head = `${verb} INTO ${quoteIdent(table.db)}.${quoteIdent(table.table)} (${plan.map((p) => quoteIdent(p.col.name)).join(', ')}) VALUES `
    const batchRows = Math.max(1, Math.min(INSERT_BATCH_ROWS, Math.floor(MAX_PLACEHOLDERS / (plan.length + 1))))
    if (o.mode === 'allOrNothing') {
      await c.query(fx.START_TRANSACTION)
      txOpen = true
      if (!table.transactional) {
        acc.note('This table has no transactions; "all or nothing" cannot undo rows that were already written.')
      }
    }

    const readNotes = async () => {
      if (warnReads >= 10) return
      warnReads++
      try {
        const [rows] = await c.query(fx.SHOW_WARNINGS)
        for (const r of (rows as Record<string, unknown>[]).slice(0, 5)) {
          acc.note(`${str(r.Level)} ${Number(r.Code) || 0}: ${str(r.Message)}`)
        }
      } catch {
        // best effort
      }
    }
    const account = async (n: number, h: ResultSetHeader) => {
      const inserted = o.conflict === 'ignore' ? Number(h.affectedRows) : n
      if (o.conflict === 'ignore') duplicates += n - inserted
      acc.rows += inserted
      if (h.warningStatus > 0) await readNotes()
    }
    const sqlOf = (batch: Pending[]) => head + batch.map((p) => `(${p.frag})`).join(', ')
    const run = async (batch: Pending[]) => {
      const [res] = await c.execute(
        sqlOf(batch),
        batch.flatMap((p) => p.params),
      )
      await account(batch.length, res as ResultSetHeader)
    }
    const reject = (p: ParseProblem) => {
      acc.reject(p)
    }
    const failRow = (p: ParseProblem, extra: Partial<IoError> = {}) => {
      reject(p)
      ctl.stop = 'fail'
      ctl.failed = {
        code: 'row_rejected',
        message: `Row ${p.row}${p.column ? `, column ${p.column}` : ''}: ${p.message}`,
        ...extra,
      }
    }

    let pending: Pending[] = []
    let pendingBytes = 0

    const flush = async (): Promise<void> => {
      if (pending.length === 0 || ctl.stop !== 'none') return
      const batch = pending
      pending = []
      pendingBytes = 0
      if (o.mode === 'allOrNothing' && table.transactional) await c.query(SAVEPOINT)
      try {
        await run(batch)
        lastRow = batch[batch.length - 1]!.row
      } catch (e) {
        if (signal.aborted) {
          ctl.stop = 'cancel'
          return
        }
        if ((e as { fatal?: unknown })?.fatal === true) throw e
        const m = mapMysqlError(e)
        if (o.mode === 'allOrNothing') {
          // Find the row: undo the batch, then try the rows one by one up to the first failure.
          let culprit: Pending | undefined
          let detail = m
          if (table.transactional) {
            try {
              await c.query(ROLLBACK_TO)
              for (const p of batch) {
                try {
                  await run([p])
                } catch (e2) {
                  culprit = p
                  detail = mapMysqlError(e2)
                  break
                }
              }
            } catch {
              culprit = undefined
            }
          }
          const where = culprit ? `Row ${culprit.row}` : `Rows ${batch[0]!.row} to ${batch[batch.length - 1]!.row}`
          const column = fieldOf(detail.message, table)
          reject({ row: culprit?.row ?? batch[0]!.row, ...(column ? { column } : {}), code: String(detail.errno ?? 'error'), message: detail.message })
          ctl.stop = 'fail'
          ctl.failed = {
            code: 'row_rejected',
            message: `${where}${column ? `, column ${column}` : ''}: ${detail.message}`,
            ...(detail.errno != null ? { errno: detail.errno } : {}),
            serverMessage: detail.message,
          }
          return
        }
        // keep going: the failed statement wrote nothing (InnoDB); isolate the rows.
        for (const p of batch) {
          try {
            await run([p])
          } catch (e2) {
            if (signal.aborted) {
              ctl.stop = 'cancel'
              return
            }
            if ((e2 as { fatal?: unknown })?.fatal === true) throw e2
            const d = mapMysqlError(e2)
            const column = fieldOf(d.message, table)
            reject({ row: p.row, ...(column ? { column } : {}), code: String(d.errno ?? 'error'), message: d.message })
          }
        }
        lastRow = batch[batch.length - 1]!.row
      }
    }

    // Pass 2: the rows.
    const main = await openDecoded(a.source, env, a.charset)
    counter = main.counter
    try {
      scan: for await (const ev of readRawRows(main, a.format, o)) {
        if (signal.aborted) {
          ctl.stop = 'cancel'
          break
        }
        if (ev.kind !== 'row') continue
        const raw = ev.raw
        if (raw.row <= resumeAfter) continue
        acc.classCounts.rows = (acc.classCounts.rows ?? 0) + 1
        if (raw.problems.length > 0) {
          const [first, ...rest] = raw.problems as [ParseProblem, ...ParseProblem[]]
          if (o.mode === 'allOrNothing') {
            for (const p of rest) reject(p)
            failRow(first)
            break
          }
          for (const p of raw.problems) reject(p)
          lastRow = raw.row
          continue
        }
        const cells = align(raw.cells, columns)
        const frags: string[] = []
        const params: Param[] = []
        let bytes = 16
        let bad: ParseProblem | undefined
        for (const p of plan) {
          try {
            const text = cells[p.index] ?? null
            const conv = convertCell(p.col, text, revert)
            frags.push(conv.frag)
            for (const x of conv.params) {
              params.push(x)
              bytes += x === null ? 4 : typeof x === 'string' ? x.length + 2 : x.length * 2 + 2
            }
          } catch (e) {
            if (!(e instanceof RowValueError)) throw e
            bad = { row: raw.row, column: p.label, code: e.code, message: e.message.replace(/^[^:]*:\s*/, '') }
            break
          }
        }
        if (bad) {
          if (o.mode === 'allOrNothing') {
            failRow(bad)
            break
          }
          reject(bad)
          lastRow = raw.row
          continue
        }
        pending.push({ row: raw.row, frag: frags.join(', '), params, bytes })
        pendingBytes += bytes
        if (pending.length >= batchRows || pendingBytes >= BATCH_BYTES) {
          await flush()
          if (ctl.stop !== 'none') break scan
          const t = now()
          if (t - lastProgress > 250) {
            lastProgress = t
            env.jobs.progress(env.jobId, {
              bytes: counter.bytes,
              ...(a.totalBytes !== undefined ? { totalBytes: a.totalBytes } : {}),
              rows: acc.rows,
            })
          }
          if (elapsed() >= env.jobMs) {
            if (o.mode === 'keepGoing') ctl.stop = 'pause'
            else {
              ctl.stop = 'fail'
              ctl.failed = { code: 'time_limit', message: 'The time limit was reached; nothing was kept (all or nothing)' }
            }
            break scan
          }
        }
      }
    } finally {
      await main.text.return(undefined)
    }
    if (ctl.stop === 'none') await flush()

    // ---- End
    if (ctl.stop === 'cancel' || signal.aborted) return
    acc.elapsedMs = elapsed()
    env.jobs.progress(env.jobId, { bytes: counter.bytes, rows: acc.rows })
    if (ctl.stop === 'fail' && ctl.failed) {
      if (txOpen) {
        await c.query(fx.ROLLBACK).catch(() => undefined)
        txOpen = false
        acc.rows = 0
        acc.note('The import was rolled back; no row was kept.')
      }
      acc.changes.emit()
      finishJob(env, 'failed', failResult(acc, env, ctl.failed), endAudit())
      rowResumes.delete(env.jobId)
      return
    }
    if (txOpen) {
      await c.query(fx.COMMIT)
      txOpen = false
    }
    if (duplicates > 0) acc.note(`${duplicates} rows were skipped because they already exist (duplicates).`)
    acc.changes.emit()
    if (ctl.stop === 'pause') {
      rowResumes.set(env.jobId, {
        sourceId: a.source.id,
        format: a.format,
        charset: a.charset,
        db: a.db,
        table: a.table,
        options: o,
        mapping: a.mapping,
        totalBytes: a.totalBytes,
        lastRow,
        acc,
        duplicates,
      })
      env.jobs.pause(
        env.jobId,
        resultOf(acc, { rows: acc.rows, resume: { decodedOffset: counter.bytes, statementNumber: lastRow } }),
      )
      auditIo('io.import.end', { user: env.user, target: env.targetLabel, jobId: env.jobId, kind: 'import', state: 'paused', ...endAudit(), durationMs: acc.elapsedMs })
      return
    }
    const state = acc.rejected.count > 0 ? 'done_with_rejects' : 'done'
    finishJob(env, state, resultOf(acc, { rows: acc.rows }), endAudit())
    rowResumes.delete(env.jobId)
  } catch (e) {
    if (signal.aborted) return
    acc.elapsedMs = elapsed()
    const f = asIoFailure(e)
    const error: IoError =
      f instanceof IoFailure
        ? f.error
        : (() => {
            const m = mapMysqlError(e)
            return {
              code: 'statement_failed' as const,
              message: m.errno != null ? `Error ${m.errno}: ${m.message}` : m.message,
              ...(m.errno != null ? { errno: m.errno } : {}),
              serverMessage: m.message,
            }
          })()
    if (conn && txOpen) await conn.query(fx.ROLLBACK).catch(() => undefined)
    acc.changes.emit()
    finishJob(env, 'failed', failResult(acc, env, error), endAudit())
    rowResumes.delete(env.jobId)
  } finally {
    conn?.destroy()
  }
}
