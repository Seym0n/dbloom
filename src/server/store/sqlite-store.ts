import { DatabaseSync } from 'node:sqlite'
import type { SessionRecord, Store } from './store'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash      TEXT PRIMARY KEY,
    target_key   TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
`

type Row = {
  id_hash: string
  target_key: string
  user_name: string
  created_at: number
  last_seen_at: number
  expires_at: number
}

export function openSqliteStore(path: string): Store {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)

  const insert = db.prepare(
    'INSERT INTO sessions (id_hash, target_key, user_name, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const select = db.prepare('SELECT * FROM sessions WHERE id_hash = ?')
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?')
  const remove = db.prepare('DELETE FROM sessions WHERE id_hash = ?')
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?')

  return {
    createSession: (r) =>
      void insert.run(r.idHash, r.targetKey, r.userName, r.createdAt, r.lastSeenAt, r.expiresAt),
    getSession(idHash) {
      const row = select.get(idHash) as Row | undefined
      if (!row) return undefined
      return {
        idHash: row.id_hash,
        targetKey: row.target_key,
        userName: row.user_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      } satisfies SessionRecord
    },
    touchSession: (idHash, lastSeenAt) => void touch.run(lastSeenAt, idHash),
    deleteSession: (idHash) => void remove.run(idHash),
    purgeSessions: (before) => Number(purge.run(before).changes),
    close: () => db.close(),
  }
}
