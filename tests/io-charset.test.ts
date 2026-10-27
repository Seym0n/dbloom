import { describe, expect, it } from 'vitest'
import {
  ChunkDecoder,
  CharsetUnsupportedError,
  InvalidBytesError,
  decodeChunks,
  detectBom,
  firstInvalidUtf8,
  resolveCharset,
} from '../src/server/io/charset'

const TEXT = 'Grüße, 世界 \u{1F600} line\nzwei\r\ndrei é'

function decodeAt(bytes: Buffer, cuts: number[], charset?: string): string {
  const d = new ChunkDecoder({ charset })
  let out = ''
  let prev = 0
  for (const cut of [...cuts, bytes.length]) {
    out += d.write(bytes.subarray(prev, cut))
    prev = cut
  }
  return out + d.end()
}

const utf16 = (s: string, le: boolean, bom: boolean) => {
  const body = Buffer.from(s, 'utf16le')
  if (!le) body.swap16()
  const mark = Buffer.from(le ? [0xff, 0xfe] : [0xfe, 0xff])
  return bom ? Buffer.concat([mark, body]) : body
}

describe('ChunkDecoder property: cut at every byte offset', () => {
  it('utf-8', () => {
    const b = Buffer.from(TEXT)
    for (let i = 0; i <= b.length; i++) expect(decodeAt(b, [i])).toBe(TEXT)
  })
  it('utf-8 cut at two offsets, byte by byte', () => {
    const b = Buffer.from(TEXT)
    const d = new ChunkDecoder()
    let out = ''
    for (const byte of b) out += d.write(Buffer.from([byte]))
    expect(out + d.end()).toBe(TEXT)
  })
  it('utf-16 le and be with BOM', () => {
    for (const le of [true, false]) {
      const b = utf16(TEXT, le, true)
      for (let i = 0; i <= b.length; i++) expect(decodeAt(b, [i])).toBe(TEXT)
    }
  })
  it('utf-16 without BOM when the label says so', () => {
    const b = utf16(TEXT, true, false)
    for (let i = 0; i <= b.length; i++) expect(decodeAt(b, [i], 'utf-16le')).toBe(TEXT)
    const be = utf16(TEXT, false, false)
    for (let i = 0; i <= be.length; i++) expect(decodeAt(be, [i], 'utf-16be')).toBe(TEXT)
  })
  it('shift_jis and windows-1252 (stateful TextDecoder path)', () => {
    const sj = Buffer.from('82a082a282a4', 'hex') // three hiragana
    for (let i = 0; i <= sj.length; i++) expect(decodeAt(sj, [i], 'shift_jis')).toBe('あいう')
    const w = Buffer.from([0x80, 0xe4, 0x41])
    for (let i = 0; i <= w.length; i++) expect(decodeAt(w, [i], 'windows-1252')).toBe('€äA')
  })
})

describe('BOM', () => {
  it('strips the UTF-8 BOM, also split across chunks', () => {
    const b = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')])
    for (let i = 0; i <= b.length; i++) expect(decodeAt(b, [i])).toBe('abc')
    const d = new ChunkDecoder()
    d.write(b)
    expect(d.bomFound).toBe(true)
    expect(d.encoding).toBe('utf-8')
  })
  it('a BOM overrides the chosen charset', () => {
    const d = new ChunkDecoder({ charset: 'windows-1252' })
    expect(d.write(utf16('hi', true, true)) + d.end()).toBe('hi')
    expect(d.encoding).toBe('utf-16le')
  })
  it('input shorter than three bytes', () => {
    expect(decodeAt(Buffer.from('ab'), [1])).toBe('ab')
    expect(decodeAt(Buffer.from([0xff, 0xfe]), [])).toBe('')
    expect(decodeAt(Buffer.alloc(0), [])).toBe('')
  })
  it('detectBom', () => {
    expect(detectBom(Buffer.from([0xfe, 0xff]))?.encoding).toBe('utf-16be')
    expect(detectBom(Buffer.from('abc'))).toBeNull()
  })
  it('can be switched off', () => {
    const d = new ChunkDecoder({ detectBom: false })
    expect(d.write(Buffer.from([0xef, 0xbb, 0xbf, 0x61])) + d.end()).toBe('﻿a')
  })
})

describe('invalid bytes', () => {
  const fail = (fn: () => unknown): InvalidBytesError => {
    try {
      fn()
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidBytesError)
      return e as InvalidBytesError
    }
    throw new Error('did not throw')
  }
  it('reports offset and line in the same chunk', () => {
    const b = Buffer.concat([Buffer.from('a\nb\nc'), Buffer.from([0xff]), Buffer.from('d')])
    const e = fail(() => decodeAt(b, []))
    expect(e.byteOffset).toBe(5)
    expect(e.line).toBe(3)
    expect(e.code).toBe('invalid_bytes')
    expect(e.approximate).toBe(false)
  })
  it('reports the absolute offset across chunks, for any cut', () => {
    const b = Buffer.concat([Buffer.from('héllo\nwörld\n'), Buffer.from([0xc3, 0x28]), Buffer.from('x')])
    const at = Buffer.byteLength('héllo\nwörld\n')
    for (let i = 0; i <= b.length; i++) {
      const e = fail(() => decodeAt(b, [i]))
      expect(e.byteOffset).toBe(at)
      expect(e.line).toBe(3)
    }
  })
  it('a truncated multibyte character at the end fails at its first byte', () => {
    const b = Buffer.concat([Buffer.from('ab'), Buffer.from('世').subarray(0, 2)])
    const e = fail(() => decodeAt(b, [1]))
    expect(e.byteOffset).toBe(2)
  })
  it('overlongs, surrogates and too-large code points are invalid', () => {
    expect(firstInvalidUtf8(Buffer.from([0xc0, 0x80]))).toBe(0)
    expect(firstInvalidUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(0)
    expect(firstInvalidUtf8(Buffer.from([0xf4, 0x90, 0x80, 0x80]))).toBe(0)
    expect(firstInvalidUtf8(Buffer.from('ok世\u{1F600}'))).toBe(-1)
  })
  it('lone utf-16 surrogate', () => {
    const b = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x00, 0xd8, 0x62, 0x00])
    const e = fail(() => decodeAt(b, []))
    expect(e.byteOffset).toBe(4)
  })
  it('odd byte count in utf-16 fails at the end', () => {
    const e = fail(() => decodeAt(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62]), []))
    expect(e.byteOffset).toBe(4)
  })
  it('legacy encodings report the chunk start as approximate', () => {
    const e = fail(() => decodeAt(Buffer.from([0x82, 0xa0, 0xff, 0xff]), [], 'shift_jis'))
    expect(e.approximate).toBe(true)
  })
})

describe('charset names', () => {
  it('resolves labels', () => {
    expect(resolveCharset('latin1')).toBe('windows-1252')
    expect(resolveCharset('UTF8')).toBe('utf-8')
    expect(resolveCharset('nonsense')).toBeNull()
  })
  it('refuses an unknown charset', () => {
    expect(() => new ChunkDecoder({ charset: 'x-unknown' })).toThrow(CharsetUnsupportedError)
  })
})

describe('decodeChunks', () => {
  it('decodes an async iterable', async () => {
    async function* src() {
      const b = Buffer.from(TEXT)
      yield b.subarray(0, 8)
      yield b.subarray(8, 9)
      yield b.subarray(9)
    }
    let out = ''
    for await (const t of decodeChunks(src())) out += t
    expect(out).toBe(TEXT)
  })
})
