/**
 * Export file names (FR-IO-009, spec 5.5, SEC-IOX-033): template tokens, sanitising, extension chain and the
 * `Content-Disposition` header. Time tokens are UTC so the same request gives the same name on any host.
 */
import { MAX_FILENAME_CHARS } from './types'
import type { Compression, IoFormat } from './types'

export type FileNameContext = {
  server?: string
  database?: string
  table?: string
  columns?: string[]
  httpHost?: string
  now: Date
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Replaces the known tokens; unknown tokens stay as text. */
export function expandTemplate(template: string, ctx: FileNameContext): string {
  const d = ctx.now
  const values: Record<string, string> = {
    SERVER: ctx.server ?? '',
    DATABASE: ctx.database ?? '',
    TABLE: ctx.table ?? '',
    COLUMNS: (ctx.columns ?? []).slice(0, 3).join('-'),
    YEAR: pad(d.getUTCFullYear(), 4),
    MONTH: pad(d.getUTCMonth() + 1),
    DAY: pad(d.getUTCDate()),
    HOUR: pad(d.getUTCHours()),
    MINUTE: pad(d.getUTCMinutes()),
    SECOND: pad(d.getUTCSeconds()),
    HTTP_HOST: ctx.httpHost ?? '',
  }
  return template.replace(/@([A-Z_]+)@/g, (m, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : m,
  )
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** NFC; letters, marks, digits, `_`, `-` and `.` survive; no leading dot; at most 120 characters; empty is `export`. */
export function sanitizeFileName(input: string, maxChars = MAX_FILENAME_CHARS): string {
  let s = input.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_.-]/gu, '_')
  s = s.replace(/^\.+/, '')
  s = Array.from(s).slice(0, maxChars).join('')
  s = s.replace(/\.+$/, '')
  if (s === '') return 'export'
  if (RESERVED_WINDOWS.test(s)) s = '_' + s
  return s
}

const FORMAT_EXT: Record<IoFormat, string> = { sql: '.sql', csv: '.csv', json: '.json' }
const COMPRESSION_EXT: Record<Compression, string> = { none: '', gzip: '.gz', zip: '.zip' }

export type ExportFileNames = {
  /** Name of the content: `x.sql`; the entry name inside a zip. */
  entryName: string
  /** Name of the download: `x.sql`, `x.sql.gz` or `x.sql.zip`. */
  downloadName: string
}

/** Template (or default) to final names; the format extension is added only when missing. */
export function buildFileNames(
  template: string,
  ctx: FileNameContext,
  format: IoFormat,
  compression: Compression,
): ExportFileNames {
  let stem = sanitizeFileName(expandTemplate(template, ctx))
  const ext = FORMAT_EXT[format]
  if (!stem.toLowerCase().endsWith(ext)) stem += ext
  return { entryName: stem, downloadName: stem + COMPRESSION_EXT[compression] }
}

export const DEFAULT_TEMPLATES = {
  table: '@TABLE@_@DATABASE@',
  database: '@DATABASE@',
  server: '@SERVER@',
  result: 'export',
} as const

export function contentTypeFor(format: IoFormat, compression: Compression): string {
  if (compression === 'gzip') return 'application/gzip'
  if (compression === 'zip') return 'application/zip'
  if (format === 'sql') return 'application/sql'
  if (format === 'csv') return 'text/csv; charset=utf-8'
  return 'application/json'
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>` for any input, hostile or not. */
export function contentDisposition(name: string): string {
  const clean = Array.from(name.normalize('NFC'))
    .filter((c) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(c))
    .join('')
    .replace(/[\\/"]/g, '_')
  const base = clean === '' ? 'export' : clean
  const ascii = base.replace(/[^A-Za-z0-9._-]/g, '_')
  const encoded = encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
