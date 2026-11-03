import type { DatabaseSync } from 'node:sqlite'
import { auditRequiredIn } from '../audit'
import { EXPORT_FORMATS, exportLines, planExport, type ExportFormat } from './export'
import type { AuditFilter } from './query'

export const AUDIT_CLI_USAGE = `  audit export [--since <date>] [--until <date>] [--format csv|ndjson]
                               write the audit log to stdout (default format ndjson)`

/** `--since 2026-10-01` or a full ISO time; undefined when not parseable. */
function parseTime(text: string): number | undefined {
  const t = Date.parse(text)
  return Number.isFinite(t) ? t : undefined
}

/**
 * `dbloom audit export`: the operator on the host exports what an administrator could (same trust as the other CLI
 * commands, FR-AAU-008). The `audit.export` row with kind `cli` is committed before the first line is written; if it
 * cannot be written, nothing is exported.
 */
export function auditExportCommand(
  args: string[],
  db: DatabaseSync,
  write: (s: string) => void,
  retentionDays: number,
  now: number = Date.now(),
): number {
  const [sub, ...rest] = args
  if (sub !== 'export') return 2
  const filter: AuditFilter = {}
  let format: ExportFormat = 'ndjson'
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (value === undefined) return 2
    if (flag === '--since') {
      const t = parseTime(value)
      if (t === undefined) return 2
      filter.from = t
    } else if (flag === '--until') {
      const t = parseTime(value)
      if (t === undefined) return 2
      filter.to = t
    } else if (flag === '--format' && (EXPORT_FORMATS as readonly string[]).includes(value)) {
      format = value as ExportFormat
    } else return 2
  }
  const plan = planExport(db, filter, now, retentionDays)
  try {
    auditRequiredIn(db, 'audit.export', {
      actor: 'cli', actorKind: 'cli', outcome: 'ok', format, rows: plan.rows, truncated: plan.truncated, filter: JSON.stringify(plan.filter),
    })()
  } catch {
    process.stderr.write('Audit log is not writable; nothing exported.\n')
    return 1
  }
  for (const line of exportLines(db, plan, format)) write(line)
  return 0
}
