import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '../src/server/io/types'
import { csvCellText, jsonValue, sqlBit, sqlHex, sqlLiteral, sqlString } from '../src/server/io/values'

const c = (kind: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({ name: 'c', kind, ...extra })
const NB = { noBackslashEscapes: true }

describe('sqlString', () => {
  it('doubles quote and backslash by default', () => {
    expect(sqlString("a'b\\c")).toBe("'a''b\\\\c'")
    expect(sqlString("'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'")
    expect(sqlString('\\')).toBe("'\\\\'")
  })
  it('keeps backslashes with NO_BACKSLASH_ESCAPES', () => {
    expect(sqlString("a'b\\c", NB)).toBe("'a''b\\c'")
    expect(sqlString("\\' OR 1=1 -- ", NB)).toBe("'\\'' OR 1=1 -- '")
  })
  it('handles NUL and CR in both modes', () => {
    expect(sqlString('a\0b')).toBe("'a\\0b'")
    expect(sqlString('a\0b', NB)).toBe("CONCAT('a',CHAR(0),'b')")
    expect(sqlString('a\r\nb')).toBe("'a\\r\nb'")
    expect(sqlString('a\r\nb', NB)).toBe("'a\r\nb'")
  })
  it('hostile strings stay inside one literal', () => {
    // Minimal tokenizer: the literal must be exactly one string token in the matching mode.
    const closeAt = (lit: string, noBackslash: boolean) => {
      let i = 1
      while (i < lit.length) {
        const ch = lit[i]
        if (ch === '\\' && !noBackslash) i += 2
        else if (ch === "'" && lit[i + 1] === "'") i += 2
        else if (ch === "'") return i
        else i++
      }
      return -1
    }
    for (const s of ['\\', "\\'", "''", "\\\\'", 'a\\', "'\\", "\\'; DROP TABLE t; --"]) {
      expect(closeAt(sqlString(s), false)).toBe(sqlString(s).length - 1)
      expect(closeAt(sqlString(s, NB), true)).toBe(sqlString(s, NB).length - 1)
    }
  })
})

describe('sqlLiteral', () => {
  it('NULL', () => expect(sqlLiteral(null, c('int'))).toBe('NULL'))
  it('exact numbers as given', () => {
    expect(sqlLiteral('18446744073709551615', c('int', { unsigned: true }))).toBe('18446744073709551615')
    expect(sqlLiteral('-0.10', c('decimal'))).toBe('-0.10')
    expect(sqlLiteral('1.5e-7', c('float'))).toBe('1.5e-7')
    expect(sqlLiteral('2024', c('year'))).toBe('2024')
  })
  it('non-numeric text in a numeric column is quoted, never raw', () => {
    expect(sqlLiteral('1; DROP TABLE t', c('int'))).toBe("'1; DROP TABLE t'")
    expect(sqlLiteral('NaN', c('float'))).toBe("'NaN'")
  })
  it('strings and temporal values are quoted', () => {
    expect(sqlLiteral('2024-01-02 03:04:05.5', c('datetime'))).toBe("'2024-01-02 03:04:05.5'")
    expect(sqlLiteral('12', c('char'))).toBe("'12'")
    expect(sqlLiteral('{"a":"b\\"c"}', c('json'))).toBe("'{\"a\":\"b\\\\\"c\"}'")
  })
  it('binary and blob as hex, empty as quotes', () => {
    expect(sqlLiteral(Buffer.from([0, 255, 16]), c('binary'))).toBe('0x00ff10')
    expect(sqlLiteral(Buffer.alloc(0), c('blob'))).toBe("''")
    expect(sqlLiteral(Buffer.from('ab'), c('blob'))).toBe('0x6162')
    expect(sqlLiteral('ab', c('char', { binary: true }))).toBe('0x6162')
  })
  it('BIT as b literal', () => {
    expect(sqlLiteral(Buffer.from([5]), c('bit'))).toBe("b'101'")
    expect(sqlLiteral(Buffer.from([1, 0]), c('bit'))).toBe("b'100000000'")
    expect(sqlLiteral(Buffer.from([0]), c('bit'))).toBe("b'0'")
    expect(sqlLiteral(Buffer.alloc(0), c('bit'))).toBe("b'0'")
    expect(sqlBit(Buffer.from([0xff, 0xff]))).toBe("b'1111111111111111'")
    expect(sqlLiteral('5', c('bit'))).toBe('5')
  })
  it('geometry as hex of the internal value', () => {
    expect(sqlLiteral(Buffer.from('0000000001010000000000000000', 'hex'), c('geometry'))).toBe('0x0000000001010000000000000000')
    expect(sqlLiteral('00000000010100', c('geometry'))).toBe('0x00000000010100')
    expect(sqlLiteral('POINT(1 1)', c('geometry'))).toBe("'POINT(1 1)'")
  })
  it('a Buffer in a text column is decoded as UTF-8', () => {
    expect(sqlLiteral(Buffer.from("o'k"), c('text'))).toBe("'o''k'")
  })
  it('honours NO_BACKSLASH_ESCAPES for strings', () => {
    expect(sqlLiteral('a\\b', c('text'), NB)).toBe("'a\\b'")
    expect(sqlLiteral('a\\b', c('text'))).toBe("'a\\\\b'")
  })
  it('sqlHex', () => expect(sqlHex(new Uint8Array([1, 2]))).toBe('0x0102'))
})

describe('csvCellText', () => {
  const o = { nullText: '', neutraliseFormulas: true }
  it('NULL uses the NULL text', () => {
    expect(csvCellText(null, c('char'), o)).toBe('')
    expect(csvCellText(null, c('char'), { ...o, nullText: 'NULL' })).toBe('NULL')
  })
  it('prefixes formula starts', () => {
    for (const s of ['=1+1', '+1', '-1+2', '@SUM(A1)', '\tx', '\rx', '=HYPERLINK("x")'])
      expect(csvCellText(s, c('char'), o)).toBe("'" + s)
    expect(csvCellText('safe', c('char'), o)).toBe('safe')
    expect(csvCellText('a=b', c('char'), o)).toBe('a=b')
  })
  it('does not neutralise negative numerals in numeric columns', () => {
    expect(csvCellText('-12.5', c('decimal'), o)).toBe('-12.5')
    expect(csvCellText('-12.5', c('char'), o)).toBe("'-12.5")
    expect(csvCellText('-x', c('int'), o)).toBe("'-x")
  })
  it('can be switched off', () => {
    expect(csvCellText('=1', c('char'), { ...o, neutraliseFormulas: false })).toBe('=1')
  })
  it('binary as 0x hex', () => {
    expect(csvCellText(Buffer.from([1, 171]), c('binary'), o)).toBe('0x01ab')
    expect(csvCellText(Buffer.alloc(0), c('blob'), o)).toBe('0x')
  })
  it('line breaks', () => {
    expect(csvCellText('a\r\nb\rc\nd', c('text'), { ...o, lineBreaks: 'lf' })).toBe('a\nb\nc\nd')
    expect(csvCellText('a\r\nb\rc\nd', c('text'), { ...o, lineBreaks: 'remove' })).toBe('a b c d')
    expect(csvCellText('a\r\nb', c('text'), { ...o, lineBreaks: 'keep' })).toBe('a\r\nb')
  })
})

describe('jsonValue', () => {
  it('null and strings', () => {
    expect(jsonValue(null, c('char'))).toBeNull()
    expect(jsonValue('x', c('char'))).toBe('x')
    expect(jsonValue('{"a":1}', c('json'))).toBe('{"a":1}')
  })
  it('safe integers are numbers, BIGINT beyond 2^53 are strings', () => {
    expect(jsonValue('42', c('int'))).toBe(42)
    expect(jsonValue('-9007199254740991', c('int'))).toBe(-9007199254740991)
    expect(jsonValue('9007199254740993', c('int'))).toBe('9007199254740993')
    expect(jsonValue('18446744073709551615', c('int', { unsigned: true }))).toBe('18446744073709551615')
  })
  it('decimals stay strings', () => expect(jsonValue('1.10', c('decimal'))).toBe('1.10'))
  it('floats are numbers when finite', () => {
    expect(jsonValue('1.5', c('float'))).toBe(1.5)
    expect(jsonValue('inf', c('float'))).toBe('inf')
  })
  it('binary and geometry as 0x strings', () => {
    expect(jsonValue(Buffer.from([255]), c('binary'))).toBe('0xff')
    expect(jsonValue(Buffer.from([0, 1]), c('geometry'))).toBe('0x0001')
    expect(jsonValue(Buffer.alloc(0), c('blob'))).toBe('0x')
  })
})
