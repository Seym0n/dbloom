/** Client side of `PUT /api/io/upload` (FR-IO-012, FR-IO-025): raw body, progress and abort through XMLHttpRequest. */
import { CSRF_HEADER, CONNECTION_HEADER, getConnectionId, getCsrfToken } from '~/lib/csrf'
import type { IoErrorCode, IoFormat } from '~/server/io/types'
import { IO_ERROR_CODES } from '~/server/io/types'

export const UPLOAD_URL = '/api/io/upload'

const FORMAT_EXT: Record<string, IoFormat> = { sql: 'sql', csv: 'csv', json: 'json' }

export type FileCheck =
  { ok: true; format: IoFormat; compressed: 'none' | 'gzip' | 'zip' } | { ok: false }

/** `.sql`, `.csv`, `.json` and their `.gz` and `.zip` forms, case-insensitive (FR-UIX-076). */
export function checkFileName(name: string): FileCheck {
  const lower = name.toLowerCase()
  let compressed: 'none' | 'gzip' | 'zip' = 'none'
  let base = lower
  if (lower.endsWith('.gz')) {
    compressed = 'gzip'
    base = lower.slice(0, -3)
  } else if (lower.endsWith('.zip')) {
    compressed = 'zip'
    base = lower.slice(0, -4)
  }
  const dot = base.lastIndexOf('.')
  const format = dot >= 0 ? FORMAT_EXT[base.slice(dot + 1)] : undefined
  return format ? { ok: true, format, compressed } : { ok: false }
}

export class UploadError extends Error {
  readonly code: IoErrorCode | 'unsupported_type' | 'network'
  constructor(code: UploadError['code'], message = '') {
    super(message || code)
    this.code = code
  }
}

export type UploadHandle = {
  promise: Promise<{ uploadId: string }>
  abort(): void
}

/** Minimal slice of XMLHttpRequest that the upload needs, so tests can fake it. */
export interface XhrLike {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: unknown): void
  abort(): void
  upload: {
    onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null
  }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  status: number
  responseText: string
}

const isCode = (v: unknown): v is IoErrorCode =>
  typeof v === 'string' && (IO_ERROR_CODES as readonly string[]).includes(v)

type UploadBody = { uploadId?: unknown; error?: { code?: unknown; message?: unknown } }

function parseBody(text: string): UploadBody | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as UploadBody) : null
  } catch {
    return null
  }
}

export function uploadFile(
  file: Pick<File, 'name' | 'size'>,
  options: { format: IoFormat; onProgress?: (loaded: number, total: number) => void },
  makeXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): UploadHandle {
  const xhr = makeXhr()
  const promise = new Promise<{ uploadId: string }>((resolve, reject) => {
    // The display name travels as a query parameter and is only ever metadata on the server (SEC-SAU-304).
    const query = `name=${encodeURIComponent(file.name)}&format=${options.format}`
    xhr.open('PUT', `${UPLOAD_URL}?${query}`)
    const csrf = getCsrfToken()
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf)
    const connection = getConnectionId()
    if (connection) xhr.setRequestHeader(CONNECTION_HEADER, connection)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      const body = parseBody(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300 && typeof body?.uploadId === 'string') {
        resolve({ uploadId: body.uploadId })
        return
      }
      const code = body?.error?.code
      reject(
        new UploadError(
          isCode(code) ? code : xhr.status === 413 ? 'upload_too_large' : 'upload_failed',
          typeof body?.error?.message === 'string' ? body.error.message : '',
        ),
      )
    }
    xhr.onerror = () => reject(new UploadError('network'))
    xhr.onabort = () => reject(new UploadError('cancelled'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}
