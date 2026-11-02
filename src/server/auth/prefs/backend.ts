import type { DatabaseSync } from 'node:sqlite'

/**
 * Raw `ui_prefs` access of the preferences service (FR-AUT-024). The table is the one rows and io already use
 * (`owner_key, target_key, scope, key, value, updated_at`); this layer adds enumeration per owner, delete and a
 * transaction, which the module stores do not offer. Every statement carries the owner key.
 */
export type PrefRow = { targetKey: string; scope: string; key: string; value: string; updatedAt: number }

export interface PrefsBackend {
  rows(ownerKey: string): PrefRow[]
  put(ownerKey: string, row: PrefRow): void
  remove(ownerKey: string, targetKey: string, scope: string, key: string): void
  /** Removes every preference row of the owner (reset all; deleting a user). */
  removeOwner(ownerKey: string): void
  /** All or nothing; nested calls join the outer one. */
  transaction<T>(fn: () => T): T
}

export function createSqlitePrefsBackend(db: DatabaseSync): PrefsBackend {
  const sel = db.prepare('SELECT target_key, scope, key, value, updated_at FROM ui_prefs WHERE owner_key = ?')
  const upsert = db.prepare(
    `INSERT INTO ui_prefs (owner_key, target_key, scope, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_key, target_key, scope, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  const del = db.prepare('DELETE FROM ui_prefs WHERE owner_key = ? AND target_key = ? AND scope = ? AND key = ?')
  const delOwner = db.prepare('DELETE FROM ui_prefs WHERE owner_key = ?')
  let depth = 0
  return {
    rows(ownerKey) {
      return (sel.all(ownerKey) as { target_key: string; scope: string; key: string; value: string; updated_at: number }[]).map(
        (r) => ({ targetKey: r.target_key, scope: r.scope, key: r.key, value: r.value, updatedAt: r.updated_at }),
      )
    },
    put(ownerKey, r) {
      upsert.run(ownerKey, r.targetKey, r.scope, r.key, r.value, r.updatedAt)
    },
    remove(ownerKey, targetKey, scope, key) {
      del.run(ownerKey, targetKey, scope, key)
    },
    removeOwner(ownerKey) {
      delOwner.run(ownerKey)
    },
    transaction(fn) {
      if (depth > 0) return fn()
      db.exec('BEGIN IMMEDIATE')
      depth++
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        depth--
      }
    },
  }
}

/** Stateless mode (`DBLOOM_STORE=none`): the owner key is the session id hash; bounded, oldest owner dropped. */
export class MemoryPrefsBackend implements PrefsBackend {
  private owners = new Map<string, Map<string, PrefRow>>()
  private depth = 0

  constructor(private maxOwners = 1000) {}

  private id = (r: { targetKey: string; scope: string; key: string }) => `${r.targetKey}\u0000${r.scope}\u0000${r.key}`

  rows(ownerKey: string): PrefRow[] {
    return [...(this.owners.get(ownerKey)?.values() ?? [])].map((r) => ({ ...r }))
  }

  put(ownerKey: string, row: PrefRow): void {
    let o = this.owners.get(ownerKey)
    if (!o) {
      if (this.owners.size >= this.maxOwners) {
        const oldest = this.owners.keys().next().value
        if (oldest !== undefined) this.owners.delete(oldest)
      }
      o = new Map()
      this.owners.set(ownerKey, o)
    }
    o.set(this.id(row), { ...row })
  }

  remove(ownerKey: string, targetKey: string, scope: string, key: string): void {
    this.owners.get(ownerKey)?.delete(this.id({ targetKey, scope, key }))
  }

  removeOwner(ownerKey: string): void {
    this.owners.delete(ownerKey)
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    const snapshot = new Map([...this.owners].map(([k, v]) => [k, new Map(v)]))
    this.depth++
    try {
      return fn()
    } catch (error) {
      this.owners = snapshot
      throw error
    } finally {
      this.depth--
    }
  }
}
