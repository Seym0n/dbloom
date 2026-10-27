/**
 * JSON for module `io` (FR-IO-007, FR-IO-018). Writer: own streaming writer for the DBLoom export shape (one
 * top-level array: header object, database objects, table objects with rows as objects), never a
 * `JSON.stringify` of a whole table. Reader: `stream-json` tokens assembled into top-level array items with
 * numbers kept as exact text.
 */
import { Readable } from 'node:stream'
import { parser } from 'stream-json'
import type { ColumnInfo, IoCell } from './types'
import { jsonValue } from './values'
import type { JsonScalar } from './values'

// ---- Writer -------------------------------------------------------------------------------------------------

export type JsonWriterOptions = { pretty: boolean; unicode: boolean }

/** Streaming writer; every method returns the text to append. Call in order: begin, [database, [tableStart, rows*, tableEnd]*]*, end. */
export class JsonExportWriter {
  private items = 0
  private rows = 0
  private inTable = false

  constructor(private o: JsonWriterOptions) {}

  private str(s: string): string {
    const j = JSON.stringify(s)
    return this.o.unicode ? j : j.replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  }

  private scalar(v: JsonScalar): string {
    return typeof v === 'string' ? this.str(v) : v === null ? 'null' : String(v)
  }

  private nl(level: number): string {
    return this.o.pretty ? '\n' + '  '.repeat(level) : ''
  }

  private object(pairs: [string, string][], level: number): string {
    if (pairs.length === 0) return '{}'
    const sp = this.o.pretty ? ' ' : ''
    return '{' + pairs.map(([k, v]) => this.nl(level + 1) + this.str(k) + ':' + sp + v).join(',') + this.nl(level) + '}'
  }

  private item(text: string): string {
    const out = (this.items === 0 ? '' : ',') + this.nl(1) + text
    this.items++
    return out
  }

  begin(version: string): string {
    return '[' + this.item(this.object([['type', '"header"'], ['generator', '"DBLoom"'], ['version', this.str(version)]], 1))
  }

  database(name: string): string {
    return this.item(this.object([['type', '"database"'], ['name', this.str(name)]], 1))
  }

  /** `{"type":"skipped"}` element for an object left out on request (FR-IO-010); not allowed inside a table. */
  skipped(object: string, message: string): string {
    if (this.inTable) throw new Error('JSON table left open')
    return this.item(this.object([['type', '"skipped"'], ['object', this.str(object)], ['message', this.str(message)]], 1))
  }

  tableStart(database: string, name: string, columns: { name: string; type: string }[]): string {
    this.inTable = true
    this.rows = 0
    const sp = this.o.pretty ? ' ' : ''
    const cols =
      columns.length === 0
        ? '[]'
        : '[' +
          columns
            .map((c, i) => (i ? ',' : '') + this.nl(3) + this.object([['name', this.str(c.name)], ['type', this.str(c.type)]], 3))
            .join('') +
          this.nl(2) +
          ']'
    const head = [
      ['type', '"table"'],
      ['database', this.str(database)],
      ['name', this.str(name)],
      ['columns', cols],
    ] as [string, string][]
    // open the object by hand: "data" stays open until tableEnd
    const body = head.map(([k, v]) => this.nl(2) + this.str(k) + ':' + sp + v).join(',')
    return this.item('{' + body + ',' + this.nl(2) + '"data":' + sp + '[')
  }

  /** Rows of the open table; `columns` are the column infos in cell order. */
  rowsOf(columns: ColumnInfo[], rows: IoCell[][]): string {
    let out = ''
    for (const r of rows) {
      const pairs: [string, string][] = columns.map((c, i) => [c.name, this.scalar(jsonValue(r[i] ?? null, c))])
      out += (this.rows === 0 ? '' : ',') + this.nl(3) + this.object(pairs, 3)
      this.rows++
    }
    return out
  }

  tableEnd(): string {
    this.inTable = false
    return (this.rows === 0 ? '' : this.nl(2)) + ']' + this.nl(1) + '}'
  }

  end(): string {
    if (this.inTable) throw new Error('JSON table left open')
    return this.nl(0) + ']' + (this.o.pretty ? '\n' : '')
  }
}

// ---- Reader -------------------------------------------------------------------------------------------------

/** A JSON number as the exact text of the file. */
export class JsonNumber {
  constructor(readonly text: string) {}
}

export type JsonReadValue = string | boolean | null | JsonNumber | JsonReadValue[] | { [k: string]: JsonReadValue }

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonParseError'
  }
}

type Token = { name: string; value?: string }

const MAX_DEPTH = 64

type Container = JsonReadValue[] | { [k: string]: JsonReadValue }

/**
 * Yields the elements of the top-level array one by one (anything else at the top is an error).
 * Numbers arrive as `JsonNumber` so BIGINT and DECIMAL keep their digits.
 */
export async function* readJsonArray(source: AsyncIterable<string | Uint8Array>): AsyncGenerator<JsonReadValue> {
  const tokens = parser.asStream({ packValues: true, streamValues: false })
  const feeding = Readable.from(source, { objectMode: false }).on('error', (e) => tokens.destroy(e))
  feeding.pipe(tokens)
  // stack[0] stands for the top-level array: its elements are yielded, not kept
  const stack: Container[] = []
  let key = ''
  let closed = false
  const put = (v: JsonReadValue) => {
    const top = stack[stack.length - 1] as Container
    if (Array.isArray(top)) top.push(v)
    else Object.defineProperty(top, key, { value: v, enumerable: true, writable: true, configurable: true })
  }
  try {
    for await (const t of tokens as AsyncIterable<Token>) {
      if (closed) throw new JsonParseError('Unexpected data after the top-level array')
      if (stack.length === 0) {
        if (t.name !== 'startArray') throw new JsonParseError('The top-level JSON value must be an array')
        stack.push([])
        continue
      }
      switch (t.name) {
        case 'keyValue':
          key = t.value as string
          break
        case 'startArray':
        case 'startObject': {
          if (stack.length > MAX_DEPTH) throw new JsonParseError('JSON is nested too deeply')
          const fresh: Container = t.name === 'startArray' ? [] : {}
          if (stack.length > 1) put(fresh as JsonReadValue)
          stack.push(fresh)
          break
        }
        case 'endArray':
        case 'endObject': {
          const finished = stack.pop() as Container
          if (stack.length === 0) closed = true
          else if (stack.length === 1) yield finished as JsonReadValue
          break
        }
        default: {
          let v: JsonReadValue
          if (t.name === 'stringValue') v = t.value as string
          else if (t.name === 'numberValue') v = new JsonNumber(t.value as string)
          else if (t.name === 'trueValue') v = true
          else if (t.name === 'falseValue') v = false
          else if (t.name === 'nullValue') v = null
          else break
          if (stack.length === 1) yield v
          else put(v)
        }
      }
    }
  } catch (e) {
    if (e instanceof JsonParseError) throw e
    throw new JsonParseError(e instanceof Error ? e.message : 'Invalid JSON')
  }
  if (!closed) throw new JsonParseError('The JSON ends before the top-level array is closed')
}
