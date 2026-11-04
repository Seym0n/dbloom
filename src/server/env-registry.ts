/**
 * Registry of every environment variable DBLoom reads (FR-SVR-001): name, type, default, range. `owner` names the module
 * that parses the value today. Entries not owned by `config` are registered so the typo guard and the `.env.example`
 * check know them; they keep their own parsing and clamping (moving them would change behaviour).
 * TODO(server): move the auth, sql and rows reads into config.ts once their owners agree on the strictness.
 */

export type VarKind = 'string' | 'bool' | 'int' | 'enum' | 'list' | 'path' | 'secret'
export type EnvVar = {
  name: string
  group: string
  kind: VarKind
  /** Default as written in `.env.example`; empty when none. */
  default: string
  doc: string
  min?: number
  max?: number
  values?: readonly string[]
  /** Module that parses it: `config` (strict here) or the owning module. */
  owner: string
}

type Extra = Partial<Pick<EnvVar, 'min' | 'max' | 'values'>>
const v = (owner: string, group: string, name: string, kind: VarKind, def: string, doc: string, extra: Extra = {}): EnvVar => ({
  owner,
  group,
  name,
  kind,
  default: def,
  doc,
  ...extra,
})

const C = 'config'
const authOverride = (name: string): EnvVar => v('auth', 'Account mode', name, 'string', '', 'Auth setting override (file 26); validated by the auth module.')

export const ENV_VARS: readonly EnvVar[] = [
  v(C, 'Listener', 'DBLOOM_HOST', 'string', '127.0.0.1', 'Bind address. A non-loopback value needs DBLOOM_PUBLIC_ORIGIN and DBLOOM_TRUST_PROXY. The image sets 0.0.0.0.'),
  v(C, 'Listener', 'PORT', 'int', '3000', 'Listen port.', { min: 1, max: 65535 }),
  v(C, 'Listener', 'DBLOOM_PUBLIC_ORIGIN', 'string', '', 'Public origin scheme://host[:port], no path. https unless the host is loopback. Required for account mode and non-loopback bind.'),
  v(C, 'Listener', 'DBLOOM_ALLOWED_HOSTS', 'list', '', 'Comma separated Host values answered (default: host of the origin). Wildcards only on a loopback bind.'),
  v(C, 'Listener', 'DBLOOM_TRUST_PROXY', 'list', '', 'Trusted reverse proxies as CIDR list, e.g. 10.0.0.0/8,172.16.0.0/12. Legacy `true` is accepted with a warning.'),
  v(C, 'Listener', 'DBLOOM_PROXY_HOPS', 'int', '0', 'Optional number of trusted proxy hops in X-Forwarded-For (0 = rightmost untrusted entry).', { min: 0, max: 16 }),
  v(C, 'Listener', 'DBLOOM_TLS', 'enum', 'proxy', 'TLS is terminated by a `proxy`. `own` is reserved and refused.', { values: ['proxy', 'own'] }),
  v(C, 'Listener', 'DBLOOM_HSTS', 'enum', 'on', 'Strict-Transport-Security on https origins. `off` is allowed with a warning.', { values: ['on', 'off'] }),
  v(C, 'Listener', 'DBLOOM_HSTS_MAX_AGE', 'int', '31536000', 'HSTS max-age in seconds.', { min: 0, max: 63_072_000 }),
  v(C, 'Listener', 'DBLOOM_HSTS_SUBDOMAINS', 'bool', 'false', 'Add includeSubDomains to HSTS.'),

  v(C, 'Lifecycle', 'DBLOOM_SHUTDOWN_SECONDS', 'int', '25', 'Grace period for in-flight requests after SIGTERM (keep below the container stop grace).', { min: 1, max: 300 }),
  v(C, 'Lifecycle', 'DBLOOM_LOG_LEVEL', 'enum', 'info', 'Log level.', { values: ['debug', 'info', 'warn', 'error'] }),
  v(C, 'Lifecycle', 'DBLOOM_ALLOW_DEBUG', 'bool', 'false', 'Allow log level debug when NODE_ENV=production (warning).'),
  v(C, 'Lifecycle', 'DBLOOM_PROBE_HOSTS', 'list', 'localhost,127.0.0.1', 'Host values the health probes answer for.'),
  v(C, 'Lifecycle', 'DBLOOM_PROBE_ALLOW', 'list', '127.0.0.0/8,::1/128', 'Peers (CIDR) allowed to call the probes.'),

  v(C, 'Limits', 'DBLOOM_BODY_LIMIT_FUNCTIONS_KIB', 'int', '1024', 'Request body cap of server functions in KiB.', { min: 16, max: 65_536 }),
  v(C, 'Limits', 'DBLOOM_BODY_LIMIT_OTHER_KIB', 'int', '64', 'Request body cap of every other route in KiB.', { min: 1, max: 1024 }),

  v(C, 'Store', 'DBLOOM_STORE', 'string', 'sqlite', '`none` runs stateless (direct mode only, nothing persisted).'),
  v(C, 'Store', 'DBLOOM_DATA_DIR', 'path', './data', 'Store directory (the compose file mounts a volume at /data).'),

  v(C, 'Audit', 'DBLOOM_AUDIT_SINK', 'string', 'stdout', 'Extra audit destination: `stdout` (default, the audit JSON line always goes to stdout) or `file:/absolute/path` (append only, mode 0600, one JSON line per event). A failing file is buffered and retried; see the deploy guide.'),
  v(C, 'Audit', 'DBLOOM_AUDIT_ANONYMISE_IP', 'enum', 'off', 'Address in stored, exported and file-sink audit records: `off`, `truncate` (IPv4 /24, IPv6 /48) or `hash` (HMAC under a server key subkey). The stdout line keeps the address.', { values: ['off', 'truncate', 'hash'] }),
  v(C, 'Notices', 'DBLOOM_NOTICE_BURST_FAILURES', 'int', '10', 'Failed sign-in steps for one account or one address within the window that raise a notice to administrators.', { min: 3, max: 20 }),
  v(C, 'Notices', 'DBLOOM_NOTICE_BURST_MINUTES', 'int', '10', 'Window in minutes for the failed-attempt notice.', { min: 1, max: 60 }),
  v(C, 'Notices', 'DBLOOM_NOTICE_LOCATION_DAYS', 'int', '90', 'Days an account remembers the networks (/24 IPv4, /48 IPv6) it signed in from; a sign-in from another network raises a notice to administrators.', { min: 7, max: 365 }),
  v(C, 'Audit', 'DBLOOM_AUDIT_RETENTION_DAYS', 'int', '365', 'Days the audit log keeps rows; older rows are purged daily (the purge is itself audited).', { min: 90, max: 1095 }),

  v(C, 'Settings', 'DBLOOM_SETTINGS_LOCK', 'list', '', 'Setting keys (e.g. mfaScope,loginFailures) the settings page shows read-only at their `.env` value or default; a stored value is ignored. An unknown key refuses startup.'),
  v('auth', 'Settings', 'DBLOOM_MAINTENANCE', 'bool', 'false', 'Maintenance mode forced on: users are refused, administrators and the CLI are not. The settings page cannot switch it off.'),
  v('auth', 'Settings', 'DBLOOM_LOGIN_NOTICE', 'string', '', 'Plain text shown above the sign-in form (at most 300 characters, no control characters). Default of the setting; the page may override it.'),

  v(C, 'Targets', 'DBLOOM_DIRECT_TARGETS', 'list', '', 'Direct mode: servers users may connect to, host:port list (SEC-TGT-018).'),
  v(C, 'Targets', 'DBLOOM_DIRECT_FREE_FORM_ACK', 'bool', 'false', 'Direct mode: accept free-form targets (only behind other protections).'),
  v(C, 'Targets', 'DBLOOM_ALLOW_LOOPBACK', 'bool', 'false', 'Allow loopback target addresses (SEC-TGT-030).'),
  v(C, 'Targets', 'DBLOOM_ALLOW_PRIVATE', 'bool', 'false', 'Allow private target addresses (SEC-TGT-030).'),
  v(C, 'Targets', 'DBLOOM_TARGET_TLS', 'enum', 'verify', 'TLS to targets.', { values: ['verify', 'skip-verify', 'off'] }),
  v(C, 'Targets', 'DBLOOM_CONNECT_TIMEOUT_SECONDS', 'int', '10', 'Connect timeout to targets in seconds.'),
  v(C, 'Targets', 'DBLOOM_READ_ONLY', 'bool', 'false', 'Force every session read-only.'),
  v(C, 'Targets', 'DBLOOM_STATEMENT_TIMEOUT_SECONDS', 'int', '30', 'Statement timeout in seconds (greater than zero).'),

  v(C, 'Sessions', 'DBLOOM_SESSION_IDLE_MINUTES', 'int', '30', 'Idle session timeout in minutes.'),
  v(C, 'Sessions', 'DBLOOM_SESSION_ABSOLUTE_HOURS', 'int', '12', 'Absolute session lifetime in hours.'),

  v(C, 'Import and export', 'DBLOOM_TEMP_DIR', 'path', '', 'Staging and spool files; default <data dir>/tmp.'),
  v(C, 'Import and export', 'DBLOOM_TEMP_QUOTA_MIB', 'int', '10240', 'Total size of staged and spooled files in MiB.', { min: 1, max: 10_000_000 }),
  v(C, 'Import and export', 'DBLOOM_IMPORT_MAX_MIB', 'int', '2048', 'Upper bound of the upload size in MiB.', { min: 1, max: 2048 }),
  v(C, 'Import and export', 'DBLOOM_IMPORT_DIR', 'path', '', 'Enables importing files from a server folder. Absolute path.'),
  v('auth', 'Import and export', 'DBLOOM_UPLOAD_DIR', 'path', '', 'Reported by the setup wizard only (auth/setup.ts).'),

  v('auth', 'Account mode', 'DBLOOM_LOGIN_MODE', 'enum', '', 'Login mode: account or direct. Unset lets the setup wizard choose.', { values: ['account', 'direct'] }),
  v('auth', 'Account mode', 'DBLOOM_AUTO_SETUP', 'enum', '', 'Headless direct-mode install (CI, e2e): `direct`.', { values: ['direct'] }),
  v('auth', 'Account mode', 'DBLOOM_SETUP_TOKEN', 'secret', '', 'Fixed setup token (otherwise one is generated and printed).'),
  v('auth', 'Account mode', 'DBLOOM_SETUP_TOKEN_MINUTES', 'int', '', 'Lifetime of the generated setup token.'),
  v('auth', 'Account mode', 'DBLOOM_SETUP_NETWORKS', 'list', '', 'CIDR list that may reach setup (empty = any address).'),
  v('auth', 'Account mode', 'DBLOOM_ADMIN_NETWORKS', 'list', '', 'CIDR list of administration networks (default loopback).'),
  v('auth', 'Account mode', 'DBLOOM_SECRET_KEY', 'secret', '', 'Server key (base64) for account mode. Never commit.'),
  v('auth', 'Account mode', 'DBLOOM_SECRET_KEY_FILE', 'path', '', 'File holding the server key.'),
  v('auth', 'Account mode', 'DBLOOM_SECRET_KEY_PREVIOUS', 'secret', '', 'Previous server key during rotation.'),
  ...[
    'DBLOOM_MFA_SCOPE', 'DBLOOM_MFA_ROLES', 'DBLOOM_MFA_GRACE_DAYS', 'DBLOOM_MFA_FACTORS', 'DBLOOM_PRIMARY_CREDENTIALS',
    'DBLOOM_TOTP_WINDOW', 'DBLOOM_PASSWORD_MIN_LENGTH', 'DBLOOM_BREACHED_LIST', 'DBLOOM_BREACHED_CHECK',
    'DBLOOM_ARGON2_MEMORY_MIB', 'DBLOOM_ARGON2_PASSES', 'DBLOOM_ARGON2_PARALLELISM', 'DBLOOM_VAULT_ARGON2_MEMORY_MIB',
    'DBLOOM_VAULT_ARGON2_PASSES', 'DBLOOM_VAULT_ARGON2_PARALLELISM', 'DBLOOM_TEMP_PASSWORD_HOURS',
    'DBLOOM_ADMIN_SESSION_IDLE_MINUTES', 'DBLOOM_ADMIN_SESSION_ABSOLUTE_HOURS', 'DBLOOM_SESSIONS_PER_USER',
    'DBLOOM_SESSIONS_PER_ADMIN', 'DBLOOM_SESSIONS_AT_LIMIT', 'DBLOOM_LOGIN_FAILURES', 'DBLOOM_LOGIN_BACKOFF_CAP_MINUTES',
    'DBLOOM_LOGIN_WINDOW_MINUTES', 'DBLOOM_LOGIN_ADDRESS_FAILURES', 'DBLOOM_INVITE_HOURS', 'DBLOOM_RECOVERY_LINK_HOURS',
    'DBLOOM_VAULT_PASSPHRASE_MIN', 'DBLOOM_VAULT_AUTOLOCK_MINUTES', 'DBLOOM_PERSONAL_PROFILES',
    'DBLOOM_ALLOW_EMPTY_TARGET_PASSWORD', 'DBLOOM_DENY_ROOT_TARGET', 'DBLOOM_LOGIN_RECALL', 'DBLOOM_STEPUP_MINUTES', 'DBLOOM_AUTOREVERT_MINUTES',
    'DBLOOM_ASSISTANT_ENABLED', 'DBLOOM_AI_MODEL', 'DBLOOM_ASSISTANT_AUTO_ALLOWED', 'DBLOOM_ASSISTANT_HIDE_PII_NAMES',
  ].map(authOverride),

  v('assistant', 'AI assistant', 'DBLOOM_AI_BASE_URL', 'string', '', 'Base URL of an OpenAI-compatible chat API (https://host/v1). Empty = the assistant is unavailable and nothing is sent anywhere.'),
  v('assistant', 'AI assistant', 'DBLOOM_AI_API_KEY', 'secret', '', 'API key of the AI service. Never shown, never logged.'),
  v('assistant', 'AI assistant', 'DBLOOM_AI_API_KEY_FILE', 'path', '', 'File holding the API key (Docker secret).'),
  v('assistant', 'AI assistant', 'DBLOOM_AI_ALLOW_PRIVATE', 'bool', 'false', 'Allow the AI endpoint on a private or loopback address (a local model server).'),
  v('assistant', 'AI assistant', 'DBLOOM_AI_MAX_ROWS', 'int', '50', 'Rows of one result that may go to the AI (PII cells as tokens).', { min: 1, max: 200 }),
  v('assistant', 'AI assistant', 'DBLOOM_AI_MAX_STEPS', 'int', '8', 'Model-to-tool round trips for one user message.', { min: 1, max: 20 }),
  v('assistant', 'AI assistant', 'DBLOOM_PII_COLUMNS', 'list', '', 'Columns whose values the AI never sees, as db.table.column (a part may be *), for example `*.*.email,shop.customers.*`. Added to the markings kept in the store.'),

  v('sql', 'SQL', 'DBLOOM_SQL_DISABLED', 'bool', 'false', 'Turns the SQL module off.'),
  v('sql', 'SQL', 'DBLOOM_SQL_PARSER', 'string', '', '`off` is the parser kill switch.'),
  v('sql', 'SQL', 'DBLOOM_SQL_ROW_CAP', 'int', '', 'Result row cap.'),
  v('sql', 'SQL', 'DBLOOM_SQL_RESPONSE_MB', 'int', '', 'Response size cap in MB.'),
  v('sql', 'SQL', 'DBLOOM_SQL_CELL_KB', 'int', '', 'Cell size cap in KB.'),
  v('sql', 'SQL', 'DBLOOM_SQL_MAX_STATEMENTS', 'int', '', 'Statements per run.'),
  v('sql', 'SQL', 'DBLOOM_SQL_MAX_CONCURRENT_RUNS', 'int', '', 'Concurrent runs per session.'),

  v('rows', 'Rows', 'DBLOOM_ROWS_MAX_PAGE_SIZE', 'int', '', 'Largest page size.'),
  v('rows', 'Rows', 'DBLOOM_ROWS_EXACT_COUNT_THRESHOLD', 'int', '', 'Exact count threshold.'),
  v('rows', 'Rows', 'DBLOOM_ROWS_VIEW_COUNT_CAP', 'int', '', 'Count cap of views.'),
  v('rows', 'Rows', 'DBLOOM_ROWS_CELL_BYTES', 'int', '', 'Cell size cap in bytes.'),
  v('rows', 'Rows', 'DBLOOM_ROWS_UPLOAD_BYTES', 'int', '', 'Cell upload cap in bytes.'),
  v('rows', 'Rows', 'DBLOOM_ROWS_BULK_SIZE', 'int', '', 'Bulk operation size.'),
  v('rows', 'Rows', 'DBLOOM_ROWS_INSERT_ROWS', 'int', '', 'Rows per insert form.'),
]

export const ENV_NAMES: ReadonlySet<string> = new Set(ENV_VARS.map((e) => e.name))

/** `.env.example` text generated from the registry (every variable, commented out with its default). */
export function renderEnvExample(): string {
  const out = ['# Copy to .env. Real environment variables win over this file. Generated from src/server/env-registry.ts.']
  let group = ''
  for (const e of ENV_VARS) {
    if (e.group !== group) {
      group = e.group
      out.push('', `# --- ${group} ---`)
    }
    out.push(`# ${e.doc}`, `#${e.name}=${e.default}`)
  }
  return out.join('\n') + '\n'
}
