/**
 * Shared pieces of the import side of module io (package D): the failure type that carries a closed `IoError`,
 * the staged or server-folder source of an import, and the pipeline file -> (gunzip | single zip entry) ->
 * charset decoder -> text chunks (FR-IO-014, FR-IO-015). Nothing here touches a target.
 */
import { open } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { Readable } from 'node:stream'
import { ChunkDecoder, CharsetUnsupportedError, InvalidBytesError } from './charset'
import { ArchiveError, detectCompression, inflateGzip, openSingleEntryZip } from './zip'
import type { Compression, IoError, IoErrorCode } from './types'

// ---- Failure -----------------------------------------------------------------------------------------------

/** An error of the closed `IoErrorCode` list; `error` is what the job result and the client see. */
export class IoFailure extends Error {
  constructor(public error: IoError) {
    super(error.message)
    this.name = 'IoFailure'
  }
}

export const failure = (code: IoErrorCode, message: string, extra: Partial<IoError> = {}): IoFailure =>
  new IoFailure({ ...extra, code, message })

/** The `code: message` form the client sees from a server function (same style as `toClientError`). */
export const toClientIoError = (e: IoFailure): Error => new Error(`${e.error.code}: ${e.error.message}`)

/** Known library errors become `IoFailure`; anything else is returned unchanged. */
export function asIoFailure(e: unknown): unknown {
  if (e instanceof IoFailure) return e
  if (e instanceof ArchiveError) return failure(e.code, e.message)
  if (e instanceof InvalidBytesError) {
    return failure('invalid_bytes', e.message, { byteOffset: e.byteOffset, line: e.line })
  }
  if (e instanceof CharsetUnsupportedError) return failure('charset_unsupported', e.message)
  return e
}

// ---- Sources ---------------------------------------------------------------------------------------------------

/** A file an import reads: a staged upload (`temp.ts`) or a file of the server import folder. */
export type ImportSource = {
  /** Upload id, or `fld_<hex>` id of a folder file. */
  id: string
  kind: 'upload' | 'folder'
  path: string
  /** Display name for messages and audit only. */
  name: string
  bytes: number
}

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

async function rawStream(source: ImportSource): Promise<Readable> {
  // Folder files are opened without following a symbolic link planted after the listing.
  const flags = source.kind === 'folder' ? fsConstants.O_RDONLY | O_NOFOLLOW : fsConstants.O_RDONLY
  try {
    const fh = await open(source.path, flags)
    return fh.createReadStream({ autoClose: true })
  } catch {
    throw failure('file_gone', 'The file is no longer available; upload it again')
  }
}

async function readHead(source: ImportSource): Promise<Buffer> {
  const flags = source.kind === 'folder' ? fsConstants.O_RDONLY | O_NOFOLLOW : fsConstants.O_RDONLY
  let fh
  try {
    fh = await open(source.path, flags)
  } catch {
    throw failure('file_gone', 'The file is no longer available; upload it again')
  }
  try {
    const head = Buffer.alloc(8)
    const { bytesRead } = await fh.read(head, 0, 8, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await fh.close().catch(() => undefined)
  }
}

export type OpenedBytes = {
  compression: Compression
  /** Decompressed bytes with the size cap and the ratio limit applied while reading (FR-IO-014). */
  stream: Readable
}

/** Detects gzip/zip by content (not by name) and opens the decompressed byte stream. */
export async function openBytes(
  source: ImportSource,
  limits: { decompressedBytes: number },
): Promise<OpenedBytes> {
  const head = await readHead(source)
  const compression = detectCompression(head)
  const caps = { maxBytes: limits.decompressedBytes }
  if (compression === 'gzip') return { compression, stream: inflateGzip(await rawStream(source), caps) }
  if (compression === 'zip') {
    const { stream } = await openSingleEntryZip(source.path, caps)
    return { compression, stream }
  }
  if (source.bytes > limits.decompressedBytes) {
    throw failure('decompressed_too_large', 'The file exceeds the size limit')
  }
  return { compression: 'none', stream: await rawStream(source) }
}

// ---- Decoding --------------------------------------------------------------------------------------------------

export type DecodedText = {
  compression: Compression
  decoder: ChunkDecoder
  /** Decoded text chunks. Bytes counted so far (decompressed side): `counter.bytes`. */
  text: AsyncGenerator<string>
  counter: { bytes: number }
}

/**
 * The full pipeline. Errors of the libraries surface from the generator as `IoFailure` (invalid bytes carry
 * byte offset and line, FR-IO-015). Cancelling the consumer destroys the file stream.
 */
export async function openDecoded(
  source: ImportSource,
  limits: { decompressedBytes: number },
  charset?: string,
  /** Sees every decompressed chunk (content hash of the analysis). */
  tap?: (chunk: Uint8Array) => void,
): Promise<DecodedText> {
  let decoder: ChunkDecoder
  try {
    decoder = new ChunkDecoder({ charset: charset?.trim() || undefined })
  } catch (e) {
    throw asIoFailure(e)
  }
  const opened = await openBytes(source, limits)
  // Errors reach the consumer through the iteration below; a late one (after we stopped reading) must not be uncaught.
  opened.stream.on('error', () => undefined)
  const counter = { bytes: 0 }
  async function* text(): AsyncGenerator<string> {
    try {
      for await (const chunk of opened.stream as AsyncIterable<Buffer>) {
        counter.bytes += chunk.length
        tap?.(chunk)
        const t = decoder.write(chunk)
        if (t !== '') yield t
      }
      const last = decoder.end()
      if (last !== '') yield last
    } catch (e) {
      throw asIoFailure(e)
    } finally {
      opened.stream.destroy()
    }
  }
  return { compression: opened.compression, decoder, text: text(), counter }
}

/** Drops the first `skipBytes` UTF-8 bytes of the decoded text (resume point at a statement boundary). */
export async function* skipDecodedBytes(
  text: AsyncIterable<string>,
  skipBytes: number,
): AsyncGenerator<string> {
  let left = skipBytes
  for await (const chunk of text) {
    if (left <= 0) {
      yield chunk
      continue
    }
    const size = Buffer.byteLength(chunk, 'utf8')
    if (size <= left) {
      left -= size
      continue
    }
    // The cut falls inside this chunk: walk code points until `left` bytes are used.
    let i = 0
    while (left > 0 && i < chunk.length) {
      const cp = chunk.codePointAt(i) as number
      const units = cp > 0xffff ? 2 : 1
      left -= cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
      i += units
    }
    left = 0
    if (i < chunk.length) yield chunk.slice(i)
  }
}
