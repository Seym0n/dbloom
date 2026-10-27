import { describe, expect, it } from 'vitest'
import {
  TypeInference,
  convertCell,
  jsonCellText,
  readRawRows,
  resolveMapping,
  scanRowFile,
  type RawEvent,
  type RowSourceOptions,
} from '../src/server/io/import-rows'
import { ChunkDecoder } from '../src/server/io/charset'
import { JsonNumber } from '../src/server/io/json'
import { rowImportOptions } from '../src/server/io/types'
import type { DecodedText } from '../src/server/io/import-source'
import { col } from './rows-a-helpers'
import type { RowTable } from '../src/server/rows/types'

const opts = (o: Partial<RowSourceOptions> = {}): RowSourceOptions => rowImportOptions.parse(o)

function decoded(text: string, chunk = 7): DecodedText {
  // chunks are cut on character boundaries by feeding code points
  const chars = [...text]
  async function* byChars() {
    for (let i = 0; i < chars.length; i += chunk) yield chars.slice(i, i + chunk).join('')
  }
  return { compression: 'none', decoder: new ChunkDecoder(), text: byChars(), counter: { bytes: 0 } }
}

async function all(text: string, format: 'csv' | 'json', o: Partial<RowSourceOptions> = {}) {
  const out: RawEvent[] = []
  for await (const ev of readRawRows(decoded(text), format, opts(o))) out.push(ev)
  return out
}

describe('TypeInference', () => {
  const infer = (...v: (string | null)[]) => {
    const t = new TypeInference()
    v.forEach((x) => t.add(x))
    return t.result()
  }
  it('chooses integer widths', () => {
    expect(infer('1', '-5', '300')).toBe('INT')
    expect(infer('1', '4294967296')).toBe('BIGINT')
    expect(infer('1', '18446744073709551615')).toBe('BIGINT UNSIGNED')
    expect(infer('123456789012345678901234567890')).toBe('DECIMAL(30,0)')
  })
  it('chooses decimals, dates and times', () => {
    expect(infer('1.5', '12.25', '100')).toBe('DECIMAL(5,2)')
    expect(infer('2024-01-31', '2024-12-01')).toBe('DATE')
    expect(infer('2024-01-31 10:00:00', '2024-01-31T10:00:00.123')).toBe('DATETIME(3)')
    expect(infer('10:00:00', '-3:15:00')).toBe('TIME')
  })
  it('keeps the unclear as text and sizes it', () => {
    expect(infer('007', '1')).toMatch(/^VARCHAR/)
    expect(infer('abc', '1')).toBe('VARCHAR(16)')
    expect(infer('x'.repeat(40))).toBe('VARCHAR(64)')
    expect(infer('x'.repeat(400))).toBe('TEXT')
    expect(infer('x'.repeat(70_000))).toBe('LONGTEXT')
    expect(infer('2024-13-40')).toMatch(/^VARCHAR/)
    expect(infer(null, '')).toBe('VARCHAR(16)')
    expect(infer('1', '2024-01-01')).toMatch(/^VARCHAR/)
  })
})

describe('convertCell', () => {
  it('passes exact numbers and checks ranges', () => {
    expect(convertCell(col('n', 'int', { baseType: 'bigint' }), '12345678901234567', false).params).toEqual(['12345678901234567'])
    expect(() => convertCell(col('n', 'int', { baseType: 'tinyint' }), '300', false)).toThrow(/out of range/)
    expect(() => convertCell(col('n', 'int'), 'abc', false)).toThrow(/not an integer/)
  })
  it('leaves extra decimal places to the server (rounded with a note)', () => {
    const c = col('d', 'decimal', { precision: 5, scale: 2 })
    expect(convertCell(c, '1.239', false).params).toEqual(['1.239'])
  })
  it('reads hex for binary and bit', () => {
    expect((convertCell(col('b', 'blob'), '0x4142', false).params[0] as Buffer).toString()).toBe('AB')
    expect(() => convertCell(col('b', 'blob'), 'AB', false)).toThrow()
    expect((convertCell(col('x', 'bit', { length: 8 }), "b'101'", false).params[0] as Buffer)[0]).toBe(5)
  })
  it('reverses the formula prefix only for text columns', () => {
    const t = col('t', 'text')
    expect(convertCell(t, "'=SUM(A1)", true).params).toEqual(['=SUM(A1)'])
    expect(convertCell(t, "'+1", true).params).toEqual(['+1'])
    expect(convertCell(t, "'=x", false).params).toEqual(["'=x"])
    expect(convertCell(t, "'normal", true).params).toEqual(["'normal"])
  })
  it('takes geometry as hex or text and refuses NULL in a NOT NULL column', () => {
    const g = col('g', 'geometry', { srid: 4326 })
    expect(convertCell(g, '0x00000000010100000000000000000000000000000000000000', false).frag).toBe('?')
    expect(convertCell(g, 'POINT(1 2)', false)).toEqual({ frag: 'ST_GeomFromText(?, ?)', params: ['POINT(1 2)', '4326'] })
    expect(() => convertCell(col('n', 'int'), null, false)).toThrow(/cannot be empty/)
    expect(convertCell(col('n', 'int', { nullable: true }), null, false).params).toEqual([null])
  })
  it('keeps hostile text as a parameter', () => {
    const t = col('t', 'text')
    expect(convertCell(t, "'); DROP TABLE customer; --", true).params).toEqual(["'); DROP TABLE customer; --"])
  })
})

describe('readRawRows', () => {
  it('reads CSV with header, quotes and line breaks', async () => {
    const ev = await all('id;name\n1;"a\nb"\n2;x\n', 'csv', { separator: ';', header: true })
    expect(ev[0]).toMatchObject({ kind: 'header', names: ['id', 'name'] })
    expect(ev.filter((e) => e.kind === 'row').map((e) => (e as { raw: { cells: unknown } }).raw.cells)).toEqual([
      ['1', 'a\nb'],
      ['2', 'x'],
    ])
  })
  it('reports a row with too many fields and a merged delimiter', async () => {
    const ev = await all('a,b\n1,2\n1,2,3\n', 'csv', { header: true })
    const bad = ev.find((e) => e.kind === 'row' && e.raw.problems.length > 0)
    expect(bad).toMatchObject({ raw: { row: 3, problems: [{ code: 'field_count' }] } })
    const merged = await all('a;b;c\n1;2;3\n', 'csv', { header: true })
    expect(merged[0]).toMatchObject({ problems: [{ code: 'delimiter_merged' }] })
  })
  it('reads JSON objects, arrays and keeps exact numbers', async () => {
    const ev = await all('[{"id": 12345678901234567890, "a": null, "ok": true, "o": {"x": 1.50}}]', 'json')
    expect((ev[0] as { raw: { cells: Record<string, unknown> } }).raw.cells).toEqual({
      id: '12345678901234567890',
      a: null,
      ok: '1',
      o: '{"x":1.50}',
    })
    const arr = await all('[[1,"a"],[2,"b"]]', 'json')
    expect(arr).toHaveLength(2)
    const bad = await all('[1]', 'json')
    expect(bad[0]).toMatchObject({ raw: { problems: [{ code: 'row_not_object' }] } })
  })
  it('reads the DBLoom export shape: the chosen table only', async () => {
    const doc = JSON.stringify([
      { type: 'header', generator: 'DBLoom', version: '1' },
      { type: 'database', name: 'd' },
      { type: 'table', database: 'd', name: 'a', columns: [{ name: 'id', type: 'int' }], data: [{ id: 1 }, { id: 2 }] },
      { type: 'table', database: 'd', name: 'b', columns: [{ name: 'x', type: 'int' }], data: [{ x: 9 }] },
    ])
    const first = await all(doc, 'json')
    expect(first.filter((e) => e.kind === 'row')).toHaveLength(2)
    const second = await all(doc, 'json', { jsonTable: 'b' })
    expect(second.filter((e) => e.kind === 'row').map((e) => (e as { raw: { cells: unknown } }).raw.cells)).toEqual([{ x: '9' }])
    const scan = await scanRowFile(decoded(doc), 'json', opts())
    expect(scan.jsonTables).toEqual(['a', 'b'])
    expect(scan.columns).toEqual(['id'])
    expect(scan.rowCount).toBe(2)
    expect(scan.inferred).toEqual(['INT'])
  })
  it('refuses a JSON file that is not an array', async () => {
    await expect(all('{"a":1}', 'json')).rejects.toMatchObject({ error: { code: 'row_rejected' } })
  })
})

describe('jsonCellText', () => {
  it('writes booleans, null and nested values', () => {
    expect(jsonCellText(true)).toBe('1')
    expect(jsonCellText(null)).toBeNull()
    expect(jsonCellText([new JsonNumber('1.0'), 'a'])).toBe('[1.0,"a"]')
  })
})

describe('scanRowFile', () => {
  it('gives columns, sample, count and inferred types of a CSV', async () => {
    const csv = ['id,price,when,note', '1,1.50,2024-01-01,hello', '2,20.25,2024-01-02,'].join('\n')
    const s = await scanRowFile(decoded(csv), 'csv', opts({ header: true }))
    expect(s.columns).toEqual(['id', 'price', 'when', 'note'])
    expect(s.rowCount).toBe(2)
    expect(s.sample[0]).toEqual(['1', '1.50', '2024-01-01', 'hello'])
    expect(s.inferred).toEqual(['INT', 'DECIMAL(4,2)', 'DATE', 'VARCHAR(16)'])
  })
  it('names columns by position without a header', async () => {
    const s = await scanRowFile(decoded('1,a\n2,b\n'), 'csv', opts())
    expect(s.columns).toEqual(['col_1', 'col_2'])
    expect(s.rowCount).toBe(2)
  })
})

describe('resolveMapping', () => {
  const table = {
    db: 'd',
    table: 't',
    kind: 'table',
    transactional: true,
    columns: [col('id', 'int'), col('Name', 'char'), col('g', 'int', { generated: 'virtual' })],
    uniqueKeys: [],
    outgoing: [],
    incoming: [],
    estimatedRows: null,
  } as unknown as RowTable
  it('matches header names case-insensitively and skips unknown columns', () => {
    const p = resolveMapping(['ID', 'name', 'zzz'], true, undefined, table)
    expect(p.map((x) => [x.index, x.col.name])).toEqual([
      [0, 'id'],
      [1, 'Name'],
    ])
  })
  it('maps by position without names and never to a generated column', () => {
    const p = resolveMapping(['col_1', 'col_2', 'col_3'], false, undefined, table)
    expect(p.map((x) => x.col.name)).toEqual(['id', 'Name'])
  })
  it('uses the mapping of the user and refuses wrong ones', () => {
    const p = resolveMapping(['a', 'b'], true, [{ source: 'b', target: 'id' }, { source: 'a', target: null }], table)
    expect(p).toMatchObject([{ index: 1, col: { name: 'id' } }])
    expect(() => resolveMapping(['a'], true, [{ source: 'a', target: 'nope' }], table)).toThrow(/no column/)
    expect(() => resolveMapping(['a'], true, [{ source: 'a', target: 'g' }], table)).toThrow(/cannot be written/)
    expect(() => resolveMapping(['a', 'b'], true, [{ source: 'a', target: 'id' }, { source: 'b', target: 'id' }], table)).toThrow(/twice/)
    expect(() => resolveMapping(['a'], true, [{ source: 'x', target: 'id' }], table)).toThrow(/does not exist/)
    expect(() => resolveMapping(['a'], true, [], table)).toThrow(/No file column/)
  })
})
