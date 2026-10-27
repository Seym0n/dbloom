/**
 * Compression helpers (FR-IO-008, FR-IO-014): a streaming zip writer over `fflate`, gzip/zip detection by
 * magic bytes, and guarded readers that enforce the decompressed-size cap and the 100:1 ratio while inflating.
 * Reader limits: exactly one entry, no nested archive, no encryption, no multi-disk, no ZIP64 (refused).
 */
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { PassThrough, Readable, Transform } from 'node:stream'
import { crc32, createGunzip, createInflateRaw } from 'node:zlib'
import { Zip, ZipDeflate } from 'fflate'
import { sanitizeFileName } from './filename'
import { MAX_ARCHIVE_ENTRIES, MAX_COMPRESSION_RATIO } from './types'
import type { IoErrorCode } from './types'

export class ArchiveError extends Error {
  constructor(
    public code: IoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ArchiveError'
  }
}

// ---- Detection -------------------------------------------------------------------------------------------

export type Sniffed = 'gzip' | 'zip' | 'none'

export function detectCompression(head: Uint8Array): Sniffed {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip'
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2] as number)) return 'zip'
  return 'none'
}

/** Containers an import must not unpack inside an archive entry. */
export function looksLikeArchive(head: Uint8Array): boolean {
  if (detectCompression(head) !== 'none') return true
  const at = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)
  return (
    at(0x42, 0x5a, 0x68) || // bzip2
    at(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) || // xz
    at(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || // 7z
    at(0x28, 0xb5, 0x2f, 0xfd) || // zstd
    at(0x52, 0x61, 0x72, 0x21) // rar
  )
}

// ---- Entry names (FR-IOX-085) -------------------------------------------------------------------------------

/** `<base>_<object>.<ext>`: the object name goes before the extension taken from the last dot. */
export function separateEntryName(fileName: string, objectName: string): string {
  const obj = sanitizeFileName(objectName)
  const dot = fileName.lastIndexOf('.')
  return dot <= 0 ? `${fileName}_${obj}` : `${fileName.slice(0, dot)}_${obj}${fileName.slice(dot)}`
}

// ---- Writer ------------------------------------------------------------------------------------------------

/**
 * Sequential zip writer: `begin(name)`, any number of `write`, `endEntry()`, ..., `finish()`. Output chunks go to
 * `onData` as they are produced; entries are deflated with a data descriptor, names are UTF-8.
 */
export class ZipWriter {
  private zip: Zip
  private current: ZipDeflate | null = null
  private error: Error | null = null
  private done = false
  private entryBytes = 0
  private outBytes = 0

  /**
   * `maxBytes` is the size of an entry (uncompressed) and of the archive (written); `fflate` does not write ZIP64
   * (measured 2026-10-27: a 4 GiB + 1 byte entry is recorded as 1 byte), so the writer refuses to pass the 32-bit
   * limit instead of producing an archive other tools read wrongly.
   */
  constructor(
    private onData: (chunk: Uint8Array) => void,
    private level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
    private maxBytes = 0xffffffff,
  ) {
    this.zip = new Zip((err, chunk) => {
      if (err) this.error = err
      else {
        this.outBytes += chunk.length
        this.onData(chunk)
      }
    })
  }

  private check() {
    if (this.error) throw this.error
  }

  begin(name: string) {
    if (this.done) throw new Error('Zip already finished')
    if (this.current) this.endEntry()
    const entry = new ZipDeflate(name, { level: this.level })
    this.entryBytes = 0
    this.zip.add(entry)
    this.current = entry
    this.check()
  }

  write(data: Uint8Array | string) {
    if (!this.current) throw new Error('No open zip entry')
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.entryBytes += bytes.length
    if (this.entryBytes > this.maxBytes || this.outBytes > this.maxBytes)
      throw new ArchiveError('export_too_large', 'A zip archive cannot hold more than 4 GiB per file or in total; export as gzip or without compression')
    this.current.push(bytes, false)
    this.check()
  }

  endEntry() {
    if (!this.current) return
    this.current.push(new Uint8Array(0), true)
    this.current = null
    this.check()
  }

  finish() {
    if (this.done) return
    this.endEntry()
    this.zip.end()
    this.done = true
    this.check()
  }
}

// ---- Guarded inflating ------------------------------------------------------------------------------------

export type InflateLimits = {
  /** Cap on decompressed bytes (settings `decompressedBytes`). */
  maxBytes: number
  /** Output bytes allowed per input byte; default 100. */
  ratio?: number
  /** Output allowed before the ratio check starts, so tiny inputs are not judged (default 1 MiB). */
  ratioGraceBytes?: number
}

/** Counts bytes passing through (the compressed side of the ratio). */
class Counter extends Transform {
  bytes = 0
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.bytes += chunk.length
    cb(null, chunk)
  }
}

type Expected = { size: number; crc: number }

/** Enforces cap and ratio on the decompressed side, sniffs the first bytes for a nested archive, checks size and CRC at the end. */
class Guard extends Transform {
  out = 0
  private first = true
  private crc = 0
  constructor(
    private limits: Required<InflateLimits>,
    private input: Counter,
    private rejectNested: boolean,
    private expected?: Expected,
  ) {
    super()
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    if (this.first && this.rejectNested && chunk.length > 0) {
      this.first = false
      if (looksLikeArchive(chunk)) return cb(new ArchiveError('archive_not_allowed', 'The file inside the archive is itself an archive'))
    }
    this.out += chunk.length
    if (this.out > this.limits.maxBytes)
      return cb(new ArchiveError('decompressed_too_large', 'The decompressed data exceeds the size limit'))
    if (this.out > this.limits.ratioGraceBytes && this.out > this.limits.ratio * Math.max(this.input.bytes, 1))
      return cb(new ArchiveError('ratio_exceeded', `The compression ratio exceeds ${this.limits.ratio}:1`))
    if (this.expected) this.crc = crc32(chunk, this.crc)
    cb(null, chunk)
  }
  override _flush(cb: (e?: Error | null) => void) {
    if (this.expected && (this.out !== this.expected.size || this.crc !== this.expected.crc))
      return cb(new ArchiveError('not_archive', 'The archive entry is damaged (size or checksum mismatch)'))
    cb()
  }
}

function withDefaults(l: InflateLimits): Required<InflateLimits> {
  return { maxBytes: l.maxBytes, ratio: l.ratio ?? MAX_COMPRESSION_RATIO, ratioGraceBytes: l.ratioGraceBytes ?? 1024 * 1024 }
}

function mapInflateError(e: unknown): Error {
  if (e instanceof ArchiveError) return e
  const err = e as NodeJS.ErrnoException
  if (typeof err.code === 'string' && err.code.startsWith('Z_'))
    return new ArchiveError('not_archive', 'The compressed data is truncated or damaged')
  return err
}

/** Source -> counter -> inflater -> guard; the guard is returned. Known failures surface as `ArchiveError`. */
function guarded(source: Readable, inflater: Transform, limits: InflateLimits, rejectNested: boolean, expected?: Expected): Readable {
  const counter = new Counter()
  const guard = new Guard(withDefaults(limits), counter, rejectNested, expected)
  const fail = (e: unknown) => guard.destroy(mapInflateError(e))
  source.on('error', fail)
  counter.on('error', fail)
  inflater.on('error', fail)
  source.pipe(counter).pipe(inflater).pipe(guard)
  guard.on('close', () => {
    source.destroy()
    counter.destroy()
    inflater.destroy()
  })
  return guard
}

/** gzip from any readable (the staged file); truncated or damaged input fails with `not_archive`. */
export function inflateGzip(source: Readable, limits: InflateLimits): Readable {
  return guarded(source, createGunzip(), limits, false)
}

// ---- Single-entry zip reader ---------------------------------------------------------------------------------

export type ZipEntryInfo = {
  name: string
  method: 0 | 8
  compressedSize: number
  size: number
  crc: number
  /** Offset of the compressed bytes in the file. */
  dataOffset: number
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** Reads the central directory of the file and checks it against the import rules. */
export async function inspectZip(path: string, limits: Pick<InflateLimits, 'maxBytes'>): Promise<ZipEntryInfo> {
  const st = await stat(path)
  const fh = await open(path, 'r')
  try {
    const tailLen = Math.min(st.size, 22 + 65535)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, st.size - tailLen)
    let e = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tailLen) {
        e = i
        break
      }
    }
    if (e < 0) throw new ArchiveError('not_archive', 'The zip directory was not found (truncated or not a zip)')
    const disk = tail.readUInt16LE(e + 4)
    const cdDisk = tail.readUInt16LE(e + 6)
    const entriesHere = tail.readUInt16LE(e + 8)
    const entries = tail.readUInt16LE(e + 10)
    const cdSize = tail.readUInt32LE(e + 12)
    const cdOffset = tail.readUInt32LE(e + 16)
    if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries)
      throw new ArchiveError('archive_not_allowed', 'Multi-disk archives are not accepted')
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw new ArchiveError('archive_not_allowed', 'ZIP64 archives are not accepted')
    if (entries !== MAX_ARCHIVE_ENTRIES)
      throw new ArchiveError('archive_not_allowed', `The archive must contain exactly ${MAX_ARCHIVE_ENTRIES} file (found ${entries})`)
    if (cdOffset + cdSize > st.size || cdSize < 46 || cdSize > 70000)
      throw new ArchiveError('not_archive', 'The zip directory is damaged')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    if (cd.readUInt32LE(0) !== CEN_SIG) throw new ArchiveError('not_archive', 'The zip directory is damaged')
    const flags = cd.readUInt16LE(8)
    const method = cd.readUInt16LE(10)
    const crc = cd.readUInt32LE(16)
    const compressedSize = cd.readUInt32LE(20)
    const size = cd.readUInt32LE(24)
    const nameLen = cd.readUInt16LE(28)
    const extraLen = cd.readUInt16LE(30)
    const commentLen = cd.readUInt16LE(32)
    const localOffset = cd.readUInt32LE(42)
    if (46 + nameLen + extraLen + commentLen > cdSize) throw new ArchiveError('not_archive', 'The zip directory is damaged')
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0 || method === 99)
      throw new ArchiveError('archive_not_allowed', 'Encrypted archives are not accepted')
    if (method !== 0 && method !== 8) throw new ArchiveError('archive_not_allowed', 'Unsupported zip compression method')
    const name = cd.subarray(46, 46 + nameLen).toString('utf8')
    if (name.endsWith('/')) throw new ArchiveError('archive_not_allowed', 'The archive contains no file')
    if (size === 0xffffffff || compressedSize === 0xffffffff)
      throw new ArchiveError('archive_not_allowed', 'ZIP64 archives are not accepted')
    if (size > limits.maxBytes) throw new ArchiveError('decompressed_too_large', 'The decompressed data exceeds the size limit')
    const loc = Buffer.alloc(30)
    await fh.read(loc, 0, 30, localOffset)
    if (loc.readUInt32LE(0) !== LOC_SIG) throw new ArchiveError('not_archive', 'The zip entry header is damaged')
    const dataOffset = localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28)
    if (dataOffset + compressedSize > cdOffset) throw new ArchiveError('not_archive', 'The zip entry is damaged')
    return { name, method: method as 0 | 8, compressedSize, size, crc, dataOffset }
  } finally {
    await fh.close()
  }
}

/** Opens the single entry of a zip file as a stream of decompressed bytes with the limits applied while inflating. */
export async function openSingleEntryZip(
  path: string,
  limits: InflateLimits,
): Promise<{ info: ZipEntryInfo; stream: Readable }> {
  const info = await inspectZip(path, limits)
  const source = createReadStream(path, {
    start: info.dataOffset,
    end: Math.max(info.dataOffset, info.dataOffset + info.compressedSize - 1),
  })
  const raw = info.compressedSize === 0 ? Readable.from([]) : source
  const inflater = info.method === 8 ? createInflateRaw() : new PassThrough()
  return { info, stream: guarded(raw, inflater, limits, true, { size: info.size, crc: info.crc }) }
}
