/**
 * Streaming JSON reader for row import (FR-IO-018). `json.ts` assembles each element of the top-level array
 * whole, which is fine for a plain array of rows but would hold a whole table of a DBLoom export in memory.
 * This reader walks the same `stream-json` tokens and, for a `{"type":"table", ..., "data":[...]}` element,
 * yields the rows of `data` one at a time. Numbers stay exact text (`JsonNumber`).
 */
import { Readable } from 'node:stream'
import { parser } from 'stream-json'
import { JsonNumber, JsonParseError, type JsonReadValue } from './json'

export type JsonRowEvent =
  | { kind: 'item'; value: JsonReadValue }
  | { kind: 'table'; name: string; database: string; columns: string[] }
  | { kind: 'row'; value: JsonReadValue }
  | { kind: 'tableEnd' }

type Token = { name: string; value?: string }
const MAX_DEPTH = 64

class Cursor {
  private it: AsyncIterator<Token>
  private held: Token | undefined
  private done = false
  constructor(it: AsyncIterator<Token>) {
    this.it = it
  }
  async peek(): Promise<Token | undefined> {
    if (this.held) return this.held
    if (this.done) return undefined
    const r = await this.it.next()
    if (r.done) {
      this.done = true
      return undefined
    }
    this.held = r.value
    return this.held
  }
  async next(): Promise<Token | undefined> {
    const t = await this.peek()
    this.held = undefined
    return t
  }
}

async function readValue(c: Cursor, depth = 0): Promise<JsonReadValue> {
  if (depth > MAX_DEPTH) throw new JsonParseError('JSON is nested too deeply')
  const t = await c.next()
  if (!t) throw new JsonParseError('The JSON ends unexpectedly')
  switch (t.name) {
    case 'stringValue':
      return t.value as string
    case 'numberValue':
      return new JsonNumber(t.value as string)
    case 'trueValue':
      return true
    case 'falseValue':
      return false
    case 'nullValue':
      return null
    case 'startArray': {
      const out: JsonReadValue[] = []
      for (;;) {
        const p = await c.peek()
        if (!p) throw new JsonParseError('The JSON ends unexpectedly')
        if (p.name === 'endArray') {
          await c.next()
          return out
        }
        out.push(await readValue(c, depth + 1))
      }
    }
    case 'startObject': {
      const out: { [k: string]: JsonReadValue } = {}
      for (;;) {
        const k = await c.next()
        if (!k) throw new JsonParseError('The JSON ends unexpectedly')
        if (k.name === 'endObject') return out
        if (k.name !== 'keyValue') throw new JsonParseError('Unexpected token in an object')
        Object.defineProperty(out, k.value as string, {
          value: await readValue(c, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    default:
      throw new JsonParseError(`Unexpected token ${t.name}`)
  }
}

const textOf = (v: JsonReadValue | undefined): string => (typeof v === 'string' ? v : v instanceof JsonNumber ? v.text : '')

export async function* readJsonRows(source: AsyncIterable<string | Uint8Array>): AsyncGenerator<JsonRowEvent> {
  const tokens = parser.asStream({ packValues: true, streamValues: false })
  const feeding = Readable.from(source, { objectMode: false }).on('error', (e) => tokens.destroy(e))
  feeding.pipe(tokens)
  const c = new Cursor((tokens as AsyncIterable<Token>)[Symbol.asyncIterator]())
  try {
    const first = await c.next()
    if (!first || first.name !== 'startArray') throw new JsonParseError('The top-level JSON value must be an array')
    for (;;) {
      const p = await c.peek()
      if (!p) throw new JsonParseError('The JSON ends before the top-level array is closed')
      if (p.name === 'endArray') {
        await c.next()
        break
      }
      if (p.name !== 'startObject') {
        yield { kind: 'item', value: await readValue(c) }
        continue
      }
      // An object: collect scalar members; a `data` array of a table element is streamed.
      await c.next()
      const props: { [k: string]: JsonReadValue } = {}
      let streamed = false
      for (;;) {
        const k = await c.next()
        if (!k) throw new JsonParseError('The JSON ends unexpectedly')
        if (k.name === 'endObject') break
        if (k.name !== 'keyValue') throw new JsonParseError('Unexpected token in an object')
        const key = k.value as string
        const nextTok = await c.peek()
        if (key === 'data' && props.type === 'table' && nextTok?.name === 'startArray') {
          streamed = true
          const cols = Array.isArray(props.columns)
            ? props.columns.map((x) => (x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof JsonNumber) ? textOf((x as { [k: string]: JsonReadValue }).name) : ''))
            : []
          yield { kind: 'table', name: textOf(props.name), database: textOf(props.database), columns: cols }
          await c.next()
          for (;;) {
            const q = await c.peek()
            if (!q) throw new JsonParseError('The JSON ends unexpectedly')
            if (q.name === 'endArray') {
              await c.next()
              break
            }
            yield { kind: 'row', value: await readValue(c) }
          }
          yield { kind: 'tableEnd' }
          continue
        }
        Object.defineProperty(props, key, {
          value: await readValue(c),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      if (!streamed) yield { kind: 'item', value: props }
    }
    const extra = await c.peek()
    if (extra) throw new JsonParseError('Unexpected data after the top-level array')
  } catch (e) {
    if (e instanceof JsonParseError) throw e
    throw new JsonParseError(e instanceof Error ? e.message : 'Invalid JSON')
  }
}
