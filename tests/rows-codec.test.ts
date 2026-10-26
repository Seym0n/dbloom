import { describe, expect, it } from 'vitest'
import {
  bitBuffer,
  cellReadProjection,
  encodeWire,
  guardCondition,
  parseText,
  projectionFor,
  RowValueError,
  usesDigest,
} from '../src/server/rows/codecs'
import { BuildRefusal } from '../src/server/structure/types'
import { col } from './rows-a-helpers'

const read = { cellBytes: 10 }
const fails = (fn: () => unknown, code?: string) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BuildRefusal)
    if (code) expect((e as RowValueError).code).toBe(code)
    return
  }
  throw new Error('expected a refusal')
}

describe('parseText: integers', () => {
  const i = col('n', 'int', { baseType: 'int' })
  it('keeps big values exact as decimal strings', () => {
    const big = col('n', 'int', { baseType: 'bigint' })
    expect(parseText(big, '9223372036854775807', 'write')).toBe('9223372036854775807')
    expect(parseText(big, '-9223372036854775808', 'write')).toBe('-9223372036854775808')
    const ubig = col('n', 'int', { baseType: 'bigint', unsigned: true })
    expect(parseText(ubig, '18446744073709551615', 'write')).toBe('18446744073709551615')
    fails(() => parseText(ubig, '18446744073709551616', 'write'), 'invalid-value')
    fails(() => parseText(ubig, '-1', 'write'))
  })
  it('converts hexadecimal literals to their decimal value (DATA-ISS-108)', () => {
    expect(parseText(i, '0x10', 'write')).toBe('16')
    expect(parseText(i, "X'ff'", 'write')).toBe('255')
    expect(parseText(i, '+7', 'write')).toBe('7')
  })
  it('checks the range of narrow types and refuses non-integers', () => {
    const t = col('n', 'int', { baseType: 'tinyint' })
    expect(parseText(t, '127', 'write')).toBe('127')
    fails(() => parseText(t, '128', 'write'))
    expect(
      parseText(col('n', 'int', { baseType: 'tinyint', unsigned: true }), '255', 'write'),
    ).toBe('255')
    for (const v of ['', '1.5', '1e3', 'abc', ' 1', '0xZZ', '1;DROP'])
      fails(() => parseText(i, v, 'write'))
  })
})

describe('parseText: decimal, float, bit, year', () => {
  const d = col('d', 'decimal', { precision: 30, scale: 10 })
  it('validates against precision and scale and never rounds', () => {
    expect(parseText(d, '12345678901234567890.0123456789', 'write')).toBe(
      '12345678901234567890.0123456789',
    )
    expect(parseText(d, '-0.5', 'write')).toBe('-0.5')
    expect(parseText(d, '.5', 'write')).toBe('0.5')
    expect(parseText(d, '1.50000000000', 'write')).toBe('1.5000000000')
    fails(() => parseText(d, '1.00000000001', 'write'))
    fails(() => parseText(d, '123456789012345678901.5', 'write'))
    fails(() => parseText(d, '1e5', 'write'))
    fails(() => parseText(d, '.', 'write'))
    fails(() =>
      parseText(col('d', 'decimal', { precision: 5, scale: 2, unsigned: true }), '-1', 'write'),
    )
  })
  it('accepts float text and refuses non-numbers', () => {
    const f = col('f', 'float', { baseType: 'double' })
    expect(parseText(f, '0.1', 'write')).toBe('0.1')
    expect(parseText(f, '-1.5e10', 'write')).toBe('-1.5e10')
    expect(parseText(f, '+2', 'write')).toBe('2')
    for (const v of ['NaN', 'Infinity', '1e999', '0x10', '']) fails(() => parseText(f, v, 'write'))
    fails(() => parseText(col('f', 'float', { baseType: 'float' }), '1e39', 'write'))
  })
  it('BIT is a big-endian Buffer for writes and a decimal string for comparisons', () => {
    const b = col('b', 'bit', { length: 12 })
    expect(parseText(b, "b'000000000101'", 'write')).toEqual(Buffer.from([0x00, 0x05]))
    expect(parseText(b, '0b111111111111', 'write')).toEqual(Buffer.from([0x0f, 0xff]))
    expect(parseText(b, '0x1', 'guard')).toBe('1')
    fails(() => parseText(b, "b'1000000000000'", 'write'))
    const b64 = col('b', 'bit', { length: 64 })
    expect(parseText(b64, '0xFFFFFFFFFFFFFFFF', 'write')).toEqual(Buffer.alloc(8, 0xff))
    expect(parseText(b64, '18446744073709551615', 'guard')).toBe('18446744073709551615')
    expect(bitBuffer(5n, 12)).toEqual(Buffer.from([0, 5]))
  })
  it('year keeps leading zeros', () => {
    const y = col('y', 'year')
    expect(parseText(y, '0099', 'write')).toBe('0099')
    fails(() => parseText(y, '20245', 'write'))
  })
})

describe('parseText: temporal, text, enum, set', () => {
  it('checks the syntax of dates and keeps fractions', () => {
    expect(parseText(col('t', 'datetime'), '2024-03-05 12:34:56.123456', 'write')).toBe(
      '2024-03-05 12:34:56.123456',
    )
    expect(parseText(col('t', 'datetime'), '0099-01-01', 'write')).toBe('0099-01-01')
    expect(parseText(col('t', 'date'), '0000-00-00', 'write')).toBe('0000-00-00')
    expect(parseText(col('t', 'time'), '-838:59:59', 'write')).toBe('-838:59:59')
    expect(parseText(col('t', 'time'), '01:02:03.456', 'write')).toBe('01:02:03.456')
    for (const [k, v] of [
      ['date', '2024-13-01'],
      ['date', '2024-1-1'],
      ['datetime', '2024-01-01 24:00:00'],
      ['datetime', "2024-01-01'; DROP"],
      ['time', '839:00:00'],
      ['time', '12:61:00'],
    ] as const) {
      fails(() => parseText(col('t', k), v, 'write'))
    }
  })
  it('keeps text verbatim (CR LF, spaces, emoji) and checks the declared length in characters', () => {
    const c = col('c', 'char', { length: 6 })
    expect(parseText(c, 'a\r\nb  ', 'write')).toBe('a\r\nb  ')
    expect(parseText(c, '😀😀😀😀😀😀', 'write')).toBe('😀😀😀😀😀😀')
    fails(() => parseText(c, '😀😀😀😀😀😀😀', 'write'))
    expect(parseText(c, '1234567', 'guard')).toBe('1234567')
    fails(() => parseText(c, 'a\ud800b', 'write'))
    fails(() => parseText(col('t', 'text', { baseType: 'tinytext' }), 'x'.repeat(256), 'write'))
  })
  it('enum needs a member, set allows the empty set', () => {
    const e = col('e', 'enum', { members: ['a', 'b c'] })
    expect(parseText(e, 'b c', 'write')).toBe('b c')
    fails(() => parseText(e, 'z', 'write'))
    expect(parseText(e, 'z', 'guard')).toBe('z')
    const s = col('s', 'set', { members: ['a', 'b'] })
    expect(parseText(s, '', 'write')).toBe('')
    expect(parseText(s, 'a,b', 'write')).toBe('a,b')
    fails(() => parseText(s, 'a,c', 'write'))
  })
  it('binary takes hex bytes, JSON must parse, UUID and INET6 are checked', () => {
    const b = col('b', 'binary', { length: 4 })
    expect(parseText(b, '0x7F000001', 'write')).toEqual(Buffer.from([0x7f, 0, 0, 1]))
    expect(parseText(b, "x'00ff'", 'write')).toEqual(Buffer.from([0, 255]))
    fails(() => parseText(b, '0x7F00000102', 'write'))
    fails(() => parseText(b, '0x123', 'write'))
    fails(() => parseText(b, 'plain', 'write'))
    expect(parseText(col('j', 'json'), '{"a": [1, 2]}', 'write')).toBe('{"a": [1, 2]}')
    fails(() => parseText(col('j', 'json'), '{"a": ', 'write'))
    expect(
      parseText(col('u', 'uuid'), '123e4567-e89b-12d3-a456-426614174000', 'write'),
    ).toBeTruthy()
    fails(() => parseText(col('u', 'uuid'), 'nope', 'write'))
    expect(parseText(col('i', 'inet6'), '::1', 'write')).toBe('::1')
    fails(() => parseText(col('i', 'inet6'), "::1'; --", 'write'))
  })
  it('an unknown type is never written', () => {
    fails(() => parseText(col('x', 'unknown'), '1', 'write'), 'not-editable')
    fails(() => encodeWire(col('x', 'unknown'), { t: 'null' }), 'not-editable')
  })
})

describe('encodeWire', () => {
  it('null, default and function templates', () => {
    expect(encodeWire(col('a', 'int'), { t: 'null' })).toEqual({ sql: '?', params: [null] })
    expect(encodeWire(col('a', 'int'), { t: 'default' })).toEqual({ sql: 'DEFAULT', params: [] })
    expect(encodeWire(col('a', 'datetime'), { t: 'fn', name: 'now' })).toEqual({
      sql: 'NOW()',
      params: [],
    })
    expect(encodeWire(col('a', 'timestamp'), { t: 'fn', name: 'currentTimestamp6' }).sql).toBe(
      'CURRENT_TIMESTAMP(6)',
    )
    expect(encodeWire(col('a', 'char'), { t: 'fn', name: 'uuid' }).sql).toBe('UUID()')
    fails(() => encodeWire(col('a', 'int'), { t: 'fn', name: 'now' }))
    fails(() => encodeWire(col('a', 'char'), { t: 'fn', name: 'unixTimestamp' }))
  })
  it('generated columns cannot be written', () => {
    fails(
      () => encodeWire(col('g', 'int', { generated: 'stored' }), { t: 'v', v: '1' }),
      'not-editable',
    )
  })
  it('geometry goes through ST_GeomFromText with the column SRID or an SRID= prefix', () => {
    const g = col('g', 'geometry', { srid: 4326 })
    expect(encodeWire(g, { t: 'v', v: 'POINT(10 20)' })).toEqual({
      sql: 'ST_GeomFromText(?, ?)',
      params: ['POINT(10 20)', '4326'],
    })
    expect(encodeWire(col('g', 'geometry'), { t: 'v', v: 'SRID=3857;POINT(1 2)' }).params).toEqual([
      'POINT(1 2)',
      '3857',
    ])
    expect(encodeWire(col('g', 'geometry'), { t: 'v', v: 'POINT(1 2)' }).params).toEqual([
      'POINT(1 2)',
      '0',
    ])
    fails(() => encodeWire(g, { t: 'v', v: '  ' }))
  })
  it('uploads are resolved by the caller and only fit binary columns', () => {
    const bytes = Buffer.from([1, 2, 3])
    const opt = { resolveUpload: (id: string) => (id === 'up-12345678' ? bytes : undefined) }
    expect(encodeWire(col('b', 'blob'), { t: 'bin', upload: 'up-12345678' }, opt)).toEqual({
      sql: '?',
      params: [bytes],
    })
    fails(
      () => encodeWire(col('b', 'blob'), { t: 'bin', upload: 'other-12345' }, opt),
      'unknown-upload',
    )
    fails(() => encodeWire(col('b', 'char'), { t: 'bin', upload: 'up-12345678' }, opt))
    fails(() =>
      encodeWire(col('b', 'binary', { length: 2 }), { t: 'bin', upload: 'up-12345678' }, opt),
    )
  })
  it('carries the column name on the error', () => {
    try {
      encodeWire(col('qty', 'int'), { t: 'v', v: 'x' })
    } catch (e) {
      expect((e as RowValueError).field).toBe('qty')
    }
  })
})

describe('guardCondition (FR-ROW-005)', () => {
  it('keys use plain equality, old values are null-safe', () => {
    const id = col('id', 'int')
    expect(guardCondition(id, { t: 'v', v: '5' }, 'key')).toEqual({
      sql: '`id` = ?',
      params: ['5'],
    })
    expect(guardCondition(id, { t: 'v', v: '5' }, 'old')).toEqual({
      sql: '`id` <=> ?',
      params: ['5'],
    })
    expect(guardCondition(id, { t: 'null' }, 'old')).toEqual({ sql: '`id` <=> ?', params: [null] })
    fails(() => guardCondition(id, { t: 'null' }, 'key'))
  })
  it('text is compared as bytes, in the column charset', () => {
    const c = col('s', 'char')
    expect(guardCondition(c, { t: 'v', v: 'a ' }, 'old').sql).toBe(
      'CAST(`s` AS BINARY) <=> CAST(? AS BINARY)',
    )
    expect(guardCondition(c, { t: 'null' }, 'old').sql).toBe(
      'CAST(`s` AS BINARY) <=> CAST(? AS BINARY)',
    )
    const latin = col('s', 'char', { charset: 'latin1' })
    expect(guardCondition(latin, { t: 'v', v: 'é' }, 'old').sql).toBe(
      'CAST(`s` AS BINARY) <=> CAST(CONVERT(? USING latin1) AS BINARY)',
    )
    fails(() =>
      guardCondition(col('s', 'char', { charset: "x'; DROP" }), { t: 'v', v: 'a' }, 'old'),
    )
  })
  it('float, JSON, geometry and large values are compared by digest only', () => {
    const digest = 'a'.repeat(64)
    for (const c of [
      col('f', 'float'),
      col('j', 'json'),
      col('g', 'geometry'),
      col('t', 'text', { baseType: 'longtext' }),
      col('b', 'blob', { baseType: 'longblob' }),
    ]) {
      expect(usesDigest(c)).toBe(true)
      expect(guardCondition(c, { t: 'digest', v: digest }, 'old').params).toEqual([digest])
      fails(() => guardCondition(c, { t: 'v', v: '1' }, 'old'))
      expect(guardCondition(c, { t: 'null' }, 'old').params).toEqual([null])
    }
    expect(guardCondition(col('g', 'geometry'), { t: 'digest', v: digest }, 'old').sql).toBe(
      'SHA2(ST_AsBinary(`g`), 256) <=> ?',
    )
    expect(guardCondition(col('f', 'float'), { t: 'digest', v: digest }, 'old').sql).toBe(
      'SHA2(CAST(`f` AS BINARY), 256) <=> ?',
    )
    fails(() => guardCondition(col('i', 'int'), { t: 'digest', v: digest }, 'old'))
  })
  it('BIT compares as its number, binary as bytes', () => {
    expect(guardCondition(col('b', 'bit', { length: 12 }), { t: 'v', v: "b'101'" }, 'old')).toEqual(
      {
        sql: '(`b` + 0) <=> ?',
        params: ['5'],
      },
    )
    expect(guardCondition(col('b', 'binary'), { t: 'v', v: '0x00ff' }, 'old')).toEqual({
      sql: '`b` <=> ?',
      params: [Buffer.from([0, 255])],
    })
  })
})

describe('read projections', () => {
  it('float is read through CAST AS CHAR', () => {
    const p = projectionFor(col('f', 'float'), read)
    expect(p.exprs).toEqual(['CAST(`f` AS CHAR)'])
    expect(p.decode(['0.1'])).toBe('0.1')
  })
  it('BIT is padded to its width and shown as a b-literal', () => {
    const p = projectionFor(col('b', 'bit', { length: 12 }), read)
    expect(p.exprs).toEqual(["LPAD(BIN(`b` + 0), 12, '0')"])
    expect(p.decode(['101'.padStart(12, '0')])).toBe("b'000000000101'")
    expect(p.decode([null])).toBeNull()
  })
  it('long text is cut with its full length, short text stays a string', () => {
    const p = projectionFor(col('t', 'text'), read)
    expect(p.exprs).toEqual([
      'LEFT(`t`, 11)',
      'CASE WHEN OCTET_LENGTH(`t`) > 10 THEN CHAR_LENGTH(`t`) END',
    ])
    expect(p.decode(['short', null])).toBe('short')
    expect(p.decode(['short', 5])).toBe('short')
    expect(p.decode(['0123456789a', 5000])).toEqual({ cut: '0123456789', length: 5000 })
    expect(p.decode(['😀😀😀😀😀😀😀😀😀😀😀', 11])).toEqual({
      cut: '😀😀😀😀😀😀😀😀😀😀',
      length: 11,
    })
  })
  it('binary shows the first 32 bytes and the size', () => {
    const p = projectionFor(col('b', 'blob'), read)
    expect(p.exprs).toEqual(['SUBSTRING(`b`, 1, 32)', 'OCTET_LENGTH(`b`)'])
    expect(p.decode([Buffer.from([0, 255, 10]), 3000])).toEqual({ binary: '00ff0a', size: 3000 })
  })
  it('geometry reads WKT and, without a column SRID, carries the value SRID', () => {
    const p = projectionFor(col('g', 'geometry'), { cellBytes: 100 })
    expect(p.exprs).toEqual([
      'LEFT(ST_AsText(`g`), 101)',
      'CASE WHEN OCTET_LENGTH(ST_AsText(`g`)) > 100 THEN CHAR_LENGTH(ST_AsText(`g`)) END',
      'ST_SRID(`g`)',
    ])
    expect(p.decode(['POINT(1 2)', 10, 4326])).toBe('SRID=4326;POINT(1 2)')
    expect(p.decode(['POINT(1 2)', 10, 0])).toBe('POINT(1 2)')
    const fixed = projectionFor(col('g', 'geometry', { srid: 4326 }), read)
    expect(fixed.exprs).toHaveLength(2)
    expect(fixed.decode(['POINT(1 2)', 10])).toBe('POINT(1 2)')
  })
  it('numbers and temporal values arrive as strings', () => {
    expect(projectionFor(col('i', 'int'), read).decode([12])).toBe('12')
    expect(projectionFor(col('i', 'int'), read).decode(['9223372036854775807'])).toBe(
      '9223372036854775807',
    )
    expect(projectionFor(col('y', 'year'), read).decode([99])).toBe('0099')
    expect(projectionFor(col('j', 'json'), read).decode([{ a: 1 }, 7])).toBe('{"a":1}')
  })
  it('the cell reader returns value, length and digest', () => {
    const p = cellReadProjection(col('j', 'json'), 100)
    expect(p.exprs).toEqual([
      'LEFT(`j`, 100)',
      'CHAR_LENGTH(`j`)',
      'SHA2(CAST(`j` AS BINARY), 256)',
    ])
    expect(p.decode(['{}', 2, 'd'.repeat(64)])).toEqual({
      value: { t: 'text', text: '{}', length: 2, truncated: false },
      digest: 'd'.repeat(64),
    })
    const b = cellReadProjection(col('b', 'blob'), 4)
    expect(b.decode([Buffer.from([1, 2, 3, 4]), 10, 'e'.repeat(64)]).value).toEqual({
      t: 'bytes',
      hex: '01020304',
      length: 10,
      truncated: true,
    })
    expect(cellReadProjection(col('i', 'int'), 10).decode([null, null]).value).toEqual({
      t: 'null',
    })
  })
})

describe('temporal projection keeps fractional digits', () => {
  it('reads a column with fractional seconds through CAST AS CHAR, others plain', () => {
    const t = projectionFor(col('t', 'time', { fsp: 3 }), read)
    expect(t.exprs).toEqual(['CAST(`t` AS CHAR)'])
    expect(t.decode(['-838:59:59.000'])).toBe('-838:59:59.000')
    expect(projectionFor(col('d', 'datetime', { fsp: 0 }), read).exprs).toEqual(['`d`'])
    expect(projectionFor(col('d', 'date'), read).exprs).toEqual(['`d`'])
  })
})
