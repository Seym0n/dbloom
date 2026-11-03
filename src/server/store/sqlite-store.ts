import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  DAY_MS,
  DEFAULT_STATE_OPTIONS,
  MAX_BOOKMARKS_PER_TARGET,
  SqlStateError,
  applyEntryLimit,
  type SqlStateOptions,
} from '../sql/state'
import { scopeKey, type PrefScope, type PrefValues, type PrefsStore } from '../rows/prefs'
import { MAX_TABLE_SCOPES, PREF_KEYS, type PrefKey } from '../rows/types'
import type {
  Bookmark,
  HistoryEntry,
  HistorySource,
  NewHistoryEntry,
  SqlStateStore,
} from '../sql/types'
import {
  IO_PREF_KEYS,
  checkTemplate,
  IoStoreError,
  type IoPrefKey,
  type IoPrefValues,
  type IoPrefsStore,
  type IoTemplate,
  type IoTemplateStore,
  type TemplateKind,
} from '../io/store'
import { MAX_TEMPLATES } from '../io/types'
import type { SessionRecord, Store } from './store'
import type {
  AccountSessionRecord, AccountStore, AuthSettingKey, LinkTokenRecord, PasskeyRecord,
  ProfileRecord, SettingRow, TotpRecord, User, UserNotice, VaultRecord,
} from '../auth/types'

/** Column shapes of the migration-5 tables as node:sqlite returns them (snake_case). */
type UserRow = {
  id: string; username: string; username_key: string; display_name: string; role: User['role']; status: User['status']
  security_version: number; must_change_password: number; temp_password_expires_at: number | null
  webauthn_user_id: string; created_at: number; updated_at: number; created_by: string; last_sign_in_at: number | null
}
type TokenRow = {
  id: string; kind: LinkTokenRecord['kind']; token_hash: string; user_id: string | null; role: LinkTokenRecord['role']
  created_by: string; created_at: number; expires_at: number; used_at: number | null; revoked_at: number | null
}
type SessionRow = {
  id_hash: string; target_key: string; user_name: string; created_at: number; last_seen_at: number; expires_at: number
  kind: AccountSessionRecord['kind']; user_id: string | null; state: AccountSessionRecord['state']
  mfa_at: number | null; stepup_at: number | null; security_version: number; client_hint: string; address: string
}
type PasskeyRow = {
  id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string; backed_up: number
  uv_initial: number; name: string; created_at: number; last_used_at: number | null
}
type ProfileRow = {
  id: string; user_id: string; name: string; host: string; port: number; tls: ProfileRecord['tls']; options: string
  sealed: string; created_at: number; updated_at: number; last_used_at: number | null
}
type NoticeRow = { id: string; user_id: string; kind: UserNotice['kind']; created_at: number; read_at: number | null; detail: string | null }
type VaultRow = {
  user_id: string; kdf_params: string; kdf_salt: string; wrap_passphrase: string; recovery_salt: string
  wrap_recovery: string; created_at: number; updated_at: number
}

const SESSIONS_SCHEMA = `
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

const SQL_STATE_SCHEMA = `
  CREATE TABLE sql_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key    TEXT NOT NULL,
    target_key   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('user','generated','assistant')),
    db           TEXT,
    sql          TEXT,
    sql_omitted  INTEGER NOT NULL DEFAULT 0,
    statements   INTEGER NOT NULL,
    executed     INTEGER NOT NULL,
    failed_index INTEGER,
    max_class    TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sql_history_owner ON sql_history(owner_key, id DESC);
  CREATE TABLE sql_bookmarks (
    id         TEXT PRIMARY KEY,
    owner_key  TEXT NOT NULL,
    target_key TEXT NOT NULL,
    name       TEXT NOT NULL,
    sql        TEXT NOT NULL,
    db         TEXT,
    shared     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_key, target_key, name)
  ) STRICT;
`

const UI_PREFS_SCHEMA = `
  CREATE TABLE ui_prefs (
    owner_key  TEXT NOT NULL,
    target_key TEXT NOT NULL,
    scope      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, target_key, scope, key)
  ) STRICT;
`

const IO_TEMPLATES_SCHEMA = `
  CREATE TABLE io_templates (
    owner_key    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    name         TEXT NOT NULL,
    options_json TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (owner_key, kind, name)
  ) STRICT;
`

/** Migration n+1 is MIGRATIONS[n]; `PRAGMA user_version` holds the number applied (FR-SQL-020). */
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 1: the skeleton schema, unchanged. Idempotent, because files made before versions existed
  // have the sessions table and user_version 0.
  (db) => db.exec(SESSIONS_SCHEMA),
  // 2: history and bookmarks
  (db) => db.exec(SQL_STATE_SCHEMA),
  // 3: display preferences of module rows (FR-ROW-010, spec 24 section 5.9)
  (db) => db.exec(UI_PREFS_SCHEMA),
  // 4: named export templates of module io (FR-IO-011, spec 25 section 5.9); io defaults use ui_prefs
  (db) => db.exec(IO_TEMPLATES_SCHEMA),
  // 5: account authentication store
  (db) => {
    for (const sql of [
      `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct','account'))`,
      `ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`,
      `ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'full' CHECK (state IN ('pending_mfa','enrol_only','must_change','full'))`,
      `ALTER TABLE sessions ADD COLUMN mfa_at INTEGER`,
      `ALTER TABLE sessions ADD COLUMN stepup_at INTEGER`,
      `ALTER TABLE sessions ADD COLUMN security_version INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN client_hint TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE sessions ADD COLUMN address TEXT NOT NULL DEFAULT ''`,
    ]) db.exec(sql)
    db.exec(`
      CREATE TABLE IF NOT EXISTS site (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), status TEXT NOT NULL CHECK(status IN ('active','disabled')),
        security_version INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0,
        temp_password_expires_at INTEGER, webauthn_user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, created_by TEXT NOT NULL, last_sign_in_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS passwords (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, phc TEXT NOT NULL, changed_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key BLOB NOT NULL,
        counter INTEGER NOT NULL, transports TEXT NOT NULL, backed_up INTEGER NOT NULL, uv_initial INTEGER NOT NULL,
        name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS totp (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sealed TEXT NOT NULL, last_step INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS recovery_codes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_mac TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,code_mac)) STRICT;
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('invite','recovery')), token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE, role TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS vaults (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, kdf_params TEXT NOT NULL, kdf_salt TEXT NOT NULL, wrap_passphrase TEXT NOT NULL, recovery_salt TEXT NOT NULL, wrap_recovery TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS connection_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, tls TEXT NOT NULL, options TEXT NOT NULL, sealed TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, UNIQUE(user_id,name)) STRICT;
      CREATE TABLE IF NOT EXISTS user_notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER) STRICT;
    `)
  },
  // 6: audit log (SPEC/29 FR-AAU-001, 006). No foreign key: deleting a user keeps their history. Rows are append-only;
  // the purge sets `site.audit_cutoff` in its transaction, and only rows older than it can be deleted.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT,
        actor_id TEXT, actor_name TEXT, actor_kind TEXT NOT NULL, subject TEXT, address TEXT, fields TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS audit_log_event ON audit_log(event);
      CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id);
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      WHEN OLD.at >= COALESCE((SELECT CAST(value AS INTEGER) FROM site WHERE key = 'audit_cutoff'), 0)
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `)
  },
  // 7: detail of detector notices and the networks an account signed in from (SPEC/30). Prefixes are /24 or /48 only.
  (db) => {
    db.exec(`
      ALTER TABLE user_notices ADD COLUMN detail TEXT;
      CREATE TABLE IF NOT EXISTS seen_locations (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, prefix TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, prefix)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS seen_locations_at ON seen_locations(last_seen_at);
    `)
  },
]

/** Applies pending migrations in one transaction; refuses a database newer than the code. */
export function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  if (current > MIGRATIONS.length) {
    throw new Error(
      `The store has schema version ${current}, newer than this program supports (${MIGRATIONS.length})`,
    )
  }
  if (current === MIGRATIONS.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let i = current; i < MIGRATIONS.length; i++) MIGRATIONS[i]!(db)
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

type Row = {
  id_hash: string
  target_key: string
  user_name: string
  created_at: number
  last_seen_at: number
  expires_at: number
}

export type SqliteStore = Store & {
  accounts: AccountStore
  sql: SqlStateStore
  prefs: PrefsStore
  ioPrefs: IoPrefsStore
  ioTemplates: IoTemplateStore
  /** The open database, for services that bring their own statements (preferences backend). */
  db: DatabaseSync
}

/** Stateless mode (`DBLOOM_STORE=none`): one in-memory `ui_prefs` that the registry, rows and io preference stores share. */
export function createMemoryPrefsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(UI_PREFS_SCHEMA)
  return db
}

export function openSqliteStore(path: string, options: Partial<SqlStateOptions> = {}): SqliteStore {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }

  const userFrom = (r: UserRow): User => ({
    id: r.id, username: r.username, usernameKey: r.username_key, displayName: r.display_name,
    role: r.role, status: r.status, securityVersion: r.security_version,
    mustChangePassword: r.must_change_password === 1, tempPasswordExpiresAt: r.temp_password_expires_at,
    webauthnUserId: r.webauthn_user_id, createdAt: r.created_at, updatedAt: r.updated_at,
    createdBy: r.created_by, lastSignInAt: r.last_sign_in_at,
  })
  const tokenFrom = (r: TokenRow): LinkTokenRecord => ({
    id: r.id, kind: r.kind, tokenHash: r.token_hash, userId: r.user_id, role: r.role, createdBy: r.created_by,
    createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, revokedAt: r.revoked_at,
  })
  const sessionFrom = (r: SessionRow): AccountSessionRecord => ({
    idHash: r.id_hash, targetKey: r.target_key, userName: r.user_name, createdAt: r.created_at,
    lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, kind: r.kind, userId: r.user_id,
    state: r.state, mfaAt: r.mfa_at, stepupAt: r.stepup_at, securityVersion: r.security_version,
    clientHint: r.client_hint, address: r.address,
  })
  const passkeyFrom = (r: PasskeyRow): PasskeyRecord => ({
    id: r.id, userId: r.user_id, publicKey: new Uint8Array(r.public_key), counter: r.counter,
    transports: JSON.parse(r.transports) as PasskeyRecord['transports'], backedUp: !!r.backed_up, uvInitial: !!r.uv_initial,
    name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at,
  })
  const profileFrom = (r: ProfileRow): ProfileRecord => ({
    id: r.id, userId: r.user_id, name: r.name, host: r.host, port: r.port, tls: r.tls,
    options: JSON.parse(r.options) as ProfileRecord['options'], sealed: r.sealed,
    createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at,
  })
  const noticeFrom = (r: NoticeRow): UserNotice => ({ id: r.id, userId: r.user_id, kind: r.kind, createdAt: r.created_at, readAt: r.read_at, ...(r.detail ? { detail: r.detail } : {}) })
  const vaultFrom = (r: VaultRow): VaultRecord => ({
    userId: r.user_id, kdfParams: JSON.parse(r.kdf_params) as VaultRecord['kdfParams'], kdfSalt: r.kdf_salt,
    wrapPassphrase: r.wrap_passphrase, recoverySalt: r.recovery_salt, wrapRecovery: r.wrap_recovery,
    createdAt: r.created_at, updatedAt: r.updated_at,
  })

  function createAccountStore(db: DatabaseSync): AccountStore {
    /** Re-entrant: the outermost call is `BEGIN IMMEDIATE`, nested calls are savepoints (an inner failure rolls back only itself). */
    let depth = 0
    const tx = <T>(fn: () => T): T => {
      const nested = depth > 0
      const name = `sp_${depth}`
      db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE')
      depth++
      try {
        const result = fn()
        depth--
        db.exec(nested ? `RELEASE ${name}` : 'COMMIT')
        return result
      } catch (e) {
        depth--
        db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK')
        throw e
      }
    }
    const one = <T>(query: string, ...params: SQLInputValue[]) => db.prepare(query).get(...params) as unknown as T | undefined
    const many = <T>(query: string, ...params: SQLInputValue[]) => db.prepare(query).all(...params) as unknown as T[]
    const run = (query: string, ...params: SQLInputValue[]) => db.prepare(query).run(...params)
    const count = (query: string, ...params: SQLInputValue[]) => Number(one<{ n: number | bigint }>(query, ...params)?.n ?? 0)
    /** SQLite has no boolean type: 1 and 0. Other values pass through as the driver accepts them. */
    const bind = (v: unknown): SQLInputValue => (typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLInputValue))
    /** `UPDATE <table> SET <column>=?,... WHERE <key>=?` from a patch whose keys map through a fixed column table. */
    const patchRow = (table: string, columns: Record<string, string>, keyColumn: string, key: string, patch: object) => {
      const entries = Object.entries(patch)
      if (!entries.length) return
      const sets = entries.map(([k]) => `${columns[k]}=?`).join(',')
      run(`UPDATE ${table} SET ${sets} WHERE ${keyColumn}=?`, ...entries.map(([, v]) => bind(v)), key)
    }
    const USER_COLUMNS = { displayName: 'display_name', role: 'role', status: 'status', securityVersion: 'security_version', mustChangePassword: 'must_change_password', tempPasswordExpiresAt: 'temp_password_expires_at', updatedAt: 'updated_at', lastSignInAt: 'last_sign_in_at' }
    const PASSKEY_COLUMNS = { counter: 'counter', name: 'name', lastUsedAt: 'last_used_at', backedUp: 'backed_up' }
    const SESSION_COLUMNS = { targetKey: 'target_key', userName: 'user_name', lastSeenAt: 'last_seen_at', expiresAt: 'expires_at', userId: 'user_id', state: 'state', mfaAt: 'mfa_at', stepupAt: 'stepup_at', securityVersion: 'security_version', clientHint: 'client_hint', address: 'address' }
    return {
      transaction: tx,
      getSite: () => Object.fromEntries(many<{ key: string; value: string }>('SELECT key,value FROM site').map((r) => [r.key, JSON.parse(r.value)])),
      setSite: (values) => { for (const [k, v] of Object.entries(values)) run('INSERT INTO site(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v)) },
      getSettings: () => many<{ key: AuthSettingKey; value: string; updated_at: number; updated_by: string }>('SELECT key,value,updated_at,updated_by FROM settings ORDER BY key').map((r): SettingRow => ({ key: r.key, value: r.value, updatedAt: r.updated_at, updatedBy: r.updated_by })),
      setSetting: (r) => void run('INSERT INTO settings(key,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by', r.key, r.value, r.updatedAt, r.updatedBy),
      createUser: (u) => void run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', u.id, u.username, u.usernameKey, u.displayName, u.role, u.status, u.securityVersion, u.mustChangePassword ? 1 : 0, u.tempPasswordExpiresAt, u.webauthnUserId, u.createdAt, u.updatedAt, u.createdBy, u.lastSignInAt),
      getUser: (id) => { const r = one<UserRow>('SELECT * FROM users WHERE id=?', id); return r ? userFrom(r) : undefined },
      getUserByKey: (key) => { const r = one<UserRow>('SELECT * FROM users WHERE username_key=?', key); return r ? userFrom(r) : undefined },
      listUsers: () => many<UserRow & { passkeys: number; recovery: number; totp: number; password: number }>('SELECT u.*, (SELECT count(*) FROM webauthn_credentials w WHERE w.user_id=u.id) passkeys, (SELECT count(*) FROM recovery_codes c WHERE c.user_id=u.id) recovery, EXISTS(SELECT 1 FROM totp t WHERE t.user_id=u.id) totp, EXISTS(SELECT 1 FROM passwords p WHERE p.user_id=u.id) password FROM users u ORDER BY username_key').map((r) => ({ ...userFrom(r), factors: { passkeys: r.passkeys, totp: !!r.totp, recoveryCodes: r.recovery }, hasPassword: !!r.password })),
      updateUser: (id, patch) => patchRow('users', USER_COLUMNS, 'id', id, patch),
      deleteUser: (id) => void run('DELETE FROM users WHERE id=?', id),
      countActiveAdmins: () => count("SELECT count(*) n FROM users WHERE role='admin' AND status='active'"),
      getPassword: (id) => { const r = one<{ user_id: string; phc: string; changed_at: number }>('SELECT user_id,phc,changed_at FROM passwords WHERE user_id=?', id); return r && { userId: r.user_id, phc: r.phc, changedAt: r.changed_at } },
      setPassword: (r) => void run('INSERT INTO passwords VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET phc=excluded.phc,changed_at=excluded.changed_at', r.userId, r.phc, r.changedAt),
      deletePassword: (id) => void run('DELETE FROM passwords WHERE user_id=?', id),
      listPasskeys: (id) => many<PasskeyRow>('SELECT * FROM webauthn_credentials WHERE user_id=? ORDER BY created_at', id).map(passkeyFrom),
      getPasskey: (id) => { const r = one<PasskeyRow>('SELECT * FROM webauthn_credentials WHERE id=?', id); return r && passkeyFrom(r) },
      addPasskey: (r) => void run('INSERT INTO webauthn_credentials VALUES(?,?,?,?,?,?,?,?,?,?)', r.id, r.userId, Buffer.from(r.publicKey), r.counter, JSON.stringify(r.transports), r.backedUp ? 1 : 0, r.uvInitial ? 1 : 0, r.name, r.createdAt, r.lastUsedAt),
      updatePasskey: (id, p) => patchRow('webauthn_credentials', PASSKEY_COLUMNS, 'id', id, p),
      deletePasskey: (uid, id) => run('DELETE FROM webauthn_credentials WHERE user_id=? AND id=?', uid, id).changes === 1,
      deletePasskeys: (uid) => Number(run('DELETE FROM webauthn_credentials WHERE user_id=?', uid).changes),
      getTotp: (id) => { const r = one<{ user_id: string; sealed: string; last_step: number; created_at: number }>('SELECT * FROM totp WHERE user_id=?', id); return r && ({ userId: r.user_id, sealed: r.sealed, lastStep: r.last_step, createdAt: r.created_at } satisfies TotpRecord) },
      setTotp: (r) => void run('INSERT INTO totp VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET sealed=excluded.sealed,last_step=excluded.last_step', r.userId, r.sealed, r.lastStep, r.createdAt),
      advanceTotpStep: (uid, step) => run('UPDATE totp SET last_step=? WHERE user_id=? AND last_step<?', step, uid, step).changes === 1,
      deleteTotp: (uid) => run('DELETE FROM totp WHERE user_id=?', uid).changes === 1,
      replaceRecoveryCodes: (uid, macs, at) => tx(() => { run('DELETE FROM recovery_codes WHERE user_id=?', uid); for (const m of macs) run('INSERT INTO recovery_codes VALUES(?,?,?)', uid, m, at) }),
      consumeRecoveryCode: (uid, mac) => run('DELETE FROM recovery_codes WHERE user_id=? AND code_mac=?', uid, mac).changes === 1,
      countRecoveryCodes: (uid) => count('SELECT count(*) n FROM recovery_codes WHERE user_id=?', uid),
      deleteRecoveryCodes: (uid) => Number(run('DELETE FROM recovery_codes WHERE user_id=?', uid).changes),
      addToken: (r) => void run('INSERT INTO tokens VALUES(?,?,?,?,?,?,?,?,?,?)', r.id, r.kind, r.tokenHash, r.userId, r.role, r.createdBy, r.createdAt, r.expiresAt, r.usedAt, r.revokedAt),
      getTokenByHash: (h) => { const r = one<TokenRow>('SELECT * FROM tokens WHERE token_hash=?', h); return r && tokenFrom(r) },
      listOpenRecoveryTokens: (userId, now) => many<TokenRow>("SELECT * FROM tokens WHERE kind='recovery' AND user_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at", userId, now).map(tokenFrom),
      listOpenInvites: (now) => many<TokenRow>("SELECT * FROM tokens WHERE kind='invite' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at", now).map(tokenFrom),
      markTokenUsed: (id, now, uid) => run('UPDATE tokens SET used_at=?,user_id=COALESCE(?,user_id) WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?', now, uid ?? null, id, now).changes === 1,
      revokeToken: (id, now) => run('UPDATE tokens SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL', now, id).changes === 1,
      purgeTokens: (before) => Number(run('DELETE FROM tokens WHERE expires_at<?', before).changes),
      getVault: (uid) => { const r = one<VaultRow>('SELECT * FROM vaults WHERE user_id=?', uid); return r && vaultFrom(r) },
      setVault: (r) => void run('INSERT INTO vaults VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kdf_params=excluded.kdf_params,kdf_salt=excluded.kdf_salt,wrap_passphrase=excluded.wrap_passphrase,recovery_salt=excluded.recovery_salt,wrap_recovery=excluded.wrap_recovery,updated_at=excluded.updated_at', r.userId, JSON.stringify(r.kdfParams), r.kdfSalt, r.wrapPassphrase, r.recoverySalt, r.wrapRecovery, r.createdAt, r.updatedAt),
      deleteVault: (uid) => void run('DELETE FROM vaults WHERE user_id=?', uid),
      listProfiles: (uid) => many<ProfileRow>('SELECT * FROM connection_profiles WHERE user_id=? ORDER BY name', uid).map(profileFrom),
      getProfile: (uid, id) => { const r = one<ProfileRow>('SELECT * FROM connection_profiles WHERE user_id=? AND id=?', uid, id); return r && profileFrom(r) },
      saveProfile: (r) => void run('INSERT INTO connection_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,tls=excluded.tls,options=excluded.options,sealed=excluded.sealed,updated_at=excluded.updated_at,last_used_at=excluded.last_used_at', r.id, r.userId, r.name, r.host, r.port, r.tls, JSON.stringify(r.options), r.sealed, r.createdAt, r.updatedAt, r.lastUsedAt),
      deleteProfile: (uid, id) => run('DELETE FROM connection_profiles WHERE user_id=? AND id=?', uid, id).changes === 1,
      countProfiles: (uid) => count('SELECT count(*) n FROM connection_profiles WHERE user_id=?', uid),
      addNotice: (n) => void run('INSERT INTO user_notices (id, user_id, kind, created_at, read_at, detail) VALUES(?,?,?,?,?,?)', n.id, n.userId, n.kind, n.createdAt, n.readAt, n.detail ?? null),
      listNotices: (uid) => many<NoticeRow>('SELECT * FROM user_notices WHERE user_id=? ORDER BY created_at DESC', uid).map(noticeFrom),
      markNoticeRead: (uid, id, at) => void run('UPDATE user_notices SET read_at=? WHERE user_id=? AND id=? AND read_at IS NULL', at, uid, id),
      getSeenLocation: (uid, prefix) => one<{ last_seen_at: number }>('SELECT last_seen_at FROM seen_locations WHERE user_id=? AND prefix=?', uid, prefix)?.last_seen_at,
      countSeenLocations: (uid) => one<{ n: number }>('SELECT COUNT(*) AS n FROM seen_locations WHERE user_id=?', uid)?.n ?? 0,
      upsertSeenLocation: (uid, prefix, at) =>
        void run('INSERT INTO seen_locations (user_id, prefix, last_seen_at) VALUES(?,?,?) ON CONFLICT(user_id, prefix) DO UPDATE SET last_seen_at = excluded.last_seen_at', uid, prefix, at),
      purgeSeenLocations: (before) => Number(db.prepare('DELETE FROM seen_locations WHERE last_seen_at < ?').run(before).changes),
      createAccountSession: (r) => void run('UPDATE sessions SET kind=?,user_id=?,state=?,mfa_at=?,stepup_at=?,security_version=?,client_hint=?,address=? WHERE id_hash=?', r.kind, r.userId, r.state, r.mfaAt, r.stepupAt, r.securityVersion, r.clientHint, r.address, r.idHash),
      getAccountSession: (id) => { const r = one<SessionRow>('SELECT * FROM sessions WHERE id_hash=?', id); return r && sessionFrom(r) },
      updateAccountSession: (id, p) => patchRow('sessions', SESSION_COLUMNS, 'id_hash', id, p),
      renameSession: (a, b) => void run('UPDATE sessions SET id_hash=? WHERE id_hash=?', b, a),
      listUserSessions: (uid) => many<SessionRow>('SELECT * FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC', uid).map(sessionFrom),
      deleteUserSessions: (uid, except) => {
        const ex = except ?? null
        const rows = many<{ id_hash: string }>('SELECT id_hash FROM sessions WHERE user_id=? AND (? IS NULL OR id_hash<>?)', uid, ex, ex).map((r) => r.id_hash)
        run('DELETE FROM sessions WHERE user_id=? AND (? IS NULL OR id_hash<>?)', uid, ex, ex)
        return rows
      },
    }
  }
  const sql = createSqliteSqlState(db, { ...DEFAULT_STATE_OPTIONS, ...options })
  const prefs = createSqlitePrefs(db)
  const ioPrefs = createSqliteIoPrefs(db)
  const ioTemplates = createSqliteIoTemplates(db)

  const insert = db.prepare(
    'INSERT INTO sessions (id_hash, target_key, user_name, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const select = db.prepare('SELECT * FROM sessions WHERE id_hash = ?')
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?')
  const remove = db.prepare('DELETE FROM sessions WHERE id_hash = ?')
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?')
  const accounts = createAccountStore(db)

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
    sql,
    prefs,
    ioPrefs,
    ioTemplates,
    accounts,
    db,
    close: () => db.close(),
  }
}

// ---- History and bookmarks --------------------------------------------------------------------------------

type HistoryRow = {
  id: number
  target_key: string
  created_at: number
  source: HistorySource
  db: string | null
  sql: string | null
  sql_omitted: number
  statements: number
  executed: number
  failed_index: number | null
  max_class: HistoryEntry['maxClass']
  outcome: HistoryEntry['outcome']
  duration_ms: number
}

type BookmarkRow = {
  id: string
  target_key: string
  name: string
  sql: string
  db: string | null
  created_at: number
  updated_at: number
}

const toEntry = (r: HistoryRow): HistoryEntry => ({
  id: r.id,
  createdAt: r.created_at,
  source: r.source,
  targetKey: r.target_key,
  db: r.db,
  sql: r.sql,
  sqlOmitted: r.sql_omitted === 1,
  statements: r.statements,
  executed: r.executed,
  failedIndex: r.failed_index,
  maxClass: r.max_class,
  outcome: r.outcome,
  durationMs: r.duration_ms,
})

const toBookmark = (r: BookmarkRow): Bookmark => ({
  id: r.id,
  targetKey: r.target_key,
  name: r.name,
  sql: r.sql,
  db: r.db,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
const exists = () => new SqlStateError('bookmark_exists', 'A bookmark with this name exists')

/**
 * SQLite implementation of `SqlStateStore` (spec 5.8). Every statement carries `owner_key = ?`;
 * values go through prepared statements; no SQL text is placed in a log.
 */
export function createSqliteSqlState(
  db: DatabaseSync,
  opts: SqlStateOptions = DEFAULT_STATE_OPTIONS,
  now: () => number = Date.now,
): SqlStateStore {
  const insertH = db.prepare(
    `INSERT INTO sql_history (owner_key, target_key, created_at, source, db, sql, sql_omitted,
       statements, executed, failed_index, max_class, outcome, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const pruneAge = db.prepare('DELETE FROM sql_history WHERE owner_key = ? AND created_at < ?')
  const pruneCount = db.prepare(
    `DELETE FROM sql_history WHERE owner_key = ? AND id NOT IN
       (SELECT id FROM sql_history WHERE owner_key = ? ORDER BY id DESC LIMIT ?)`,
  )
  const clearH = db.prepare('DELETE FROM sql_history WHERE owner_key = ?')

  const prune = (ownerKey: string, maxEntries: number, maxAgeMs: number, at: number): number => {
    const byAge = Number(pruneAge.run(ownerKey, at - maxAgeMs).changes)
    const byCount = Number(pruneCount.run(ownerKey, ownerKey, Math.max(0, maxEntries)).changes)
    return byAge + byCount
  }

  const selB = db.prepare('SELECT * FROM sql_bookmarks WHERE owner_key = ? AND id = ?')
  const insB = db.prepare(
    `INSERT INTO sql_bookmarks (id, owner_key, target_key, name, sql, db, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const updB = db.prepare(
    'UPDATE sql_bookmarks SET name = ?, sql = ?, db = ?, updated_at = ? WHERE owner_key = ? AND id = ?',
  )
  const countB = db.prepare(
    'SELECT COUNT(*) AS n FROM sql_bookmarks WHERE owner_key = ? AND target_key = ?',
  )
  const listB = db.prepare('SELECT * FROM sql_bookmarks WHERE owner_key = ? ORDER BY name')
  const listBT = db.prepare(
    'SELECT * FROM sql_bookmarks WHERE owner_key = ? AND target_key = ? ORDER BY name',
  )
  const renB = db.prepare(
    'UPDATE sql_bookmarks SET name = ?, updated_at = ? WHERE owner_key = ? AND id = ?',
  )
  const delB = db.prepare('DELETE FROM sql_bookmarks WHERE owner_key = ? AND id = ?')

  const store: SqlStateStore = {
    addHistory(ownerKey, entry: NewHistoryEntry) {
      const limited = applyEntryLimit(entry, opts.historyEntryBytes)
      const r = insertH.run(
        ownerKey,
        entry.targetKey,
        entry.createdAt,
        entry.source,
        entry.db,
        limited.sql,
        limited.sqlOmitted ? 1 : 0,
        entry.statements,
        entry.executed,
        entry.failedIndex,
        entry.maxClass,
        entry.outcome,
        entry.durationMs,
      )
      prune(ownerKey, opts.historyEntries, opts.historyDays * DAY_MS, now())
      return { ...entry, ...limited, id: Number(r.lastInsertRowid) }
    },
    listHistory(ownerKey, o) {
      const where = ['owner_key = ?']
      const args: (string | number)[] = [ownerKey]
      if (o.cursor !== undefined) {
        where.push('id < ?')
        args.push(o.cursor)
      }
      if (o.source !== undefined) {
        where.push('source = ?')
        args.push(o.source)
      }
      if (o.targetKey !== undefined) {
        where.push('target_key = ?')
        args.push(o.targetKey)
      }
      if (o.query !== undefined && o.query !== '') {
        where.push("sql LIKE ? ESCAPE '\\'")
        args.push(`%${escapeLike(o.query)}%`)
      }
      const rows = db
        .prepare(`SELECT * FROM sql_history WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...args, o.limit + 1) as HistoryRow[]
      const entries = rows.slice(0, o.limit).map(toEntry)
      return {
        entries,
        nextCursor: rows.length > o.limit ? entries[entries.length - 1]!.id : null,
      }
    },
    deleteHistory(ownerKey, ids) {
      if (ids.length === 0) return 0
      const marks = ids.map(() => '?').join(',')
      const r = db
        .prepare(`DELETE FROM sql_history WHERE owner_key = ? AND id IN (${marks})`)
        .run(ownerKey, ...ids)
      return Number(r.changes)
    },
    clearHistory: (ownerKey) => Number(clearH.run(ownerKey).changes),
    pruneHistory: (ownerKey, maxEntries, maxAgeMs, at) =>
      prune(ownerKey, maxEntries, maxAgeMs, at ?? now()),
    saveBookmark(ownerKey, b) {
      const at = now()
      try {
        if (b.id !== undefined) {
          if (!selB.get(ownerKey, b.id)) throw new SqlStateError('not_found', 'Not found')
          updB.run(b.name, b.sql, b.db, at, ownerKey, b.id)
          return toBookmark(selB.get(ownerKey, b.id) as BookmarkRow)
        }
        const { n } = countB.get(ownerKey, b.targetKey) as { n: number }
        if (n >= MAX_BOOKMARKS_PER_TARGET) {
          throw new SqlStateError('bookmark_limit', 'Too many bookmarks')
        }
        const id = randomUUID()
        insB.run(id, ownerKey, b.targetKey, b.name, b.sql, b.db, at, at)
        return toBookmark(selB.get(ownerKey, id) as BookmarkRow)
      } catch (error) {
        throw isUnique(error) ? exists() : error
      }
    },
    listBookmarks(ownerKey, o) {
      const rows = (
        o?.targetKey !== undefined ? listBT.all(ownerKey, o.targetKey) : listB.all(ownerKey)
      ) as BookmarkRow[]
      return rows.map(toBookmark)
    },
    renameBookmark(ownerKey, id, name) {
      try {
        const r = renB.run(name, now(), ownerKey, id)
        if (Number(r.changes) === 0) return undefined
        return toBookmark(selB.get(ownerKey, id) as BookmarkRow)
      } catch (error) {
        throw isUnique(error) ? exists() : error
      }
    },
    deleteBookmark: (ownerKey, id) => Number(delB.run(ownerKey, id).changes) > 0,
  }

  // Retention once at start for every owner (spec 5.8).
  const owners = db.prepare('SELECT DISTINCT owner_key FROM sql_history').all() as {
    owner_key: string
  }[]
  for (const o of owners) {
    prune(o.owner_key, opts.historyEntries, opts.historyDays * DAY_MS, now())
  }
  return store
}

// ---- Display preferences ----------------------------------------------------------------------------------

const isPrefKey = (k: string): k is PrefKey => (PREF_KEYS as readonly string[]).includes(k)

/**
 * SQLite implementation of `PrefsStore` (spec 24 section 5.9). Every statement carries
 * `owner_key = ? AND target_key = ?`; at most `MAX_TABLE_SCOPES` table scopes per owner and target,
 * the least recently updated removed on write (FR-CFG-073).
 */
export function createSqlitePrefs(
  db: DatabaseSync,
  now: () => number = Date.now,
  maxTableScopes: number = MAX_TABLE_SCOPES,
): PrefsStore {
  const selScope = db.prepare(
    'SELECT key, value FROM ui_prefs WHERE owner_key = ? AND target_key = ? AND scope = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO ui_prefs (owner_key, target_key, scope, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_key, target_key, scope, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  const prune = db.prepare(
    `DELETE FROM ui_prefs WHERE owner_key = ? AND target_key = ? AND scope <> 'global' AND scope IN (
       SELECT scope FROM (
         SELECT scope, MAX(updated_at) AS u FROM ui_prefs
          WHERE owner_key = ? AND target_key = ? AND scope <> 'global'
          GROUP BY scope ORDER BY u DESC, scope DESC LIMIT -1 OFFSET ?))`,
  )
  const count = db.prepare(
    `SELECT COUNT(DISTINCT scope) AS n FROM ui_prefs
      WHERE owner_key = ? AND target_key = ? AND scope <> 'global'`,
  )

  const read = (ownerKey: string, targetKey: string, scope: string, out: PrefValues) => {
    for (const row of selScope.all(ownerKey, targetKey, scope) as {
      key: string
      value: string
    }[]) {
      if (!isPrefKey(row.key)) continue
      try {
        out[row.key] = JSON.parse(row.value) as unknown
      } catch {
        // a damaged value is treated as absent
      }
    }
  }

  return {
    get(ownerKey, targetKey, table) {
      const out: PrefValues = {}
      read(ownerKey, targetKey, 'global', out)
      if (table) read(ownerKey, targetKey, scopeKey({ kind: 'table', ...table }), out)
      return out
    },
    set(ownerKey, targetKey, scope: PrefScope, key, value) {
      upsert.run(ownerKey, targetKey, scopeKey(scope), key, JSON.stringify(value), now())
      if (scope.kind === 'table') {
        prune.run(ownerKey, targetKey, ownerKey, targetKey, maxTableScopes)
      }
    },
    tableScopeCount(ownerKey, targetKey) {
      return (count.get(ownerKey, targetKey) as { n: number }).n
    },
  }
}

// ---- Module io: defaults and templates --------------------------------------------------------------------

const IO_SCOPE = 'io'
const isIoKey = (k: string): k is IoPrefKey => (IO_PREF_KEYS as readonly string[]).includes(k)

/** `io.*` keys of `ui_prefs` under the scope `io`; every statement carries owner and target (FR-IO-011). */
export function createSqliteIoPrefs(db: DatabaseSync, now: () => number = Date.now): IoPrefsStore {
  const sel = db.prepare(
    'SELECT key, value FROM ui_prefs WHERE owner_key = ? AND target_key = ? AND scope = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO ui_prefs (owner_key, target_key, scope, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_key, target_key, scope, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  return {
    get(ownerKey, targetKey) {
      const out: IoPrefValues = {}
      for (const row of sel.all(ownerKey, targetKey, IO_SCOPE) as {
        key: string
        value: string
      }[]) {
        if (!isIoKey(row.key)) continue
        try {
          out[row.key] = JSON.parse(row.value) as unknown
        } catch {
          // a damaged value is treated as absent
        }
      }
      return out
    },
    set(ownerKey, targetKey, key, value) {
      if (!isIoKey(key)) throw new IoStoreError('invalid-value', 'Unknown preference')
      upsert.run(ownerKey, targetKey, IO_SCOPE, key, JSON.stringify(value), now())
    },
  }
}

type TemplateRow = { kind: TemplateKind; name: string; options_json: string; updated_at: number }

/** SQLite `IoTemplateStore`: at most `MAX_TEMPLATES` per owner and kind, owner in every statement. */
export function createSqliteIoTemplates(
  db: DatabaseSync,
  now: () => number = Date.now,
  maxTemplates: number = MAX_TEMPLATES,
): IoTemplateStore {
  const has = db.prepare(
    'SELECT 1 AS x FROM io_templates WHERE owner_key = ? AND kind = ? AND name = ?',
  )
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM io_templates WHERE owner_key = ? AND kind = ?',
  )
  const upsert = db.prepare(
    `INSERT INTO io_templates (owner_key, kind, name, options_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (owner_key, kind, name)
     DO UPDATE SET options_json = excluded.options_json, updated_at = excluded.updated_at`,
  )
  const listAll = db.prepare('SELECT * FROM io_templates WHERE owner_key = ? ORDER BY kind, name')
  const listKind = db.prepare(
    'SELECT * FROM io_templates WHERE owner_key = ? AND kind = ? ORDER BY name',
  )
  const del = db.prepare('DELETE FROM io_templates WHERE owner_key = ? AND kind = ? AND name = ?')
  const toTemplate = (r: TemplateRow): IoTemplate => ({
    kind: r.kind,
    name: r.name,
    options: JSON.parse(r.options_json) as Record<string, unknown>,
    updatedAt: r.updated_at,
  })
  return {
    save(ownerKey, kind, name, options) {
      const t = checkTemplate(kind, name, options)
      if (!has.get(ownerKey, t.kind, t.name)) {
        const { n } = count.get(ownerKey, t.kind) as { n: number }
        if (n >= maxTemplates) throw new IoStoreError('template-limit', 'Too many templates')
      }
      const at = now()
      upsert.run(ownerKey, t.kind, t.name, JSON.stringify(t.options), at)
      return { ...t, updatedAt: at }
    },
    list(ownerKey, kind) {
      const rows = (kind ? listKind.all(ownerKey, kind) : listAll.all(ownerKey)) as TemplateRow[]
      return rows.map(toTemplate)
    },
    delete: (ownerKey, kind, name) => Number(del.run(ownerKey, kind, name).changes) > 0,
  }
}
