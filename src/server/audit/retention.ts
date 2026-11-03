import type { DatabaseSync } from 'node:sqlite'
import { audit } from '../audit'

const DAY_MS = 86_400_000
export const PURGE_BATCH = 1000

export type PurgeResult = { deleted: number; cutoff: number }

/**
 * Retention purge (SPEC/29 FR-AAU-005): the only code path that deletes audit rows. Each batch is one transaction that
 * first raises `site.audit_cutoff` (the delete trigger lets only rows older than it go), then deletes up to `batch`
 * rows. A run that deleted rows writes one `audit.purge` row with the count.
 */
export function purgeAudit(db: DatabaseSync, retentionDays: number, now: number = Date.now(), batch: number = PURGE_BATCH): PurgeResult {
  const cutoff = now - retentionDays * DAY_MS
  const setCutoff = db.prepare(
    `INSERT INTO site (key, value) VALUES ('audit_cutoff', ?1)
     ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(site.value AS INTEGER), CAST(?1 AS INTEGER))`,
  )
  const remove = db.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? ORDER BY id LIMIT ?)')
  let deleted = 0
  for (;;) {
    db.exec('BEGIN IMMEDIATE')
    let n: number
    try {
      setCutoff.run(String(cutoff))
      n = Number(remove.run(cutoff, batch).changes)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    deleted += n
    if (n < batch) break
  }
  if (deleted > 0) audit('audit.purge', { actorKind: 'system', outcome: 'ok', count: deleted, retentionDays, cutoff: new Date(cutoff).toISOString() })
  return { deleted, cutoff }
}
