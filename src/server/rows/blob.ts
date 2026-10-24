import { createHash, randomBytes } from 'node:crypto'
import type { PreviewType } from './types'

/**
 * Binary values of module rows (FR-ROW-012): one-time download handles, upload staging, magic-byte sniffing.
 * Nothing here holds a whole stored value: a handle holds the address of a cell, bytes are read in chunks
 * when the route streams them.
 */

export const HANDLE_TTL_MS = 60_000
export const UPLOAD_TTL_MS = 10 * 60_000
export const SESSION_UPLOAD_BYTES = 32 * 1024 * 1024
/** Preview and "image or pdf" size cap (Q6). */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024

// ---- Magic bytes -----------------------------------------------------------------------------------------------

/** The five previewable types, by their first bytes; everything else (SVG, HTML, text) is `undefined`. */
export function sniffPreviewType(head: Uint8Array): PreviewType | undefined {
  const b = head
  const at = (i: number) => b[i] ?? -1
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'png'
  }
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg'
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return 'gif'
  }
  if (
    b.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'webp'
  }
  if (b.length >= 5 && at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) {
    return 'pdf'
  }
  return undefined
}

export const CONTENT_TYPES: Record<PreviewType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

const EXTENSIONS: Record<PreviewType, string> = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  pdf: 'pdf',
}

/** `table-column.ext` with everything but letters, digits, `_` and `-` removed (no path, no quote, no CR LF). */
export function safeFileName(table: string, column: string, type?: PreviewType): string {
  const clean = (s: string) => {
    const t = s
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
    return t.slice(0, 40) || 'x'
  }
  return `${clean(table)}-${clean(column)}.${type ? EXTENSIONS[type] : 'bin'}`
}

// ---- One-time cell handles -------------------------------------------------------------------------------------

export type CellHandle = {
  id: string
  sessionId: string
  db: string
  table: string
  /** Key of the row as the client sent it (guard values); re-checked by the builder when the route reads. */
  key: Record<string, unknown>
  column: string
  size: number
  disposition: 'download' | 'preview'
  previewType?: PreviewType
  fileName: string
  expiresAt: number
}

export type NewCellHandle = Omit<CellHandle, 'id' | 'sessionId' | 'expiresAt'>

/** Ids are random, bound to the session, valid 60 seconds and one use; every failure looks the same. */
export class CellHandleStore {
  private handles = new Map<string, CellHandle>()

  constructor(
    private now: () => number = Date.now,
    private ttlMs = HANDLE_TTL_MS,
    private maxPerSession = 64,
  ) {}

  create(sessionId: string, data: NewCellHandle): CellHandle {
    this.sweep()
    let mine = 0
    for (const h of this.handles.values()) if (h.sessionId === sessionId) mine++
    if (mine >= this.maxPerSession) {
      for (const [id, h] of this.handles) {
        if (h.sessionId === sessionId) {
          this.handles.delete(id)
          break
        }
      }
    }
    const handle: CellHandle = {
      ...data,
      id: randomBytes(24).toString('base64url'),
      sessionId,
      expiresAt: this.now() + this.ttlMs,
    }
    this.handles.set(handle.id, handle)
    return handle
  }

  /** Removes and returns the handle if it belongs to the session and has not expired. */
  take(sessionId: string, id: string): CellHandle | undefined {
    const h = this.handles.get(id)
    if (!h) return undefined
    if (this.now() >= h.expiresAt) {
      this.handles.delete(id)
      return undefined
    }
    if (h.sessionId !== sessionId) return undefined
    this.handles.delete(id)
    return h
  }

  dropSession(sessionId: string): void {
    for (const [id, h] of this.handles) if (h.sessionId === sessionId) this.handles.delete(id)
  }

  sweep(): void {
    const t = this.now()
    for (const [id, h] of this.handles) if (t >= h.expiresAt) this.handles.delete(id)
  }

  get size(): number {
    return this.handles.size
  }
}

// ---- Upload staging --------------------------------------------------------------------------------------------

export type StagedUpload = {
  uploadId: string
  sessionId: string
  bytes: Buffer
  sha256: string
  fileName?: string
  previewType?: PreviewType
  expiresAt: number
}

export class UploadRefusal extends Error {
  constructor(
    public code: 'too-large' | 'session-full',
    message: string,
  ) {
    super(message)
    this.name = 'UploadRefusal'
  }
}

/** Bytes of uploads in session memory: 32 MiB per session, 10 minutes, single use (FR-ROW-012). */
export class UploadStore {
  private uploads = new Map<string, StagedUpload>()

  constructor(
    private now: () => number = Date.now,
    private ttlMs = UPLOAD_TTL_MS,
    private sessionBytes = SESSION_UPLOAD_BYTES,
  ) {}

  private usage(sessionId: string): number {
    let n = 0
    for (const u of this.uploads.values()) if (u.sessionId === sessionId) n += u.bytes.length
    return n
  }

  put(sessionId: string, bytes: Buffer, fileName?: string): StagedUpload {
    this.sweep()
    if (this.usage(sessionId) + bytes.length > this.sessionBytes) {
      throw new UploadRefusal('session-full', 'Too many uploaded files are waiting')
    }
    const upload: StagedUpload = {
      uploadId: randomBytes(24).toString('base64url'),
      sessionId,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(fileName !== undefined ? { fileName } : {}),
      ...(sniffPreviewType(bytes.subarray(0, 16)) !== undefined
        ? { previewType: sniffPreviewType(bytes.subarray(0, 16))! }
        : {}),
      expiresAt: this.now() + this.ttlMs,
    }
    this.uploads.set(upload.uploadId, upload)
    return upload
  }

  /** The upload without removing it (planning and preview); `undefined` for every kind of miss. */
  peek(sessionId: string, uploadId: string): StagedUpload | undefined {
    const u = this.uploads.get(uploadId)
    if (!u) return undefined
    if (this.now() >= u.expiresAt) {
      this.uploads.delete(uploadId)
      return undefined
    }
    return u.sessionId === sessionId ? u : undefined
  }

  /** Removes the upload (a write used it). */
  consume(uploadId: string): void {
    this.uploads.delete(uploadId)
  }

  dropSession(sessionId: string): void {
    for (const [id, u] of this.uploads) if (u.sessionId === sessionId) this.uploads.delete(id)
  }

  sweep(): void {
    const t = this.now()
    for (const [id, u] of this.uploads) if (t >= u.expiresAt) this.uploads.delete(id)
  }

  get size(): number {
    return this.uploads.size
  }
}

export const cellHandles = new CellHandleStore()
export const uploads = new UploadStore()
setInterval(() => {
  cellHandles.sweep()
  uploads.sweep()
}, 60_000).unref()
