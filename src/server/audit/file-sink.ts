import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { redactText } from '../log'
import { anonymise } from './anonymise'
import { redactAuditFields } from './redact'
import type { AuditEntry, AuditSink } from './sink'

export const FILE_SINK_CAP = 10_000
export const FLUSH_MS = 1000
export const RETRY_MS = 5000

export type FileSinkStatus = {
  sink: 'file'
  state: 'ok' | 'degraded'
  buffered: number
  drops: number
  /** Error code only (for example `EACCES`): no path, no message text. */
  lastError?: string
}

export type FileSinkOptions = {
  path: string
  cap?: number
  flushMs?: number
  retryMs?: number
  /** Called on every state change (the wiring writes an `audit.sink` row). */
  onState?: (status: FileSinkStatus) => void
}

export type FileSink = AuditSink & {
  status(): FileSinkStatus
  /** Writes what is buffered now; used at shutdown and by tests. */
  flush(): void
  close(): void
}

/** One JSON line per event, same shape as stdout plus the anonymised address and actor kind. */
export function fileLine(entry: AuditEntry): string {
  const address = anonymise(typeof entry.fields.address === 'string' ? entry.fields.address : entry.ctx?.address)
  const fields = redactAuditFields(entry.fields)
  if (address !== null) fields.address = redactText(address)
  return `${JSON.stringify({ t: entry.t, audit: entry.event, ...fields })}\n`
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? 'EIO'

/**
 * External file sink (FR-AAU-009): append only, mode 0600, one fsync per batch. `write` only buffers; a timer flushes
 * every second. A failing file keeps the events in memory (cap 10 000, oldest dropped and counted) and is retried every
 * 5 s. Lines already written are not written again.
 */
export function createFileSink(options: FileSinkOptions): FileSink {
  const cap = options.cap ?? FILE_SINK_CAP
  const flushMs = options.flushMs ?? FLUSH_MS
  const retryMs = options.retryMs ?? RETRY_MS
  let fd: number | undefined
  let pending: string[] = []
  let drops = 0
  let state: 'ok' | 'degraded' = 'ok'
  let lastError: string | undefined
  let timer: NodeJS.Timeout | undefined

  const status = (): FileSinkStatus => ({ sink: 'file', state, buffered: pending.length, drops, ...(lastError ? { lastError } : {}) })
  const setState = (next: 'ok' | 'degraded') => {
    if (next === state) return
    state = next
    options.onState?.(status())
  }
  const schedule = (ms: number) => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, ms)
    timer.unref()
  }
  const flush = () => {
    if (pending.length === 0) {
      setState('ok')
      return
    }
    try {
      fd ??= openSync(options.path, 'a', 0o600)
      const data = pending.join('')
      writeSync(fd, data)
      fsyncSync(fd)
      pending = []
      lastError = undefined
      setState('ok')
    } catch (error) {
      lastError = codeOf(error)
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* already unusable */ }
        fd = undefined
      }
      setState('degraded')
      schedule(retryMs)
    }
  }
  return {
    name: 'file',
    write(entry) {
      pending.push(fileLine(entry))
      if (pending.length > cap) {
        const over = pending.length - cap
        pending = pending.slice(over)
        drops += over
      }
      schedule(state === 'degraded' ? retryMs : flushMs)
    },
    status,
    flush,
    close() {
      if (timer) clearTimeout(timer)
      timer = undefined
      flush()
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* ignore */ }
        fd = undefined
      }
    },
  }
}

let active: FileSink | undefined
export function setActiveFileSink(sink: FileSink | undefined): void {
  active = sink
}

/** Status for the viewer banner and the exposure report; stdout-only installs report `ok` with no sink. */
export function auditSinkStatus(): FileSinkStatus | { sink: 'stdout'; state: 'ok' } {
  return active ? active.status() : { sink: 'stdout', state: 'ok' }
}
