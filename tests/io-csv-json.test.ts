import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CsvParseError, CsvWriter, ProblemList, readCsvRows } from '../src/server/io/csv'
import type { CsvReadOptions } from '../src/server/io/csv'
import { JsonExportWriter, JsonNumber, JsonParseError, readJsonArray } from '../src/server/io/json'
import type { JsonReadValue } from '../src/server/io/json'
import type { ColumnInfo, IoCell } from '../src/server/io/types'
import { csvCellText } from '../src/server/io/values'

const ropts: CsvReadOptions = { separator: ',', enclosure: '"', escape: '"', lineEnding: 'auto', nullText: '', header: false, skipRows: 0 }

async function* chunks(s: string, size = 7): AsyncGenerator<string> {
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size)
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}
const rows = (s: string, o: Partial<CsvReadOptions> = {}, size?: number) => collect(readCsvRows(chunks(s, size), { ...ropts, ...o }))

describe('CsvWriter', () => {
  const w = (o: Partial<ConstructorParameters<typeof CsvWriter>[0]> = {}) =>
    new CsvWriter({ separator: ',', enclosure: '"', escape: '"', lineEnding: 'lf', nullText: '', ...o })
  it('encloses only when needed', () => {
    expect(w().line(['a', 'b,c', 'd"e', 'f\ng'])).toBe('a,"b,c","d""e","f\ng"\n')
  })
  it('keeps NULL apart from the empty string', () => {
    expect(w().line(['', ''], [true, false])).toBe(',""\n')
    expect(w({ nullText: 'NULL' }).line(['NULL', 'NULL'], [true, false])).toBe('NULL,"NULL"\n')
  })
  it('semicolon and CRLF (Excel preset)', () => {
    expect(w({ separator: ';', lineEnding: 'crlf' }).line(['a;b', 'c'])).toBe('"a;b";c\r\n')
  })
  it('backslash escape also escapes the escape character', () => {
    expect(w({ escape: '\\' }).line(['a"b', 'c\\d'])).toBe('"a\\"b",c\\d\n')
  })
  it('no enclosure writes raw text', () => {
    expect(w({ enclosure: '' }).line(['a,b', ''])).toBe('a,b,\n')
  })
  it('single-quote enclosure', () => {
    expect(w({ enclosure: "'", escape: '' }).line(["it's", 'x'])).toBe("'it''s',x\n")
  })
})

describe('readCsvRows', () => {
  it('parses quoted fields, embedded separators and line breaks, whatever the chunking', async () => {
    const text = 'a,b,c\n1,"x,y","line1\nline2"\n2,,"q""uote"\n'
    for (const size of [1, 2, 3, 5, 100]) {
      const out = await rows(text, { header: true }, size)
      expect(out.map((r) => r.fields)).toEqual([
        ['a', 'b', 'c'],
        ['1', 'x,y', 'line1\nline2'],
        ['2', null, 'q"uote'],
      ])
      expect(out[0]?.isHeader).toBe(true)
      expect(out[1]?.isHeader).toBe(false)
      expect(out.flatMap((r) => r.problems)).toEqual([])
    }
  })
  it('quoted empty is an empty string, unquoted empty is NULL', async () => {
    const [r] = await rows('"",\n')
    expect(r?.fields).toEqual(['', null])
  })
  it('nullText and CRLF auto-detect', async () => {
    const out = await rows('NULL,"NULL",x\r\n1,2,3\r\n', { nullText: 'NULL' })
    expect(out.map((r) => r.fields)).toEqual([[null, 'NULL', 'x'], ['1', '2', '3']])
  })
  it('skipRows and header positions', async () => {
    const out = await rows('junk\nid,name\n1,a\n', { skipRows: 1, header: true })
    expect(out.map((r) => [r.row, r.isHeader])).toEqual([[2, true], [3, false]])
  })
  it('reports a wrong field count per row', async () => {
    const out = await rows('a,b,c\n1,2\n3,4,5,6\n7,8,9\n')
    expect(out.map((r) => r.problems.map((p) => p.code))).toEqual([[], ['field_count'], ['field_count'], []])
    expect(out[1]?.problems[0]).toMatchObject({ row: 2 })
  })
  it('reports over-long values per column', async () => {
    const out = await rows('ab,abcdef\n', { columnLimits: [5, 5] })
    expect(out[0]?.problems).toEqual([{ row: 1, column: '2', code: 'value_too_long', message: 'Value of 6 characters exceeds 5' }])
  })
  it('reports header problems', async () => {
    const out = await rows('id,,id,' + 'n'.repeat(70) + '\n1,2,3,4\n', { header: true })
    const codes = out[0]?.problems.map((p) => p.code).sort()
    expect(codes).toEqual(['duplicate_name', 'empty_name', 'name_too_long'])
  })
  it('flags a delimiter that merged the columns', async () => {
    const out = await rows('id;name;city\n1;a;b\n', { header: true })
    expect(out[0]?.problems.map((p) => p.code)).toContain('delimiter_merged')
  })
  it('semicolon, tab and no enclosure', async () => {
    expect((await rows('a;b\tc;"d"\n', { separator: ';' }))[0]?.fields).toEqual(['a', 'b\tc', 'd'])
    expect((await rows('a\t"b"\n', { separator: '\t', enclosure: '' }))[0]?.fields).toEqual(['a', '"b"'])
  })
  it('backslash escape', async () => {
    expect((await rows('"a\\"b",c\n', { escape: '\\' }))[0]?.fields).toEqual(['a"b', 'c'])
  })
  it('an unterminated quote is a fatal error with a position', async () => {
    await expect(rows('a,b\n"open,1\n')).rejects.toBeInstanceOf(CsvParseError)
  })
  it('hostile cell content changes nothing', async () => {
    const out = await rows("1,\"'; DROP TABLE t; --\"\n")
    expect(out[0]?.fields).toEqual(['1', "'; DROP TABLE t; --"])
  })
  it('streams: pulls records before the source ends', async () => {
    let pulled = 0
    async function* src() {
      for (let i = 0; i < 1000; i++) {
        pulled++
        yield `${i},x\n`.repeat(100)
      }
    }
    const it = readCsvRows(src(), ropts)
    await it.next()
    // the source has 1000 chunks; read-ahead is bounded by stream buffers whose depth varies with scheduling
    expect(pulled).toBeLessThan(500)
    await it.return(undefined)
  })
  it('reports a destroyed source as an error', async () => {
    async function* bad() {
      yield 'a,b\n'
      throw new Error('boom')
    }
    await expect(collect(readCsvRows(bad(), ropts))).rejects.toThrow('boom')
  })
})

describe('csv round trip with the value formatter', () => {
  const col: ColumnInfo = { name: 'c', kind: 'text' }
  const values = ['plain', 'a,b', 'with "quotes"', 'multi\nline', 'tab\there', '', 'NULL', '  spaced  ', 'back\\slash', 'a;b|c:d', "it's", '=1+1', 'ü世', 'x\\"y']
  for (const opts of [
    { separator: ',', enclosure: '"', escape: '"', lineEnding: 'lf' },
    { separator: ';', enclosure: '"', escape: '"', lineEnding: 'crlf' },
    { separator: '\t', enclosure: '"', escape: '\\', lineEnding: 'lf' },
    { separator: '|', enclosure: "'", escape: '', lineEnding: 'lf' },
    { separator: ':', enclosure: "'", escape: '\\', lineEnding: 'crlf' },
  ] as const) {
    for (const nullText of ['', 'NULL']) {
      it(`${JSON.stringify(opts)} null=${JSON.stringify(nullText)}`, async () => {
        const cw = new CsvWriter({ ...opts, nullText })
        const cells: (string | null)[] = [...values, null]
        let text = ''
        for (let i = 0; i < cells.length; i += 3) {
          const slice = cells.slice(i, i + 3)
          text += cw.line(
            slice.map((v) => csvCellText(v, col, { nullText, neutraliseFormulas: false })),
            slice.map((v) => v === null),
          )
        }
        const out = await collect(readCsvRows(chunks(text, 5), { ...ropts, ...opts, nullText, lineEnding: opts.lineEnding }))
        expect(out.flatMap((r) => r.fields)).toEqual(cells)
        expect(out.flatMap((r) => r.problems)).toEqual([])
      })
    }
  }
})

describe('ProblemList', () => {
  it('keeps 100 details and counts all', () => {
    const l = new ProblemList()
    for (let i = 0; i < 250; i++) l.add({ row: i, code: 'x', message: 'm' })
    expect(l.items).toHaveLength(100)
    expect(l.count).toBe(250)
  })
})

// ---- JSON ---------------------------------------------------------------------------------------------------

const cols: ColumnInfo[] = [
  { name: 'id', kind: 'int' },
  { name: 'price', kind: 'decimal' },
  { name: 'name', kind: 'varchar' },
  { name: 'data', kind: 'blob' },
  { name: 'note', kind: 'text' },
]
const colDefs = cols.map((c) => ({ name: c.name, type: c.kind }))

function dump(opts: { pretty: boolean; unicode: boolean }, batches: IoCell[][][]): string {
  const w = new JsonExportWriter(opts)
  let s = w.begin('1.2.3') + w.database('shop') + w.tableStart('shop', 'items', colDefs)
  for (const b of batches) s += w.rowsOf(cols, b)
  s += w.tableEnd()
  s += w.tableStart('shop', 'empty', [])
  s += w.tableEnd()
  return s + w.end()
}

describe('JsonExportWriter', () => {
  const data: IoCell[][] = [
    ['1', '10.50', 'Zoë 世', Buffer.from([1, 255]), null],
    ['9223372036854775807', '0.1', 'q"uote\n', Buffer.alloc(0), 'x'],
  ]
  for (const pretty of [true, false]) {
    for (const unicode of [true, false]) {
      it(`valid JSON in the DBLoom shape (pretty=${pretty}, unicode=${unicode})`, () => {
        const text = dump({ pretty, unicode }, [data.slice(0, 1), data.slice(1), []])
        const v = JSON.parse(text) as Record<string, unknown>[]
        expect(v[0]).toEqual({ type: 'header', generator: 'DBLoom', version: '1.2.3' })
        expect(v[1]).toEqual({ type: 'database', name: 'shop' })
        expect(v[2]).toEqual({
          type: 'table',
          database: 'shop',
          name: 'items',
          columns: colDefs,
          data: [
            { id: 1, price: '10.50', name: 'Zoë 世', data: '0x01ff', note: null },
            { id: '9223372036854775807', price: '0.1', name: 'q"uote\n', data: '0x', note: 'x' },
          ],
        })
        expect(v[3]).toMatchObject({ name: 'empty', columns: [], data: [] })
        expect(text.includes('\n')).toBe(pretty)
        if (!unicode) expect(text).toMatch(/^[\x00-\x7e\n]*$/)
        else expect(text).toContain('世')
      })
    }
  }
  it('BIGINT keeps every digit', () => {
    const text = dump({ pretty: false, unicode: true }, [[['18446744073709551615', '1', 'a', null, null]]])
    expect(text).toContain('"id":"18446744073709551615"')
  })
  it('streams 10 000 rows', () => {
    const w = new JsonExportWriter({ pretty: true, unicode: true })
    let s = w.begin('x') + w.tableStart('d', 't', colDefs)
    for (let i = 0; i < 100; i++) {
      const batch: IoCell[][] = Array.from({ length: 100 }, (_, j) => [String(i * 100 + j), '1.5', `n${j}`, Buffer.from([j]), null])
      s += w.rowsOf(cols, batch)
    }
    s += w.tableEnd() + w.end()
    const v = JSON.parse(s) as { data?: { id: number }[] }[]
    expect(v[1]?.data).toHaveLength(10_000)
    expect(v[1]?.data?.[9999]?.id).toBe(9999)
  })
  it('keys that look like prototype pollution are plain keys', () => {
    const w = new JsonExportWriter({ pretty: false, unicode: true })
    const c: ColumnInfo[] = [{ name: '__proto__', kind: 'text' }]
    const s = w.begin('x') + w.tableStart('d', 't', []) + w.rowsOf(c, [['a']]) + w.tableEnd() + w.end()
    const row = (JSON.parse(s) as { data: object[] }[])[1]?.data[0]
    expect(Object.keys(row ?? {})).toEqual(['__proto__'])
  })
  it('refuses end() inside a table', () => {
    const w = new JsonExportWriter({ pretty: true, unicode: true })
    w.begin('x')
    w.tableStart('d', 't', [])
    expect(() => w.end()).toThrow()
  })
})

describe('readJsonArray', () => {
  const plain = (v: JsonReadValue): unknown => {
    if (v instanceof JsonNumber) return { num: v.text }
    if (Array.isArray(v)) return v.map(plain)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
    return v
  }
  const read = async (s: string, size = 5) => (await collect(readJsonArray(chunks(s, size)))).map(plain)

  it('yields elements with exact numbers', async () => {
    const out = await read('[{"id":12345678901234567890,"p":1.10,"n":null,"t":true,"s":"x\\u00e9"},[1,2.50,"a"],"s",7]')
    expect(out).toEqual([
      { id: { num: '12345678901234567890' }, p: { num: '1.10' }, n: null, t: true, s: 'xé' },
      [{ num: '1' }, { num: '2.50' }, 'a'],
      's',
      { num: '7' },
    ])
  })
  it('nested containers and empty values', async () => {
    expect(await read('[{"a":{"b":[{"c":[]},{}]}},[],{}]', 1)).toEqual([{ a: { b: [{ c: [] }, {}] } }, [], {}])
  })
  it('empty array', async () => expect(await read('[]')).toEqual([]))
  it('a __proto__ key stays a data key', async () => {
    const [v] = await collect(readJsonArray(chunks('[{"__proto__":{"x":1}}]')))
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype)
    expect(Object.keys(v as object)).toEqual(['__proto__'])
  })
  it('round-trips the writer output', async () => {
    const text = dump({ pretty: true, unicode: true }, [[['1', '2.5', 'a', null, null]]])
    const out = (await collect(readJsonArray(chunks(text, 11)))) as { type: string }[]
    expect(out.map((o) => o.type)).toEqual(['header', 'database', 'table', 'table'])
  })
  it('rejects a non-array top level, bad JSON and truncation', async () => {
    await expect(read('{"a":1}')).rejects.toBeInstanceOf(JsonParseError)
    await expect(read('5')).rejects.toBeInstanceOf(JsonParseError)
    await expect(read('[1,2')).rejects.toBeInstanceOf(JsonParseError)
    await expect(read('[1,}')).rejects.toBeInstanceOf(JsonParseError)
    await expect(read('[1] [2]')).rejects.toBeInstanceOf(JsonParseError)
  })
  it('refuses absurd nesting', async () => {
    await expect(read('[' + '['.repeat(200) + ']'.repeat(200) + ']', 50)).rejects.toBeInstanceOf(JsonParseError)
  })
  it('streams: yields before the source ends', async () => {
    let pulled = 0
    async function* src() {
      yield '['
      for (let i = 0; i < 1000; i++) {
        pulled++
        yield `{"i":${i}},`.repeat(50)
      }
      yield '{}]'
    }
    const it = readJsonArray(src())
    await it.next()
    expect(pulled).toBeLessThan(50)
    await it.return(undefined)
  })
  it('works from a Node Readable', async () => {
    const out = await collect(readJsonArray(Readable.from([Buffer.from('[1,'), Buffer.from('2]')])))
    expect(out.map(plain)).toEqual([{ num: '1' }, { num: '2' }])
  })
})
