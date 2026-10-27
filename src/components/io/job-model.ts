/** Pure helpers for progress and errors of io jobs (FR-IO-001, 010, 012; UI-ISS-001). */
import type { MessageKey } from '~/i18n'
import { t } from '~/i18n'
import type { IoError, IoErrorCode, JobProgress, JobState } from '~/server/io/types'
import { IO_ERROR_CODES } from '~/server/io/types'

/** One translated text per closed error code; the server's own text is shown separately, as plain text. */
export const ERROR_KEYS: Record<IoErrorCode, MessageKey> = {
  busy: 'io.error.busy',
  read_only: 'io.error.read_only',
  format_disabled: 'io.error.format_disabled',
  invalid_request: 'io.error.invalid_request',
  upload_too_large: 'io.error.upload_too_large',
  upload_interrupted: 'io.error.upload_interrupted',
  upload_empty: 'io.error.upload_empty',
  quota_full: 'io.error.quota_full',
  upload_failed: 'io.error.upload_failed',
  upload_unknown: 'io.error.upload_unknown',
  not_archive: 'io.error.not_archive',
  archive_not_allowed: 'io.error.archive_not_allowed',
  decompressed_too_large: 'io.error.decompressed_too_large',
  ratio_exceeded: 'io.error.ratio_exceeded',
  charset_unsupported: 'io.error.charset_unsupported',
  invalid_bytes: 'io.error.invalid_bytes',
  needs_database: 'io.error.needs_database',
  confirm_required: 'io.error.confirm_required',
  confirm_invalid: 'io.error.confirm_invalid',
  refused_statement: 'io.error.refused_statement',
  statement_failed: 'io.error.statement_failed',
  row_rejected: 'io.error.row_rejected',
  export_too_large: 'io.error.export_too_large',
  export_failed: 'io.error.export_failed',
  time_limit: 'io.error.time_limit',
  file_gone: 'io.error.file_gone',
  not_enabled: 'io.error.not_enabled',
  path_refused: 'io.error.path_refused',
  cancelled: 'io.error.cancelled',
}

export const isIoCode = (v: unknown): v is IoErrorCode =>
  typeof v === 'string' && (IO_ERROR_CODES as readonly string[]).includes(v)

/** Text for a code, with the effective upload limit when the message needs it. */
export function codeMessage(code: string, limit?: string): string {
  if (code === 'unsupported_type') return t('io.error.unsupported_type')
  if (code === 'network') return t('io.error.network')
  if (!isIoCode(code)) return t('io.error.unknown')
  return code === 'upload_too_large' && limit
    ? t('io.error.upload_too_large_limit', { limit })
    : t(ERROR_KEYS[code])
}

/** A thrown server error (`code: message`) as text; unknown codes fall back to a generic line, never raw text. */
export function describeIoFailure(error: unknown): { code: string | null; message: string } {
  const raw = error instanceof Error ? error.message : ''
  const match = /^([a-z][a-z_]*)(?:@\d+)?: ([\s\S]*)$/.exec(raw)
  const code = match?.[1]
  if (code && (isIoCode(code) || code === 'unsupported_type')) {
    // An invalid byte names its place, so the user can find it in the file (FR-IO-015).
    const at =
      code === 'invalid_bytes' ? /byte (\d+)(?: \(line (\d+)\))?/.exec(match?.[2] ?? '') : null
    const where = at
      ? ` (${t('io.error.offset', { n: at[1] ?? '' })}${at[2] ? `, ${t('io.error.line', { n: at[2] })}` : ''})`
      : ''
    return { code, message: codeMessage(code) + where }
  }
  return { code: code ?? null, message: t('io.error.unknown') }
}

export const describeIoError = (error: IoError): string => codeMessage(error.code)

/** 0..1 of the whole job, or undefined when the total is unknown (then the bar is indeterminate). */
export function fraction(progress: JobProgress): number | undefined {
  if (!progress.totalBytes || progress.totalBytes <= 0) return undefined
  return Math.max(0, Math.min(1, progress.bytes / progress.totalBytes))
}

export function percentText(progress: JobProgress): string | undefined {
  const f = fraction(progress)
  return f === undefined ? undefined : `${Math.floor(f * 100)}%`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - m * 60)} s`
}

export const STATE_KEYS: Record<JobState, MessageKey> = {
  queued: 'io.state.queued',
  running: 'io.state.running',
  paused: 'io.state.paused',
  done: 'io.state.done',
  done_with_skips: 'io.state.done_with_skips',
  done_with_rejects: 'io.state.done_with_rejects',
  failed: 'io.state.failed',
  cancelled: 'io.state.cancelled',
}

/** Done states that are not plain success carry a warning tone. */
export const stateTone = (s: JobState): 'neutral' | 'warning' | 'negative' | 'positive' =>
  s === 'done'
    ? 'positive'
    : s === 'done_with_skips' || s === 'done_with_rejects' || s === 'paused'
      ? 'warning'
      : s === 'failed'
        ? 'negative'
        : 'neutral'
