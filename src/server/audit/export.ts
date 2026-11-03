import type { DatabaseSync } from 'node:sqlite'
import { anonymise } from './anonymise'
import type { ExportFormat } from './formats'
import { EXPORT_ROW_CAP, countAudit, exportBatch, type AuditFilter, type Raw } from './query'

export { EXPORT_FORMATS, type ExportFormat } from './formats'
const BATCH = 1000
const DAY_MS = 86_400_000

export const CSV_COLUMNS = ['id', 'time', 'event', 'outcome', 'actor_id', 'actor_name', 'actor_kind', 'subject', 'address', 'fields'] as const

/** A cell that starts like a formula is prefixed with `'` so a spreadsheet shows it as text (CSV injection). */
export function csvCell(value: string | number | null): string {
  if (value === null) return ''
  let s = String(value)
  if (/^[=+\-@\t\r]/.test(s) && typeof value === 'string') s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const cells = (r: Raw) => [r.id, new Date(r.at).toISOString(), r.event, r.outcome, r.actor_id, r.actor_name, r.actor_kind, r.subject, r.address, r.fields]

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`
}
export function csvLine(r: Raw): string {
  return `${cells(r).map(csvCell).join(',')}\r\n`
}
export function ndjsonLine(r: Raw): string {
  let fields: unknown = {}
  try {
    fields = JSON.parse(r.fields)
  } catch {
    // keep {}
  }
  return `${JSON.stringify({
    id: r.id, time: new Date(r.at).toISOString(), event: r.event, outcome: r.outcome, actor_id: r.actor_id, actor_name: r.actor_name,
    actor_kind: r.actor_kind, subject: r.subject, address: r.address, fields,
  })}\n`
}

/** The filter bounded by the retention window: nothing older than the window leaves the server. */
export function boundFilter(filter: AuditFilter, now: number, retentionDays: number): AuditFilter {
  const floor = now - retentionDays * DAY_MS
  return { ...filter, from: Math.max(filter.from ?? 0, floor) }
}

export type ExportPlan = { filter: AuditFilter; rows: number; truncated: boolean }
export function planExport(db: DatabaseSync, filter: AuditFilter, now: number, retentionDays: number, cap: number = EXPORT_ROW_CAP): ExportPlan {
  const bounded = boundFilter(filter, now, retentionDays)
  const n = countAudit(db, bounded, cap)
  return { filter: bounded, rows: Math.min(n, cap), truncated: n > cap }
}

/** Lines of the export in batches; stops at the cap. Addresses pass through the anonymiser again (a mode change applies to old rows). */
export function* exportLines(db: DatabaseSync, plan: ExportPlan, format: ExportFormat, cap: number = EXPORT_ROW_CAP): Generator<string> {
  if (format === 'csv') yield csvHeader()
  let after = 0
  let sent = 0
  const line = format === 'csv' ? csvLine : ndjsonLine
  while (sent < Math.min(plan.rows, cap)) {
    const batch = exportBatch(db, plan.filter, after, Math.min(BATCH, Math.min(plan.rows, cap) - sent))
    if (batch.length === 0) return
    for (const r of batch) {
      yield line({ ...r, address: anonymise(r.address) })
      sent += 1
      after = r.id
    }
  }
}

/** Pull-based stream: the database is read only while the client keeps reading; cancel stops it. */
export function exportStream(db: DatabaseSync, plan: ExportPlan, format: ExportFormat, cap: number = EXPORT_ROW_CAP): ReadableStream<Uint8Array> {
  const lines = exportLines(db, plan, format, cap)
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      let chunk = ''
      for (let i = 0; i < 200; i++) {
        const next = lines.next()
        if (next.done) {
          if (chunk) controller.enqueue(enc.encode(chunk))
          controller.close()
          return
        }
        chunk += next.value
      }
      controller.enqueue(enc.encode(chunk))
    },
    cancel() {
      lines.return(undefined)
    },
  })
}

export const exportFilename = (format: ExportFormat, now: number) => `dbloom-audit-${new Date(now).toISOString().slice(0, 10)}.${format}`
