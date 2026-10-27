/**
 * Streaming charset decoding for import (FR-IO-015, FR-IOX-050/051): BOM detection and removal, fatal mode,
 * and errors that carry the byte offset and the line. A multibyte character cut at a chunk boundary decodes
 * correctly. UTF-8 and UTF-16 are tracked by hand, so their offsets are exact; other encodings go through
 * `TextDecoder` with `stream: true` and report the start of the failing chunk (`approximate: true`).
 */

export class InvalidBytesError extends Error {
  readonly code = 'invalid_bytes'
  constructor(
    public byteOffset: number,
    public line: number,
    public approximate = false,
  ) {
    super(`Invalid byte sequence at byte ${byteOffset} (line ${line})`)
    this.name = 'InvalidBytesError'
  }
}

export class CharsetUnsupportedError extends Error {
  readonly code = 'charset_unsupported'
  constructor(label: string) {
    super(`Unsupported charset: ${label.slice(0, 40)}`)
    this.name = 'CharsetUnsupportedError'
  }
}

/** Canonical WHATWG name of a label (`latin1` gives `windows-1252`), or null when `TextDecoder` does not know it. */
export function resolveCharset(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding
  } catch {
    return null
  }
}

/** Names offered in the charset picker (display names are the UI's job). */
export const COMMON_CHARSETS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'iso-8859-1',
  'iso-8859-2',
  'iso-8859-15',
  'windows-1250',
  'windows-1251',
  'shift_jis',
  'euc-jp',
  'gbk',
  'gb18030',
  'big5',
  'euc-kr',
] as const

export function detectBom(head: Uint8Array): { encoding: 'utf-8' | 'utf-16le' | 'utf-16be'; length: number } | null {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8', length: 3 }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', length: 2 }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', length: 2 }
  return null
}

/** Offset of the first byte that is not valid UTF-8 (overlongs, surrogates and > U+10FFFF included), or -1. */
export function firstInvalidUtf8(b: Uint8Array): number {
  let i = 0
  while (i < b.length) {
    const c = b[i] as number
    if (c < 0x80) {
      i++
      continue
    }
    let need: number
    let min: number
    if (c >= 0xc2 && c <= 0xdf) [need, min] = [1, 0x80]
    else if (c >= 0xe0 && c <= 0xef) [need, min] = [2, 0x800]
    else if (c >= 0xf0 && c <= 0xf4) [need, min] = [3, 0x10000]
    else return i
    let cp = c & (0x3f >> need)
    for (let k = 1; k <= need; k++) {
      const n = b[i + k]
      if (n === undefined || (n & 0xc0) !== 0x80) return i
      cp = (cp << 6) | (n & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i
    i += need + 1
  }
  return -1
}

/** Length of an incomplete UTF-8 sequence at the end of `b` (0 to 3), judged by lead byte only. */
function utf8TailLength(b: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= b.length; back++) {
    const c = b[b.length - back] as number
    if ((c & 0xc0) === 0x80) continue
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1
    return need > back ? back : 0
  }
  return 0
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

type Mode = 'utf-8' | 'utf-16le' | 'utf-16be' | 'other'

export type ChunkDecoderOptions = {
  /** Label from the user; default utf-8. A BOM overrides it. */
  charset?: string
  /** Look for a BOM at the start (default true). */
  detectBom?: boolean
}

export class ChunkDecoder {
  /** Canonical name in use; after the first bytes it reflects a BOM. */
  encoding: string
  bomFound = false
  private mode: Mode
  private started = false
  private head: Buffer = Buffer.alloc(0)
  private tail: Buffer = Buffer.alloc(0)
  private offset = 0 // bytes consumed before `tail`
  private lines = 1
  private other: TextDecoder | null = null
  private readonly detect: boolean

  constructor(opts: ChunkDecoderOptions = {}) {
    const name = resolveCharset(opts.charset ?? 'utf-8')
    if (name === null) throw new CharsetUnsupportedError(opts.charset ?? '')
    this.encoding = name
    this.mode = ChunkDecoder.modeOf(name)
    this.detect = opts.detectBom ?? true
    if (this.mode === 'other') this.other = new TextDecoder(name, { fatal: true, ignoreBOM: true })
  }

  private static modeOf(name: string): Mode {
    return name === 'utf-8' || name === 'utf-16le' || name === 'utf-16be' ? name : 'other'
  }

  private setEncoding(name: string) {
    this.encoding = name
    this.mode = ChunkDecoder.modeOf(name)
    this.other = this.mode === 'other' ? new TextDecoder(name, { fatal: true, ignoreBOM: true }) : null
  }

  /** Decoded text of this chunk (may be empty while bytes are held back). */
  write(chunk: Uint8Array): string {
    let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (!this.started) {
      if (this.detect) {
        this.head = Buffer.concat([this.head, data])
        if (this.head.length < 3) return ''
        data = this.head
        this.head = Buffer.alloc(0)
        const bom = detectBom(data)
        if (bom) {
          this.bomFound = true
          this.setEncoding(bom.encoding)
          data = data.subarray(bom.length)
          this.offset += bom.length
        }
      }
      this.started = true
    }
    return this.decode(data, false)
  }

  /** Flushes held bytes; throws when they cannot be a whole character. */
  end(): string {
    if (!this.started) {
      this.started = true
      const data = this.head
      this.head = Buffer.alloc(0)
      if (this.detect) {
        const bom = detectBom(data)
        if (bom) {
          this.bomFound = true
          this.setEncoding(bom.encoding)
          return this.decode(data.subarray(bom.length), true, bom.length)
        }
      }
      return this.decode(data, true)
    }
    return this.decode(Buffer.alloc(0), true)
  }

  private decode(data: Buffer, final: boolean, skipped = 0): string {
    if (skipped) this.offset += skipped
    if (this.mode === 'other') return this.decodeOther(data, final)
    const all = this.tail.length ? Buffer.concat([this.tail, data]) : data
    const base = this.offset
    let cut = all.length
    if (!final) cut -= this.mode === 'utf-8' ? utf8TailLength(all) : this.utf16Tail(all)
    const body = all.subarray(0, cut)
    this.tail = Buffer.from(all.subarray(cut))
    this.offset = base + cut
    if (body.length === 0 && !final) return ''
    return this.decodeWhole(body, base)
  }

  private utf16Tail(b: Buffer): number {
    let hold = b.length % 2
    const even = b.length - hold
    if (even >= 2) {
      const hi = this.mode === 'utf-16le' ? b[even - 1] : b[even - 2]
      if (hi !== undefined && hi >= 0xd8 && hi <= 0xdb) hold += 2
    }
    return hold
  }

  private decodeWhole(body: Buffer, base: number): string {
    let bad = -1
    if (this.mode === 'utf-8') bad = firstInvalidUtf8(body)
    else bad = this.firstInvalidUtf16(body)
    if (bad === -1) {
      const text = new TextDecoder(this.encoding, { fatal: true, ignoreBOM: true }).decode(body)
      this.lines += countNewlines(text)
      return text
    }
    const prefix = new TextDecoder(this.encoding, { fatal: false, ignoreBOM: true }).decode(body.subarray(0, bad))
    throw new InvalidBytesError(base + bad, this.lines + countNewlines(prefix))
  }

  private firstInvalidUtf16(b: Buffer): number {
    const le = this.mode === 'utf-16le'
    const odd = b.length % 2 === 1
    if (odd) {
      const inner = this.firstInvalidUtf16(b.subarray(0, b.length - 1))
      return inner === -1 ? b.length - 1 : inner
    }
    for (let i = 0; i < b.length; i += 2) {
      const u = le ? b.readUInt16LE(i) : b.readUInt16BE(i)
      if (u >= 0xd800 && u <= 0xdbff) {
        if (i + 2 >= b.length) return i
        const n = le ? b.readUInt16LE(i + 2) : b.readUInt16BE(i + 2)
        if (n < 0xdc00 || n > 0xdfff) return i
        i += 2
      } else if (u >= 0xdc00 && u <= 0xdfff) return i
    }
    return -1
  }

  private decodeOther(data: Buffer, final: boolean): string {
    const dec = this.other as TextDecoder
    const at = this.offset
    try {
      const text = dec.decode(data, { stream: !final })
      this.offset += data.length
      this.lines += countNewlines(text)
      return text
    } catch {
      throw new InvalidBytesError(at, this.lines, true)
    }
  }
}

/** Decodes an async iterable of byte chunks into text chunks. */
export async function* decodeChunks(
  source: AsyncIterable<Uint8Array>,
  opts: ChunkDecoderOptions = {},
): AsyncGenerator<string> {
  const d = new ChunkDecoder(opts)
  for await (const chunk of source) {
    const t = d.write(chunk)
    if (t !== '') yield t
  }
  const last = d.end()
  if (last !== '') yield last
}
