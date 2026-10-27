/**
 * CSV for module `io` (FR-IO-006, FR-IO-018). Writer: own enclosure/escape logic (the allow-listed options
 * include "no enclosure" and a backslash escape that `csv-stringify` cannot express round-trip safely).
 * Reader: streaming `csv-parse` with per-row and per-column problem reports; nothing is read into memory whole.
 */
import { Readable } from 'node:stream'
import { parse } from 'csv-parse'
import type { CsvError } from 'csv-parse'
import type { CSV_ENCLOSURES, CSV_ESCAPES, CSV_SEPARATORS, ParseProblem } from './types'
import { MAX_REJECT_DETAILS } from './types'

export const UTF8_BOM = String.fromCharCode(0xfeff)

// ---- Writer -------------------------------------------------------------------------------------------------

export type CsvWriterOptions = {
  separator: (typeof CSV_SEPARATORS)[number]
  enclosure: (typeof CSV_ENCLOSURES)[number]
  escape: (typeof CSV_ESCAPES)[number]
  lineEnding: 'lf' | 'crlf'
  /** Text that stands for NULL; a real value equal to it (or the empty string when it is empty) is enclosed. */
  nullText: string
}

/** One CSV line writer; cells come from `csvCellText`, `null` marks a NULL that was already turned into text. */
export class CsvWriter {
  private eol: string
  constructor(private o: CsvWriterOptions) {
    this.eol = o.lineEnding === 'crlf' ? '\r\n' : '\n'
  }

  cell(text: string, isNull = false): string {
    const { enclosure: q, escape: e, separator: sep, nullText } = this.o
    if (q === '') return text
    const special = text.includes(sep) || text.includes(q) || text.includes('\n') || text.includes('\r')
    const ambiguous = !isNull && text === nullText
    if (!special && !ambiguous) return text
    let body = text
    if (e !== '' && e !== q) {
      // escape the escape character itself, then the enclosure
      body = body.replaceAll(e, e + e).replaceAll(q, e + q)
    } else {
      body = body.replaceAll(q, q + q)
    }
    return q + body + q
  }

  /** `cells[i]` is the text; `nulls[i]` marks NULL cells. One line with its terminator. */
  line(cells: string[], nulls?: boolean[]): string {
    return cells.map((c, i) => this.cell(c, nulls?.[i] === true)).join(this.o.separator) + this.eol
  }
}

// ---- Reader -------------------------------------------------------------------------------------------------

export type CsvReadOptions = {
  separator: (typeof CSV_SEPARATORS)[number]
  enclosure: (typeof CSV_ENCLOSURES)[number]
  escape: (typeof CSV_ESCAPES)[number]
  lineEnding: 'lf' | 'crlf' | 'auto'
  /** Unquoted fields equal to this are NULL (empty by default, so an unquoted empty field is NULL). */
  nullText: string
  header: boolean
  skipRows: number
  /** Longest value accepted per field, in characters (the column limit, when known). */
  maxFieldChars?: number
  /** Per column (file position) character limits; wins over `maxFieldChars`. */
  columnLimits?: (number | undefined)[]
  /** Longest column name accepted (64 for MySQL). */
  maxNameChars?: number
}

export type CsvRow = {
  /** 1-based record number in the file (header and skipped rows count). */
  row: number
  /** Line where the record starts. */
  line: number
  fields: (string | null)[]
  isHeader: boolean
  /** Problems found in this record; the caller decides whether the row is rejected. */
  problems: ParseProblem[]
}

export class CsvParseError extends Error {
  constructor(
    public code: string,
    message: string,
    public line: number,
    public row: number,
  ) {
    super(message)
    this.name = 'CsvParseError'
  }
}

const SEPARATORS = [',', ';', '\t', '|', ':']

function headerProblems(names: (string | null)[], opts: CsvReadOptions): ParseProblem[] {
  const out: ParseProblem[] = []
  const max = opts.maxNameChars ?? 64
  const seen = new Map<string, number>()
  names.forEach((n, i) => {
    const label = n ?? `#${i + 1}`
    if (n === null || n.trim() === '') out.push({ row: 1, column: label, code: 'empty_name', message: `Column ${i + 1} has no name` })
    else {
      if (n.length > max) out.push({ row: 1, column: n.slice(0, 80), code: 'name_too_long', message: `Column name longer than ${max} characters` })
      const key = n.toLowerCase()
      if (seen.has(key)) out.push({ row: 1, column: n.slice(0, 80), code: 'duplicate_name', message: `Column name repeats column ${seen.get(key)}` })
      else seen.set(key, i + 1)
    }
  })
  // One wide column whose text holds another separator: the delimiter is probably wrong.
  if (names.length === 1 && typeof names[0] === 'string') {
    const other = SEPARATORS.find((s) => s !== opts.separator && (names[0] as string).includes(s))
    if (other !== undefined)
      out.push({
        row: 1,
        code: 'delimiter_merged',
        message: `Everything is in one column; the separator may be ${other === '\t' ? 'TAB' : `"${other}"`}`,
      })
  }
  return out
}

/**
 * Streaming record reader. `source` yields decoded text chunks. Wrong field counts, over-long values and bad
 * header names are reported as problems on the record; unterminated quotes and similar fatal syntax errors throw
 * `CsvParseError` with the line.
 */
export async function* readCsvRows(source: AsyncIterable<string | Uint8Array>, opts: CsvReadOptions): AsyncGenerator<CsvRow> {
  const parser = parse({
    delimiter: opts.separator,
    quote: opts.enclosure === '' ? false : opts.enclosure,
    escape: opts.enclosure === '' ? null : opts.escape === '' ? opts.enclosure : opts.escape,
    record_delimiter: opts.lineEnding === 'lf' ? '\n' : opts.lineEnding === 'crlf' ? '\r\n' : undefined,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: false,
    info: true,
    cast: (value, ctx) => {
      if (ctx.quoting) return value
      return value === opts.nullText ? null : value
    },
  })
  const feeding = Readable.from(source, { objectMode: false }).on('error', (e) => parser.destroy(e))
  feeding.pipe(parser)
  let row = 0
  let expected: number | null = null
  try {
    for await (const rec of parser as AsyncIterable<{ record: (string | null)[]; info: { lines: number } }>) {
      row++
      const fields = rec.record
      if (row <= opts.skipRows) continue
      const isHeader = opts.header && row === opts.skipRows + 1
      const problems: ParseProblem[] = []
      if (isHeader) problems.push(...headerProblems(fields, opts).map((p) => ({ ...p, row })))
      if (expected === null) expected = fields.length
      else if (fields.length !== expected)
        problems.push({
          row,
          code: 'field_count',
          message: `Found ${fields.length} fields where ${expected} were expected`,
        })
      if (!isHeader) {
        fields.forEach((v, i) => {
          const limit = opts.columnLimits?.[i] ?? opts.maxFieldChars
          if (v !== null && limit !== undefined && v.length > limit)
            problems.push({ row, column: String(i + 1), code: 'value_too_long', message: `Value of ${v.length} characters exceeds ${limit}` })
        })
      }
      yield { row, line: rec.info.lines, fields, isHeader, problems }
    }
  } catch (e) {
    const err = e as CsvError
    if (typeof err.code === 'string' && /^(CSV_|INVALID_)/.test(err.code)) {
      const lines = (err as unknown as { lines?: number }).lines ?? 0
      throw new CsvParseError(err.code, err.message, lines, row + 1)
    }
    throw e
  }
}

/** Collects up to MAX_REJECT_DETAILS problems and counts the rest. */
export class ProblemList {
  items: ParseProblem[] = []
  count = 0
  add(p: ParseProblem) {
    this.count++
    if (this.items.length < MAX_REJECT_DETAILS) this.items.push(p)
  }
}
