import type { DatabaseSync } from 'node:sqlite'
import { redactText } from '../log'
import { anonymise } from './anonymise'
import { redactAuditFields } from './redact'
import type { AuditEntry, AuditSink } from './sink'

/** Per-event cap for the stored `fields` JSON (SPEC/29 section 4.3). */
export const FIELDS_CAP_BYTES = 8 * 1024

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Call-site fields that have their own column; everything else stays in `fields`. */
const COLUMN_FIELDS = new Set(['outcome', 'subject', 'address', 'user', 'actor', 'actorKind'])

/** JSON of the redacted fields, truncated with a marker when over the cap. */
export function boundedFieldsJson(fields: Record<string, unknown>): string {
  const json = JSON.stringify(redactAuditFields(fields))
  if (Buffer.byteLength(json) <= FIELDS_CAP_BYTES) return json
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json), keys: Object.keys(fields).slice(0, 40) })
}

export type ActorKind = 'user' | 'system' | 'cli' | 'anonymous'

/** Call sites say `actor` (a user id, or the literals `cli` and `setup`), `actorKind`, or `user` (direct-mode name). */
/** Events about the signed-in user's own account name that user in `subject` and no `actor` (`auth.signin`, `account.factor`, ...). */
const SELF_SUBJECT = /^(auth|account|session)\./

function actorOf(f: AuditEntry['fields'], event: string, hasRequest: boolean): { id: string | null; name: string | null; kind: ActorKind } {
  const actor = str(f.actor)
  const kindHint = str(f.actorKind)
  if (kindHint === 'cli' || actor === 'cli') return { id: null, name: 'cli', kind: 'cli' }
  if (kindHint === 'setup' || kindHint === 'system' || actor === 'setup' || actor === 'system') return { id: null, name: actor ?? 'system', kind: 'system' }
  const direct = str(f.user)
  if (direct) return { id: str(f.userId), name: direct, kind: 'user' }
  const id = actor ?? (SELF_SUBJECT.test(event) ? str(f.subject) : null) ?? str(f.userId)
  if (id) return { id, name: null, kind: 'user' }
  return { id: null, name: null, kind: hasRequest ? 'anonymous' : 'system' }
}

export type StoreWriter = { insert(entry: AuditEntry): void }

const writers = new WeakMap<DatabaseSync, StoreWriter>()

/** Prepared insert for one handle; throws on failure. `actor_name` is a snapshot looked up from `users` when only an id is known. */
export function storeWriterFor(db: DatabaseSync, now: () => number = Date.now): StoreWriter {
  const cached = writers.get(db)
  if (cached) return cached
  const insertRow = db.prepare(
    'INSERT INTO audit_log (at, event, outcome, actor_id, actor_name, actor_kind, subject, address, fields) VALUES (?,?,?,?,?,?,?,?,?)',
  )
  const nameOf = db.prepare('SELECT username FROM users WHERE id = ?')
  const writer: StoreWriter = {
    insert(entry) {
      const f = entry.fields
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(f)) if (!COLUMN_FIELDS.has(k) && v !== undefined) rest[k] = v
      const who = actorOf(f, entry.event, entry.ctx?.address !== undefined)
      let name = who.name
      if (name === null && who.id !== null) name = (nameOf.get(who.id) as { username: string } | undefined)?.username ?? null
      const at = Date.parse(entry.t)
      const text = (v: string | null) => (v === null ? null : redactText(v))
      insertRow.run(
        Number.isFinite(at) ? at : now(),
        entry.event,
        text(str(f.outcome)),
        text(who.id),
        text(name),
        who.kind,
        text(str(f.subject)),
        text(anonymise(str(f.address) ?? entry.ctx?.address)),
        boundedFieldsJson(rest),
      )
    },
  }
  writers.set(db, writer)
  return writer
}

/** The `audit_log` table as a sink. Throws on a failed insert; the registry counts it. */
export function createStoreSink(db: DatabaseSync, now: () => number = Date.now, name = 'store'): AuditSink {
  const writer = storeWriterFor(db, now)
  return { name, write: (entry) => writer.insert(entry) }
}
