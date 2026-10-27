/**
 * Output side of an export (FR-IO-008, FR-IO-010): text chunks go through none, gzip or zip into the spool file
 * (`StageWriter` of `temp.ts`). Every write waits for the file (back pressure), so memory stays at one chunk.
 * Nothing here is visible to the user until the writer is committed by the caller.
 */
import { once } from 'node:events'
import { createGzip } from 'node:zlib'
import { ZipWriter } from './zip'
import type { StageWriter } from './temp'
import type { Compression } from './types'

export interface ExportSink {
  /** Opens a file inside the output: a zip entry; for none and gzip the one and only file (only once). */
  begin(entryName: string): Promise<void>
  write(data: string | Uint8Array): Promise<void>
  endEntry(): Promise<void>
  /** Finishes the compression stream. The caller commits or aborts the writer afterwards. */
  finish(): Promise<void>
  /** Bytes written to the spool so far (compressed size). */
  bytes(): number
  destroy(): void
}

/** Thrown by the text sink when the 2 MiB of the text view are full; the caller ends the export cleanly. */
export class TextLimitReached extends Error {
  constructor() {
    super('The text view limit was reached')
    this.name = 'TextLimitReached'
  }
}

const toBuffer = (d: string | Uint8Array): Buffer =>
  typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d.buffer, d.byteOffset, d.byteLength)

/** Longest prefix of `buf` of at most `max` bytes that does not end inside a UTF-8 sequence. */
export function utf8Prefix(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf
  let end = max
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--
  return buf.subarray(0, end)
}

class PlainSink implements ExportSink {
  private begun = false
  private written = 0
  truncated = false
  constructor(
    private writer: StageWriter,
    private textLimit?: number,
  ) {}

  async begin(): Promise<void> {
    if (this.begun) throw new Error('A plain or gzip export holds one file')
    this.begun = true
  }

  async write(data: string | Uint8Array): Promise<void> {
    let buf = toBuffer(data)
    if (this.textLimit !== undefined) {
      const room = this.textLimit - this.written
      if (buf.length > room) {
        buf = utf8Prefix(buf, room)
        if (buf.length > 0) await this.writer.write(buf)
        this.written += buf.length
        this.truncated = true
        throw new TextLimitReached()
      }
    }
    this.written += buf.length
    if (buf.length > 0) await this.writer.write(buf)
  }

  async endEntry(): Promise<void> {}
  async finish(): Promise<void> {}
  bytes(): number {
    return this.writer.bytes
  }
  destroy(): void {}
}

class GzipSink implements ExportSink {
  private gz = createGzip({ level: 6 })
  private begun = false
  private pump: Promise<void>

  constructor(private writer: StageWriter) {
    this.pump = (async () => {
      for await (const chunk of this.gz) await writer.write(chunk as Buffer)
    })()
    // A failure is rethrown by the next write or by finish; never an unhandled rejection.
    this.pump.catch(() => this.gz.destroy())
  }

  async begin(): Promise<void> {
    if (this.begun) throw new Error('A plain or gzip export holds one file')
    this.begun = true
  }

  async write(data: string | Uint8Array): Promise<void> {
    const buf = toBuffer(data)
    if (buf.length === 0) return
    if (!this.gz.write(buf)) await Promise.race([once(this.gz, 'drain'), this.pump])
  }

  async endEntry(): Promise<void> {}

  async finish(): Promise<void> {
    this.gz.end()
    await this.pump
  }

  bytes(): number {
    return this.writer.bytes
  }

  destroy(): void {
    this.gz.destroy()
  }
}

class ZipSink implements ExportSink {
  private queue: Uint8Array[] = []
  private zip = new ZipWriter((chunk) => this.queue.push(chunk))
  private open = false

  constructor(private writer: StageWriter) {}

  private async drain(): Promise<void> {
    while (this.queue.length > 0) await this.writer.write(this.queue.shift() as Uint8Array)
  }

  async begin(entryName: string): Promise<void> {
    this.zip.begin(entryName)
    this.open = true
    await this.drain()
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (!this.open) throw new Error('No open zip entry')
    this.zip.write(data)
    await this.drain()
  }

  async endEntry(): Promise<void> {
    if (!this.open) return
    this.zip.endEntry()
    this.open = false
    await this.drain()
  }

  async finish(): Promise<void> {
    this.zip.finish()
    await this.drain()
  }

  bytes(): number {
    return this.writer.bytes
  }

  destroy(): void {
    this.queue = []
  }
}

export function createSink(
  compression: Compression,
  writer: StageWriter,
  opts: { textLimit?: number } = {},
): ExportSink & { truncated?: boolean } {
  if (compression === 'gzip') return new GzipSink(writer)
  if (compression === 'zip') return new ZipSink(writer)
  return new PlainSink(writer, opts.textLimit)
}
