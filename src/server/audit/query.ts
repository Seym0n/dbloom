import type { DatabaseSync } from 'node:sqlite'

export const PAGE_DEFAULT = 50
export const PAGE_CAP = 200
export const OWN_WINDOW_DAYS = 90

export type AuditFilter = {
  /** Epoch ms, inclusive. */
  from?: number
  /** Epoch ms, exclusive. */
  to?: number
  /** Event name prefix, e.g. `user.` or `sql.run`. */
  eventPrefix?: string
  /** Matches actor id or actor name exactly. */
  actor?: string
  outcome?: string
  /** Substring of the subject. */
  text?: string
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type AuditRow = {
  id: number
  at: number
  event: string
  outcome: string | null
  actorId: string | null
  actorName: string | null
  actorKind: string
  subject: string | null
  address: string | null
  fields: { [key: string]: Json }
}
export type OwnAuditRow = Pick<AuditRow, 'id' | 'at' | 'event' | 'outcome' | 'subject' | 'address'>
export type Page<T> = { rows: T[]; /** Pass as `before` for the next page; null on the last. */ next: number | null }

const clampLimit = (n: number | undefined) => Math.min(PAGE_CAP, Math.max(1, Math.trunc(n ?? PAGE_DEFAULT)))
const escapeLike = (s: string) => s.replace(/[!%_]/g, (c) => `!${c}`)

export type Raw = { id: number; at: number; event: string; outcome: string | null; actor_id: string | null; actor_name: string | null; actor_kind: string; subject: string | null; address: string | null; fields: string }

function parseFields(text: string): { [key: string]: Json } {
  try {
    const v = JSON.parse(text) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as { [key: string]: Json }) : {}
  } catch {
    return {}
  }
}

function where(filter: AuditFilter, before: number | undefined): { sql: string; args: (string | number)[] } {
  const parts: string[] = []
  const args: (string | number)[] = []
  if (before !== undefined) { parts.push('id < ?'); args.push(before) }
  if (filter.from !== undefined) { parts.push('at >= ?'); args.push(filter.from) }
  if (filter.to !== undefined) { parts.push('at < ?'); args.push(filter.to) }
  if (filter.eventPrefix) { parts.push(`event LIKE ? ESCAPE '!'`); args.push(`${escapeLike(filter.eventPrefix)}%`) }
  if (filter.actor) { parts.push('(actor_id = ? OR actor_name = ?)'); args.push(filter.actor, filter.actor) }
  if (filter.outcome) { parts.push('outcome = ?'); args.push(filter.outcome) }
  if (filter.text) { parts.push(`subject LIKE ? ESCAPE '!'`); args.push(`%${escapeLike(filter.text)}%`) }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

/** Newest first, keyset paged by id (ids grow with time, so the order is stable while rows are appended). */
export function queryAudit(db: DatabaseSync, filter: AuditFilter = {}, opts: { before?: number; limit?: number } = {}): Page<AuditRow> {
  const limit = clampLimit(opts.limit)
  const w = where(filter, opts.before)
  const raw = db.prepare(`SELECT * FROM audit_log ${w.sql} ORDER BY id DESC LIMIT ?`).all(...w.args, limit + 1) as Raw[]
  const page = raw.slice(0, limit)
  return {
    rows: page.map((r) => ({
      id: r.id, at: r.at, event: r.event, outcome: r.outcome, actorId: r.actor_id, actorName: r.actor_name,
      actorKind: r.actor_kind, subject: r.subject, address: r.address, fields: parseFields(r.fields),
    })),
    next: raw.length > limit ? page[page.length - 1]!.id : null,
  }
}

/** A user's own events of the last 90 days with the reduced columns (FR-AAU-008). */
export function queryOwnEvents(db: DatabaseSync, userId: string, now: number, opts: { before?: number; limit?: number } = {}): Page<OwnAuditRow> {
  const limit = clampLimit(opts.limit)
  const since = now - OWN_WINDOW_DAYS * 86_400_000
  const args: (string | number)[] = [userId, since]
  let beforeSql = ''
  if (opts.before !== undefined) { beforeSql = 'AND id < ?'; args.push(opts.before) }
  const raw = db.prepare(`SELECT id, at, event, outcome, subject, address FROM audit_log WHERE actor_id = ? AND at >= ? ${beforeSql} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1) as OwnAuditRow[]
  const page = raw.slice(0, limit)
  return { rows: page, next: raw.length > limit ? page[page.length - 1]!.id : null }
}

export const EXPORT_ROW_CAP = 1_000_000

/** Rows matching `filter` up to `cap + 1` (so a caller can tell "more than the cap"). */
export function countAudit(db: DatabaseSync, filter: AuditFilter, cap: number = EXPORT_ROW_CAP): number {
  const w = where(filter, undefined)
  const r = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM audit_log ${w.sql} LIMIT ?)`).get(...w.args, cap + 1) as { n: number }
  return r.n
}

/** Oldest first batch after `afterId`, for streamed exports (no JSON parsing, `fields` stays text). */
export function exportBatch(db: DatabaseSync, filter: AuditFilter, afterId: number, size: number): Raw[] {
  const w = where(filter, undefined)
  const sql = w.sql ? `${w.sql} AND id > ?` : 'WHERE id > ?'
  return db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY id ASC LIMIT ?`).all(...w.args, afterId, size) as Raw[]
}
