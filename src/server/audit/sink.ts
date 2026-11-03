/**
 * Audit sink registry (SPEC/29 FR-AAU-002). Every event goes to every registered sink. The default is the stdout JSON
 * line, unchanged since the first version: operators rely on its format. A sink that throws never throws into the
 * caller; failures are counted and logged at most once a minute.
 */
import { redactAuditFields } from './redact'

export type AuditFields = Record<string, string | number | boolean | undefined>

export type AuditEntry = {
  /** ISO time of the event. */
  t: string
  event: string
  fields: AuditFields
  /** Request context filled by the writer (not part of the stdout line): the effective client address. */
  ctx?: { address?: string }
}

export interface AuditSink {
  name: string
  write(entry: AuditEntry): void
}

/** One JSON line per event on stdout. `console.log` is read at call time: the CLI redirects it to stderr. */
export const stdoutSink: AuditSink = {
  name: 'stdout',
  write(entry) {
    console.log(JSON.stringify({ t: entry.t, audit: entry.event, ...redactAuditFields(entry.fields) }))
  },
}

let sinks: AuditSink[] = [stdoutSink]
const failures = new Map<string, { count: number; lastLoggedAt: number }>()
const LOG_EVERY_MS = 60_000

export function addSink(sink: AuditSink): void {
  sinks = [...sinks.filter((s) => s.name !== sink.name), sink]
}

export function removeSink(name: string): void {
  sinks = sinks.filter((s) => s.name !== name)
}

export function listSinks(): readonly AuditSink[] {
  return sinks
}

/** Test helper: back to the stdout sink only, failure counters cleared. */
export function resetSinks(): void {
  sinks = [stdoutSink]
  failures.clear()
}

/** Failure count per sink since start (shown by the viewer banner later). */
export function sinkFailures(): Record<string, number> {
  return Object.fromEntries([...failures].map(([name, f]) => [name, f.count]))
}

export function dispatch(entry: AuditEntry, now: number = Date.now()): void {
  for (const sink of sinks) {
    try {
      sink.write(entry)
    } catch (error) {
      const f = failures.get(sink.name) ?? { count: 0, lastLoggedAt: 0 }
      f.count += 1
      if (now - f.lastLoggedAt >= LOG_EVERY_MS) {
        f.lastLoggedAt = now
        // Not through `log`: keep this module free of imports so it can be used from every process (server, CLI).
        process.stderr.write(
          `${JSON.stringify({ t: new Date(now).toISOString(), level: 'error', msg: 'audit.sink_failed', sink: sink.name, failures: f.count, error: error instanceof Error ? error.message : 'failed' })}\n`,
        )
      }
      failures.set(sink.name, f)
    }
  }
}
