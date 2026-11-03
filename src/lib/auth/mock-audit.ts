/**
 * Mock of the audit read functions (SPEC/29 FR-AAU-007, 008). Rows are generated, not stored: 130 rows, newest first by
 * id, alternating actors, so paging and filters are deterministic for the specs. Flags (`dbloom.authMock.flags`):
 * `audit-degraded` (external sink degraded), `audit-table-down` (table writes failing), `step-up-off`.
 */
import type { AuthApi } from './api'
import type { AuditRow, OwnAuditRow } from '~/server/audit/query'

const TOTAL = 130
const EVENTS = ['auth.signin', 'auth.signout', 'user.create', 'sql.run', 'rows.change', 'io.export.start', 'connection.open'] as const
const ACTORS = [
  { id: 'mock-alice', name: 'alice', kind: 'user' },
  { id: 'mock-bob', name: 'bob', kind: 'user' },
  { id: null, name: 'cli', kind: 'cli' },
] as const
const NOW = Date.now()

function rowAt(id: number): AuditRow {
  const event = EVENTS[id % EVENTS.length]!
  const actor = ACTORS[id % ACTORS.length]!
  return {
    id,
    at: NOW - (TOTAL - id) * 3_600_000,
    event,
    outcome: id % 7 === 0 ? 'failed' : 'ok',
    actorId: actor.id,
    actorName: actor.name,
    actorKind: actor.kind,
    subject: `subject-${id}`,
    address: actor.kind === 'cli' ? null : `203.0.113.${id % 250}`,
    fields: { note: `row ${id}`, count: id % 5 },
  }
}
const ALL: AuditRow[] = Array.from({ length: TOTAL }, (_, i) => rowAt(i + 1))

type Deps = { flag: (name: string) => boolean; wait: <T>(v: T) => Promise<T>; needStepUp: () => void; username: () => string }

export function createMockAuditApi(d: Deps): Pick<AuthApi, 'listAuditEvents' | 'listOwnAuditEvents' | 'getAuditStatus' | 'startAuditExport'> {
  const match = (r: AuditRow, f: Parameters<AuthApi['listAuditEvents']>[0]) =>
    (f.from === undefined || r.at >= f.from) &&
    (f.to === undefined || r.at < f.to) &&
    (!f.eventPrefix || r.event.startsWith(f.eventPrefix)) &&
    (!f.actor || r.actorId === f.actor || r.actorName === f.actor) &&
    (!f.outcome || r.outcome === f.outcome) &&
    (!f.text || (r.subject ?? '').includes(f.text))
  return {
    listAuditEvents: async (f) => {
      const limit = Math.min(200, f.limit ?? 50)
      const rows = ALL.filter((r) => (f.before === undefined || r.id < f.before) && match(r, f)).sort((a, b) => b.id - a.id)
      const page = rows.slice(0, limit)
      return d.wait({ rows: page, next: rows.length > limit ? page[page.length - 1]!.id : null })
    },
    listOwnAuditEvents: async (o) => {
      const limit = Math.min(200, o.limit ?? 50)
      const mine = ALL.filter((r) => r.actorName === d.username() && (o.before === undefined || r.id < o.before)).sort((a, b) => b.id - a.id)
      const page = mine.slice(0, limit).map(({ id, at, event, outcome, subject, address }): OwnAuditRow => ({ id, at, event, outcome, subject, address }))
      return d.wait({ rows: page, next: mine.length > limit ? page[page.length - 1]!.id : null })
    },
    getAuditStatus: async () =>
      d.wait({
        mode: 'account' as const,
        table: true,
        tableFailures: d.flag('audit-table-down') ? 3 : 0,
        sink: d.flag('audit-degraded')
          ? { sink: 'file' as const, state: 'degraded' as const, buffered: 42, drops: 0, lastError: 'EACCES' }
          : { sink: 'stdout' as const, state: 'ok' as const },
        events: [...EVENTS],
      }),
    startAuditExport: async (input) => {
      d.needStepUp()
      const rows = ALL.filter((r) => match(r, input)).length
      return d.wait({ token: 'mock-export-token', rows, truncated: false, filename: `dbloom-audit-mock.${input.format}` })
    },
  }
}
