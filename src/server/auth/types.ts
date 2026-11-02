/**
 * Contracts of module `auth-account` (SPEC/26-module-auth-account.md, task 0). Frozen: packages A-F build on this
 * file and only the coordinating agent changes it. Requirement ids are FR-AUT-nnn of file 26; section numbers
 * refer to it. Nothing here holds logic beyond constants, schemas and the error class.
 *
 * Packages: A crypto primitives (password, breached, secret key, TOTP, codes, tokens, vault crypto);
 * B store, users, settings, throttle, sessions; C setup, CLI, sign-in, factors, step-up, invites, recovery;
 * D connections, vault, profiles, preferences; E UI; F e2e.
 */
import { z } from 'zod'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { TlsMode } from '../config'
import type { TargetPool } from '../db/target-pool'
import type { LiveSession } from '../sessions'
import type { SessionRecord, Store } from '../store/store'
import type { TargetKey } from '../target'

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

// ---- Secrets (section 9) ---------------------------------------------------------------------------------

declare const secretBrand: unique symbol
/**
 * A secret-bearing value: passwords, passphrases, recovery keys, codes, tokens, TOTP secrets. Package A ships
 * `secret(value)` / `reveal(s)`; the wrapper's `toJSON` and `toString` return `[secret]`, so a slip into a log,
 * an exception or a response shows in tests.
 */
export type Secret<T> = { readonly [secretBrand]: T; toJSON(): '[secret]'; toString(): '[secret]' }
export const SECRET_PLACEHOLDER = '[secret]'

// ---- Closed lists ------------------------------------------------------------------------------------------

/** ST-050, FR-AUT-001. Stateless mode (`DBLOOM_STORE=none`) is always direct. */
export const LOGIN_MODES = ['account', 'direct'] as const
export type LoginMode = (typeof LOGIN_MODES)[number]

/** Q4: two fixed roles; the column is text with a CHECK so roles can be added later. */
export const ROLES = ['admin', 'user'] as const
export type Role = (typeof ROLES)[number]

export const USER_STATUSES = ['active', 'disabled'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/** FR-AUT-017, section 5.5. */
export const SESSION_KINDS = ['direct', 'account'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]
export const SESSION_STATES = ['pending_mfa', 'enrol_only', 'must_change', 'full'] as const
export type SessionState = (typeof SESSION_STATES)[number]

/** Enrollable factors (ST-056); recovery codes are always on and not a choice. */
export const FACTOR_KINDS = ['passkey', 'totp'] as const
export type FactorKind = (typeof FACTOR_KINDS)[number]
/** Methods of the second-factor step (FR-AUT-011); `recovery` only after a password (Q7). */
export const MFA_METHODS = ['passkey', 'totp', 'recovery'] as const
export type MfaMethod = (typeof MFA_METHODS)[number]
/** Methods of the step-up dialog (FR-AUT-013); never a recovery code; `password` only for users without a factor. */
export const STEPUP_METHODS = ['passkey', 'totp', 'password'] as const
export type StepUpMethod = (typeof STEPUP_METHODS)[number]
/** ST-057. */
export const PRIMARY_CREDENTIALS = ['password', 'passkey'] as const
export type PrimaryCredential = (typeof PRIMARY_CREDENTIALS)[number]
/** ST-054. `roles` with the two fixed roles means "administrators plus the listed roles" (Q4). */
export const MFA_SCOPES = ['none', 'roles', 'all'] as const
export type MfaScope = (typeof MFA_SCOPES)[number]
/** ST-072. */
export const SESSION_LIMIT_ACTIONS = ['evict_oldest', 'refuse'] as const
export type SessionLimitAction = (typeof SESSION_LIMIT_ACTIONS)[number]

/** `tokens.kind` (section 5.7). */
export const TOKEN_KINDS = ['invite', 'recovery'] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

/** FR-AUT-011: every challenge carries one purpose; a response for another purpose fails. */
export const CHALLENGE_PURPOSES = [
  'signin_passkey',
  'mfa',
  'stepup',
  'enrol_passkey',
  'enrol_totp',
  'setup_passkey',
  'setup_totp',
  'invite_passkey',
  'recovery_passkey',
] as const
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number]

/** `user_notices.kind` (FR-AUT-015, 016, 017; display OTHER: admin). */
export const NOTICE_KINDS = [
  'recovery_redeemed',
  'admin_invite_issued',
  'session_evicted',
  'factor_added',
  'factor_removed',
  'password_changed',
  'sessions_revoked',
] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

/** Profile TLS modes are the `.env` modes; `skip-verify` and `off` only when `.env` permits (FR-AUT-022). */
export type { TlsMode } from '../config'
export const TLS_MODES = ['verify', 'skip-verify', 'off'] as const satisfies readonly TlsMode[]

/** Host CLI commands (FR-AUT-030). */
export const CLI_COMMANDS = ['setup-token', 'recover', 'sessions revoke', 'rotate-secret'] as const
export type CliCommand = (typeof CLI_COMMANDS)[number]

// ---- Names, cookies, headers, environment ------------------------------------------------------------------

export const SETUP_COOKIE = '__Host-dbloom-setup'
export const PRE_AUTH_COOKIE = '__Host-dbloom-pre'
/** Tab-scoped connection id (FR-AUT-018); the value lives in `sessionStorage`, never a credential. */
export const CONNECTION_HEADER = 'x-dbloom-connection'
/** `1` marks refetches and polling; they do not count as activity (FR-AUT-017). */
export const BACKGROUND_HEADER = 'x-dbloom-background'
export const SETUP_TOKEN_FILE = 'setup-token'
export const PREFERENCES_FILE_NAME = 'dbloom-preferences.json'
export const RECOVERY_CODES_FILE_NAME = 'dbloom-recovery-codes.txt'
export const VAULT_RECOVERY_KEY_FILE_NAME = 'dbloom-vault-recovery-key.txt'
/** Built by the second build entry (FR-AUT-030; see section 15 for the spike result). */
export const CLI_PATH = '.output/cli/dbloom.mjs'

/**
 * Environment variables read by this module. Names marked "spec" are fixed by file 26; the others are
 * proposed by task 0 and fixed here so packages B and C read the same names.
 */
export const AUTH_ENV = {
  loginMode: 'DBLOOM_LOGIN_MODE', // spec
  autoSetup: 'DBLOOM_AUTO_SETUP', // spec (Q8): only `direct`
  setupToken: 'DBLOOM_SETUP_TOKEN', // spec
  setupTokenMinutes: 'DBLOOM_SETUP_TOKEN_MINUTES',
  setupNetworks: 'DBLOOM_SETUP_NETWORKS', // spec
  publicOrigin: 'DBLOOM_PUBLIC_ORIGIN', // spec
  secretKey: 'DBLOOM_SECRET_KEY', // spec
  secretKeyFile: 'DBLOOM_SECRET_KEY_FILE', // spec
  secretKeyPrevious: 'DBLOOM_SECRET_KEY_PREVIOUS', // spec
  store: 'DBLOOM_STORE', // existing: `none` = stateless
  mfaScope: 'DBLOOM_MFA_SCOPE',
  mfaRoles: 'DBLOOM_MFA_ROLES',
  mfaGraceDays: 'DBLOOM_MFA_GRACE_DAYS',
  mfaFactors: 'DBLOOM_MFA_FACTORS',
  primaryCredentials: 'DBLOOM_PRIMARY_CREDENTIALS',
  totpWindow: 'DBLOOM_TOTP_WINDOW',
  passwordMinLength: 'DBLOOM_PASSWORD_MIN_LENGTH',
  breachedList: 'DBLOOM_BREACHED_LIST',
  breachedCheck: 'DBLOOM_BREACHED_CHECK',
  argon2MemoryMiB: 'DBLOOM_ARGON2_MEMORY_MIB',
  argon2Passes: 'DBLOOM_ARGON2_PASSES',
  argon2Parallelism: 'DBLOOM_ARGON2_PARALLELISM',
  vaultArgon2MemoryMiB: 'DBLOOM_VAULT_ARGON2_MEMORY_MIB',
  vaultArgon2Passes: 'DBLOOM_VAULT_ARGON2_PASSES',
  vaultArgon2Parallelism: 'DBLOOM_VAULT_ARGON2_PARALLELISM',
  tempPasswordHours: 'DBLOOM_TEMP_PASSWORD_HOURS',
  adminSessionIdleMinutes: 'DBLOOM_ADMIN_SESSION_IDLE_MINUTES',
  adminSessionAbsoluteHours: 'DBLOOM_ADMIN_SESSION_ABSOLUTE_HOURS',
  sessionsPerUser: 'DBLOOM_SESSIONS_PER_USER',
  sessionsPerAdmin: 'DBLOOM_SESSIONS_PER_ADMIN',
  sessionsAtLimit: 'DBLOOM_SESSIONS_AT_LIMIT',
  loginFailures: 'DBLOOM_LOGIN_FAILURES',
  loginBackoffCapMinutes: 'DBLOOM_LOGIN_BACKOFF_CAP_MINUTES',
  loginWindowMinutes: 'DBLOOM_LOGIN_WINDOW_MINUTES',
  loginAddressFailures: 'DBLOOM_LOGIN_ADDRESS_FAILURES',
  inviteHours: 'DBLOOM_INVITE_HOURS',
  recoveryLinkHours: 'DBLOOM_RECOVERY_LINK_HOURS',
  vaultPassphraseMin: 'DBLOOM_VAULT_PASSPHRASE_MIN',
  vaultAutoLockMinutes: 'DBLOOM_VAULT_AUTOLOCK_MINUTES',
  personalProfiles: 'DBLOOM_PERSONAL_PROFILES',
  allowEmptyTargetPassword: 'DBLOOM_ALLOW_EMPTY_TARGET_PASSWORD',
  denyRootTarget: 'DBLOOM_DENY_ROOT_TARGET',
  loginRecall: 'DBLOOM_LOGIN_RECALL',
  stepUpMinutes: 'DBLOOM_STEPUP_MINUTES',
} as const

// ---- Limits (fixed in code; section 5.4, 5.8, ST-059, 064, 082, 088) ------------------------------------------

export const KiB = 1024
export const MiB = 1024 * KiB
export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** User names (FR-AUT-004): 1 to 64 characters after NFKC; letters, digits and `._-@`. */
export const USERNAME_MAX_CHARS = 64
export const USERNAME_PATTERN = /^[\p{L}\p{N}._@-]+$/u
export const DISPLAY_NAME_MAX_CHARS = 128

/**
 * Normalisation of passwords and vault passphrases before length checks and hashing (FR-AUT-005, 021). NFC, not
 * NFKC: SP 800-63B-4 (2025) recommends NFC, and NFKC would fold distinct characters into one secret (decided
 * 2026-10-27, section 15.3). The one switch point: package A reads only this constant. User names stay NFKC
 * (FR-AUT-004).
 */
export const PASSWORD_NORMALISATION: 'NFKC' | 'NFC' = 'NFC'

/** Passwords (FR-AUT-005, ST-063 to 065). Lengths are Unicode code points after PASSWORD_NORMALISATION. */
export const PASSWORD_MAX_CHARS = 256
export const PASSWORD_MAX_BYTES = 1024
/** Bound of the raw request field, before normalisation; the policy check gives `too_long` above PASSWORD_MAX_CHARS. */
export const PASSWORD_INPUT_MAX_CHARS = 1024
export const PASSWORD_MIN_LENGTH_FLOOR = 12
/** ENV may lower the floor to this (ST-063 "ENV may allow 10"). */
export const PASSWORD_MIN_LENGTH_ENV_FLOOR = 10
export const PASSWORD_MIN_LENGTH_DEFAULT = 12
export const PASSWORD_MIN_LENGTH_CEILING = 64

/** Argon2id parameters; `memoryKiB` is what `crypto.argon2` calls `memory`. */
export type Argon2Params = { memoryKiB: number; passes: number; parallelism: number }
export const ARGON2_LOGIN_MIN: Argon2Params = { memoryKiB: 19 * 1024, passes: 2, parallelism: 1 }
export const ARGON2_LOGIN_DEFAULT: Argon2Params = { memoryKiB: 64 * 1024, passes: 3, parallelism: 1 }
export const ARGON2_VAULT_MIN: Argon2Params = { memoryKiB: 64 * 1024, passes: 3, parallelism: 1 }
export const ARGON2_VAULT_DEFAULT: Argon2Params = { memoryKiB: 128 * 1024, passes: 3, parallelism: 1 }
export const ARGON2_SALT_BYTES = 16
export const ARGON2_TAG_BYTES = 32
/** At most 2 hashes at once, queue of 32; beyond it `auth_throttled` (FR-AUT-005). */
export const ARGON2_MAX_CONCURRENT = 2
export const ARGON2_QUEUE_MAX = 32

/** TOTP (FR-AUT-008, ST-059). */
export const TOTP_DIGITS = 6
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_ALGORITHM = 'SHA1'
export const TOTP_SECRET_BYTES = 20
export const TOTP_WINDOW_MAX = 1

/** Recovery codes (FR-AUT-010). Display `XXXX-XXXX-XXXX`. */
export const RECOVERY_CODE_COUNT = 10
export const RECOVERY_CODE_BITS = 60
export const RECOVERY_CODE_CHARS = 12
export const RECOVERY_CODES_WARN_AT = 2

/** Challenges (FR-AUT-011). */
export const CHALLENGE_TTL_MS = 5 * MINUTE_MS
export const CHALLENGE_MAX_TRIES = 5
export const WEBAUTHN_CHALLENGE_BYTES = 32
export const PRE_AUTH_TTL_MS = 5 * MINUTE_MS
/** `pending_mfa` sessions end after this (section 5.5). */
export const PENDING_MFA_TTL_MS = 5 * MINUTE_MS

/** Passkeys (FR-AUT-009). */
export const MAX_PASSKEYS = 10
/**
 * COSE algorithms offered at registration: EdDSA, ES256, RS256, passed explicitly. The library's default adds
 * ML-DSA-44 first whenever the runtime has it (Node 24.19: experimental Web Crypto, ExperimentalWarning), so the
 * default would depend on the Node version (spike 0, section 15).
 */
export const WEBAUTHN_ALGORITHM_IDS = [-8, -7, -257] as const
export const PASSKEY_NAME_MAX_CHARS = 64
/** WebAuthn credential ids are at most 1 023 bytes; base64url of that. */
export const CREDENTIAL_ID_MAX_CHARS = 1364
export const WEBAUTHN_RESPONSE_MAX_CHARS = 64 * KiB

/** Setup token (FR-AUT-002, ST-051). Generated: 160 bit, 32 Crockford base32 characters in groups of four. */
export const SETUP_TOKEN_BITS = 160
export const SETUP_TOKEN_CHARS = 32
export const SETUP_TOKEN_ENV_MIN_CHARS = 22
export const SETUP_COOKIE_BYTES = 32
export const SETUP_FAILURES = 5
export const SETUP_FAILURE_WINDOW_MS = 15 * MINUTE_MS
export const SETUP_STEPS = [1, 2, 3, 4, 5] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/** Invite and recovery tokens (ST-082): 256 bit, base64url (43 characters), hash only, in the URL fragment. */
export const LINK_TOKEN_BYTES = 32
export const LINK_TOKEN_CHARS = 43

/** Session tokens stay as the skeleton made them (256 bit). Connections per session (FR-AUT-018, PROPOSED). */
export const MAX_CONNECTIONS_PER_SESSION = 5
export const CONNECTION_ID_BYTES = 16
export const CONNECTION_ID_CHARS = 22
export const CLIENT_HINT_MAX_CHARS = 64
/** Idle warning (G9, FR-AUT-017). */
export const IDLE_WARNING_MS = 2 * MINUTE_MS
export const ABSOLUTE_WARNING_MS = 5 * MINUTE_MS

/** Server key and sealed records (FR-AUT-023). Record format `v1.<key id>.<nonce>.<ciphertext>.<tag>`, base64url. */
export const SECRET_KEY_BYTES = 32
export const AEAD_NONCE_BYTES = 12
export const AEAD_TAG_BYTES = 16
export const KEY_ID_BYTES = 8
export const SEALED_VERSION = 'v1'
export const KEY_ID_INFO = 'key-id'
/** HKDF-SHA-256 info strings of the server subkeys. */
export const SUBKEY_INFO = { totp: 'totp', recoveryCodes: 'recovery-codes', preAuth: 'pre-auth' } as const
export type SubkeyKind = keyof typeof SUBKEY_INFO

/** Vault (FR-AUT-021, ST-087, ST-088, ST-089). Recovery key display: 32 Crockford characters in groups of four. */
export const VAULT_KEY_BYTES = 32
export const VAULT_RECOVERY_KEY_BYTES = 20
export const VAULT_RECOVERY_KEY_CHARS = 32
export const VAULT_HKDF_SALT_BYTES = 16
export const VAULT_RECOVERY_INFO = 'vault/v1/recovery'
export const VAULT_PASSPHRASE_MIN_FLOOR = 12
export const VAULT_PASSPHRASE_MIN_DEFAULT = 14
export const VAULT_PASSPHRASE_INPUT_MAX_CHARS = 1024

/** Associated data of every AEAD record (section 5.4). */
export const AAD = {
  totp: (userId: string) => `totp/v1/${userId}`,
  vaultPassphrase: (userId: string) => `vault/v1/passphrase/${userId}`,
  vaultRecovery: (userId: string) => `vault/v1/recovery/${userId}`,
  profile: (userId: string, profileId: string) => `profile/v1/${userId}/${profileId}`,
} as const

/** Profiles (FR-AUT-022). */
export const MAX_PROFILES_PER_USER = 50
export const PROFILE_NAME_MAX_CHARS = 64
export const PROFILE_DEFAULT_PORT = 3306
export const PEM_MAX_CHARS = 16 * KiB

/** Preferences (FR-AUT-024, 025). */
export const HIDDEN_DATABASES_MAX = 500
export const PREFS_IMPORT_MAX_BYTES = 256 * KiB
export const PREFS_EXPORT_VERSION = 1
/** `ui_prefs.target_key` of user-wide keys. */
export const PREFS_ANY_TARGET = '*'
export const PREFS_SCOPE = 'prefs'

/** Step-up window until the admin module owns ST-034 (FR-AUT-013). */
export const STEPUP_WINDOW_DEFAULT_MS = 5 * MINUTE_MS
/** Administrator session limits (ST-069, ST-070 admin defaults). */
export const ADMIN_SESSION_IDLE_DEFAULT_MS = 15 * MINUTE_MS
export const ADMIN_SESSION_ABSOLUTE_DEFAULT_MS = 4 * HOUR_MS

/**
 * Throttle (FR-AUT-007, ST-076 to 078): with n failures in the window and n ≥ limit (default 5), the next attempt
 * waits `BASE × FACTOR^(n − limit)` (1 s, 2 s, 4 s, …), capped at `loginBackoffCapMs`.
 */
export const THROTTLE_BACKOFF_BASE_MS = 1000
export const THROTTLE_BACKOFF_FACTOR = 2

/** Audit event names of this module (FR-AUT-027); fields never hold secrets. */
export const AUTH_AUDIT_EVENTS = [
  'setup.token',
  'setup.token_failed',
  'setup.complete',
  'setup.auto',
  'auth.signin',
  'auth.mfa',
  'auth.signout',
  'auth.stepup',
  'session.evicted',
  'session.ended',
  'user.create',
  'user.status',
  'user.role',
  'user.delete',
  'user.sessions_revoked',
  'user.password_changed',
  'invite.issue',
  'invite.revoke',
  'invite.redeem',
  'recovery.issue',
  'recovery.redeem',
  'factor.added',
  'factor.removed',
  'codes.regenerated',
  'webauthn.counter',
  'vault.create',
  'vault.unlock',
  'vault.lock',
  'vault.passphrase',
  'vault.recovery_key',
  'vault.rotate',
  'profile.save',
  'profile.delete',
  'connection.open',
  'connection.close',
  'connection.failed',
  'prefs.import',
  'secret.unreadable',
  'settings.clamped',
  'cli.command',
] as const
export type AuthAuditEvent = (typeof AUTH_AUDIT_EVENTS)[number]
export type AuthAuditFields = {
  actor?: string
  actorKind?: 'user' | 'cli' | 'setup' | 'system'
  subject?: string
  outcome?: 'ok' | 'failed' | 'throttled' | 'refused'
  method?: MfaMethod | StepUpMethod | PrimaryCredential
  keyKind?: 'acct' | 'ip' | 'tgt'
  reason?: string
  role?: Role
  host?: string
  port?: number
  targetUser?: string
  connectionId?: string
  count?: number
  [field: string]: string | number | boolean | undefined
}

// ---- Errors (section 5.9: closed list) --------------------------------------------------------------------

export const AUTH_ERROR_CODES = [
  'auth_failed',
  'auth_throttled',
  'mfa_required',
  'mfa_failed',
  'mfa_expired',
  'enrol_required',
  'password_change_required',
  'stepup_required',
  'password_rejected',
  'invite_invalid',
  'recovery_invalid',
  'vault_locked',
  'vault_absent',
  'profile_test_failed',
  'connection_unknown',
  'connection_limit',
  'profile_name_taken',
  'profile_limit',
  'target_policy',
  'setup_pending',
] as const
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]

/** Reasons of `password_rejected`; shown only on forms that set a password. */
export const PASSWORD_REJECT_REASONS = ['too_short', 'too_long', 'contains_username', 'breached', 'reused'] as const
export type PasswordRejectReason = (typeof PASSWORD_REJECT_REASONS)[number]

/** Reasons of `target_policy` (FR-SAU-004): the only target refusals that name their reason. */
export const TARGET_POLICY_REASONS = ['root_denied', 'empty_password'] as const
export type TargetPolicyReason = (typeof TARGET_POLICY_REASONS)[number]

/** What crosses the boundary: a stable code, one localised message (`t('auth.error.<code>')`), no library text. */
export type AuthErrorBody = {
  code: AuthErrorCode
  reason?: PasswordRejectReason | TargetPolicyReason
  /** `auth_throttled`: seconds for the `Retry-After` header. */
  retryAfterSeconds?: number
  /** `profile_test_failed`: the generic target message of the skeleton (SEC-TGT-018). */
  targetMessage?: string
}

/** The only error thrown by services of this module; `message` is the code, never detail (SEC-TGT-153). */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    public readonly detail: Omit<AuthErrorBody, 'code'> = {},
  ) {
    super(code)
    this.name = 'AuthError'
  }
}

// ---- Domain types -----------------------------------------------------------------------------------------

export type UserId = string
export type ProfileId = string
export type ConnectionId = string

/** `users` (FR-AUT-004). */
export type User = {
  id: UserId
  username: string
  /** NFKC + case folded; unique. */
  usernameKey: string
  displayName: string
  role: Role
  status: UserStatus
  securityVersion: number
  mustChangePassword: boolean
  /** Expiry of an administrator-set temporary password (ST-068); null otherwise. */
  tempPasswordExpiresAt: number | null
  /** 32 random bytes, base64url; never the user name (FR-AUT-009). */
  webauthnUserId: string
  createdAt: number
  updatedAt: number
  /** User id, `setup`, `invite:<token id>` or `cli`. */
  createdBy: string
  lastSignInAt: number | null
}

/** One row of the Users page (FR-AUT-028). */
export type UserSummary = Pick<User, 'id' | 'username' | 'displayName' | 'role' | 'status' | 'lastSignInAt' | 'createdAt'> & {
  factors: { passkeys: number; totp: boolean; recoveryCodes: number }
  hasPassword: boolean
}

/** `passwords`: PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
export type PasswordRecord = { userId: UserId; phc: string; changedAt: number }

/** `webauthn_credentials` (FR-AUT-009). */
export type PasskeyRecord = {
  /** Credential id, base64url. */
  id: string
  userId: UserId
  publicKey: Uint8Array
  counter: number
  transports: AuthenticatorTransport[]
  backedUp: boolean
  /** User verified at registration. */
  uvInitial: boolean
  name: string
  createdAt: number
  lastUsedAt: number | null
}
/** What the browser sees of a passkey: no public key. */
export type PasskeyInfo = Pick<PasskeyRecord, 'id' | 'name' | 'backedUp' | 'uvInitial' | 'createdAt' | 'lastUsedAt'>

/** `totp`: secret sealed under subkey `totp`, AAD `totp/v1/<user id>`. */
export type TotpRecord = { userId: UserId; sealed: string; lastStep: number; createdAt: number }

/** `recovery_codes`: HMAC-SHA-256(subkey `recovery-codes`, user id ‖ code), hex. */
export type RecoveryCodeRecord = { userId: UserId; codeMac: string; createdAt: number }

/** `tokens` (invites and recovery links). */
export type LinkTokenRecord = {
  id: string
  kind: TokenKind
  /** SHA-256 of the token, hex. */
  tokenHash: string
  /** Recovery: the subject; invite: null until redeemed, then the new user. */
  userId: UserId | null
  /** Invite: the role granted; recovery: null. */
  role: Role | null
  createdBy: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  revokedAt: number | null
}
export type InviteInfo = Pick<LinkTokenRecord, 'id' | 'role' | 'createdBy' | 'createdAt' | 'expiresAt'>

/** `vaults` (FR-AUT-021). Every blob is base64url text. */
export type VaultRecord = {
  userId: UserId
  kdfParams: Argon2Params
  kdfSalt: string
  /** Vault key sealed under the Argon2id key, AAD `vault/v1/passphrase/<user id>`. */
  wrapPassphrase: string
  recoverySalt: string
  /** Vault key sealed under the HKDF key of the recovery key, AAD `vault/v1/recovery/<user id>`. */
  wrapRecovery: string
  createdAt: number
  updatedAt: number
}
export type VaultStatus = { exists: boolean; unlocked: boolean; autoLockAt: number | null; enabled: boolean }

/** Plain metadata of a profile (Q10): readable while the vault is locked. */
export type ProfileOptions = {
  compress: boolean
  database: string | null
  collation: string | null
  /** `SET ROLE ALL` after connect (FR-AUT-020). MySQL only: MariaDB 10.11 has no `SET ROLE ALL` (spike 0; owner decision open). */
  activateRoles: boolean
  caPem: string | null
  clientCertPem: string | null
}
/** `connection_profiles` row. */
export type ProfileRecord = {
  id: ProfileId
  userId: UserId
  name: string
  host: string
  port: number
  tls: TlsMode
  options: ProfileOptions
  /** AES-256-GCM under the vault key, AAD `profile/v1/<user id>/<profile id>`; holds `ProfileSecret` JSON. */
  sealed: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}
/** The encrypted part; never returned to the browser. */
export type ProfileSecret = { user: string; password: string; clientKey?: string }
/** What the browser sees: user name only when the vault is unlocked, never the password or client key. */
export type ProfileInfo = Omit<ProfileRecord, 'userId' | 'sealed'> & { targetUser?: string; hasClientKey?: boolean }

/** `user_notices`. */
export type UserNotice = { id: string; userId: UserId; kind: NoticeKind; createdAt: number; readAt: number | null }

/** `site` keys (FR-AUT-001). */
export const SITE_KEYS = ['login_mode', 'setup_completed_at', 'site_name'] as const
export type SiteKey = (typeof SITE_KEYS)[number]
export type SiteState = { loginMode: LoginMode; setupCompletedAt: number; siteName: string }

/** `settings` row (FR-AUT-029). `value` is JSON text. */
export type SettingRow = { key: AuthSettingKey; value: string; updatedAt: number; updatedBy: string }

/** Account session row: the skeleton row plus the columns of migration 5 (FR-AUT-017). */
export type AccountSessionRecord = SessionRecord & {
  kind: SessionKind
  /** Null for direct sessions. `targetKey` and `userName` are `''` until a connection exists (section 15). */
  userId: UserId | null
  state: SessionState
  mfaAt: number | null
  stepupAt: number | null
  securityVersion: number
  clientHint: string
  address: string
}
/** Account security, sessions list. */
export type SessionInfo = { ref: string; clientHint: string; address: string; createdAt: number; lastSeenAt: number; current: boolean }

/** In-memory challenge (FR-AUT-011). */
export type ChallengeRecord = {
  id: string
  /** Session id hash, or the pre-auth / setup cookie hash. */
  owner: string
  purpose: ChallengePurpose
  userId?: UserId
  /** WebAuthn challenge (base64url). */
  challenge?: string
  expiresAt: number
  tries: number
}

/** One held target connection (FR-AUT-018). */
export type ConnectionEntry = {
  connectionId: ConnectionId
  target: TargetKey
  pool: TargetPool
  readOnly: boolean
  source: 'typed' | 'profile'
  profileId?: ProfileId
  openedAt: number
}
export type ConnectionInfo = {
  connectionId: ConnectionId
  host: string
  port: number
  targetUser: string
  source: 'typed' | 'profile'
  profileId?: ProfileId
  label?: string
  readOnly: boolean
  openedAt: number
}

/**
 * Context of target-scoped server functions: the unchanged `LiveSession` plus connection id and user
 * (direct mode: `connectionId = ''`, `user = null`). Registries key by `scopeKey` (`idHash` or `idHash/connectionId`).
 */
export type AccountLiveSession = LiveSession & {
  kind: SessionKind
  connectionId: ConnectionId
  scopeKey: string
  user: AuthUser | null
}
/** Context of functions without a target (`accountMiddleware`). */
export type AccountContext = {
  idHash: string
  csrf: string
  kind: SessionKind
  state: SessionState
  user: AuthUser | null
  /** Owner key for per-user data: `u:<user id>`, `ownerKeyOf(target)` or the session id hash (stateless). */
  ownerKey: string
  mfaAt: number | null
  stepupAt: number | null
}
export type AuthUser = Pick<User, 'id' | 'username' | 'displayName' | 'role' | 'securityVersion'>

/** `scopeKey = idHash + '/' + connectionId` (direct mode: `idHash`). */
export const SCOPE_KEY_SEPARATOR = '/'

/** Returned by `getSessionInfo` in account mode (theme and language applied before first paint, FR-AUT-024). */
export type AccountSessionInfo = {
  mode: LoginMode
  csrf: string
  state: SessionState
  user: AuthUser | null
  connections: ConnectionInfo[]
  vault: VaultStatus
  theme: Theme
  language: string
  idleExpiresAt: number
  absoluteExpiresAt: number
  stepUpUntil: number | null
}

// ---- Setup state (FR-AUT-001 to 003) ------------------------------------------------------------------------

export type StartupState =
  | { kind: 'stateless' }
  | { kind: 'setup_pending'; storeMode: 'stateful'; preselectedMode?: LoginMode }
  | { kind: 'ready'; mode: LoginMode }

/** Wizard values held in memory under the setup cookie; nothing reaches the store before step 5. */
export type SetupDraft = {
  step: SetupStep
  loginMode?: LoginMode
  site?: SetupSiteValues
  admin?: { username: string; displayName: string; passwordSet: boolean; factor?: FactorKind; codesSaved: boolean }
  adminNetworkAcknowledged: boolean
}
/** Read-only `.env` status of step 3 (UI-TGT-002, Q6). */
export type SetupEnvStatus = {
  storeMode: 'stateful'
  publicOrigin: string | null
  publicOriginMatchesBrowser: boolean | null
  secretKeyPresent: boolean
  adminNetworks: string[]
  browserAddress: string
  browserInAdminNetworks: boolean
  importDir: string | null
  uploadDir: string | null
  tls: TlsMode
}

// ---- Settings read by this module (section 5.8, FR-AUT-029) -------------------------------------------------

/** Where the value comes from: `.env` only, UI within `.env` bounds, UI only, or the wizard. */
export type SettingSource = 'env' | 'ui_within_env' | 'ui' | 'wizard'
export type SettingSpec<T> = {
  st: string
  source: SettingSource
  env?: string
  /** F: lowest (or least strict) value allowed; D: default; C: highest. Omitted when not applicable. */
  floor?: T
  default: T
  ceiling?: T
  schema: z.ZodType<T>
}

const ms = z.number().int().min(0)
const roleList = z.array(z.enum(ROLES)).max(ROLES.length)
const factorList = z.array(z.enum(FACTOR_KINDS)).min(1).max(FACTOR_KINDS.length)
const primaryList = z.array(z.enum(PRIMARY_CREDENTIALS)).min(1).max(PRIMARY_CREDENTIALS.length)
const argon2Schema = z
  .object({ memoryKiB: z.number().int().min(1024), passes: z.number().int().min(1), parallelism: z.number().int().min(1).max(16) })
  .strict()

/** F/D/C of section 5.8; durations in milliseconds. */
export const AUTH_SETTINGS = {
  loginMode: { st: 'ST-050', source: 'wizard', env: AUTH_ENV.loginMode, default: 'account', schema: z.enum(LOGIN_MODES) },
  setupTokenValidityMs: {
    st: 'ST-051',
    source: 'env',
    env: AUTH_ENV.setupTokenMinutes,
    floor: 5 * MINUTE_MS,
    default: 60 * MINUTE_MS,
    ceiling: 24 * HOUR_MS,
    schema: ms,
  },
  mfaScope: { st: 'ST-054', source: 'ui_within_env', env: AUTH_ENV.mfaScope, default: 'none', ceiling: 'all', schema: z.enum(MFA_SCOPES) },
  mfaRoles: { st: 'ST-054', source: 'ui_within_env', env: AUTH_ENV.mfaRoles, default: ['admin'], schema: roleList },
  mfaGraceMs: { st: 'ST-055', source: 'ui_within_env', env: AUTH_ENV.mfaGraceDays, floor: 0, default: 0, ceiling: 7 * DAY_MS, schema: ms },
  mfaFactors: { st: 'ST-056', source: 'ui_within_env', env: AUTH_ENV.mfaFactors, default: ['passkey', 'totp'], schema: factorList },
  primaryCredentials: {
    st: 'ST-057',
    source: 'ui_within_env',
    env: AUTH_ENV.primaryCredentials,
    default: ['password', 'passkey'],
    schema: primaryList,
  },
  totpWindow: { st: 'ST-058', source: 'env', env: AUTH_ENV.totpWindow, floor: 0, default: 1, ceiling: TOTP_WINDOW_MAX, schema: z.number().int().min(0).max(TOTP_WINDOW_MAX) },
  passwordMinLength: {
    st: 'ST-063',
    source: 'ui_within_env',
    env: AUTH_ENV.passwordMinLength,
    floor: PASSWORD_MIN_LENGTH_FLOOR,
    default: PASSWORD_MIN_LENGTH_DEFAULT,
    ceiling: PASSWORD_MIN_LENGTH_CEILING,
    schema: z.number().int().min(PASSWORD_MIN_LENGTH_ENV_FLOOR).max(PASSWORD_MIN_LENGTH_CEILING),
  },
  // Off until the breached-list data is bundled (source and licence unconfirmed, SPEC/26 15.3.5); the service skips the check and the unavailable flag when off.
  breachedCheck: { st: 'ST-066', source: 'ui_within_env', env: AUTH_ENV.breachedCheck, default: false, schema: z.boolean() },
  argon2Login: { st: 'ST-067', source: 'env', floor: ARGON2_LOGIN_MIN, default: ARGON2_LOGIN_DEFAULT, schema: argon2Schema },
  argon2Vault: { st: 'ST-086', source: 'env', floor: ARGON2_VAULT_MIN, default: ARGON2_VAULT_DEFAULT, schema: argon2Schema },
  tempPasswordMs: {
    st: 'ST-068',
    source: 'ui_within_env',
    env: AUTH_ENV.tempPasswordHours,
    floor: 1 * HOUR_MS,
    default: 7 * DAY_MS,
    ceiling: 14 * DAY_MS,
    schema: ms,
  },
  adminSessionIdleMs: {
    st: 'ST-069',
    source: 'ui_within_env',
    env: AUTH_ENV.adminSessionIdleMinutes,
    floor: 5 * MINUTE_MS,
    default: ADMIN_SESSION_IDLE_DEFAULT_MS,
    ceiling: 2 * HOUR_MS,
    schema: ms,
  },
  adminSessionAbsoluteMs: {
    st: 'ST-070',
    source: 'ui_within_env',
    env: AUTH_ENV.adminSessionAbsoluteHours,
    floor: 30 * MINUTE_MS,
    default: ADMIN_SESSION_ABSOLUTE_DEFAULT_MS,
    ceiling: 8 * HOUR_MS,
    schema: ms,
  },
  sessionsPerUser: { st: 'ST-071', source: 'ui_within_env', env: AUTH_ENV.sessionsPerUser, floor: 1, default: 5, ceiling: 20, schema: z.number().int().min(1).max(20) },
  sessionsPerAdmin: { st: 'ST-071', source: 'ui_within_env', env: AUTH_ENV.sessionsPerAdmin, floor: 1, default: 2, ceiling: 20, schema: z.number().int().min(1).max(20) },
  sessionsAtLimit: { st: 'ST-072', source: 'ui_within_env', env: AUTH_ENV.sessionsAtLimit, default: 'evict_oldest', schema: z.enum(SESSION_LIMIT_ACTIONS) },
  loginFailures: { st: 'ST-076', source: 'ui_within_env', env: AUTH_ENV.loginFailures, floor: 3, default: 5, ceiling: 10, schema: z.number().int().min(3).max(10) },
  loginBackoffCapMs: {
    st: 'ST-077',
    source: 'ui_within_env',
    env: AUTH_ENV.loginBackoffCapMinutes,
    floor: 1 * MINUTE_MS,
    default: 15 * MINUTE_MS,
    ceiling: 60 * MINUTE_MS,
    schema: ms,
  },
  loginWindowMs: {
    st: 'ST-077',
    source: 'ui_within_env',
    env: AUTH_ENV.loginWindowMinutes,
    floor: 5 * MINUTE_MS,
    default: 15 * MINUTE_MS,
    ceiling: 60 * MINUTE_MS,
    schema: ms,
  },
  loginAddressFailures: {
    st: 'ST-078',
    source: 'ui_within_env',
    env: AUTH_ENV.loginAddressFailures,
    floor: 10,
    default: 20,
    ceiling: 100,
    schema: z.number().int().min(10).max(100),
  },
  inviteLifetimeMs: {
    st: 'ST-081',
    source: 'ui_within_env',
    env: AUTH_ENV.inviteHours,
    floor: 15 * MINUTE_MS,
    default: 7 * DAY_MS,
    ceiling: 7 * DAY_MS,
    schema: ms,
  },
  recoveryLinkLifetimeMs: {
    st: 'ST-084',
    source: 'ui_within_env',
    env: AUTH_ENV.recoveryLinkHours,
    floor: 15 * MINUTE_MS,
    default: 24 * HOUR_MS,
    ceiling: 72 * HOUR_MS,
    schema: ms,
  },
  vaultPassphraseMin: {
    st: 'ST-087',
    source: 'ui_within_env',
    env: AUTH_ENV.vaultPassphraseMin,
    floor: VAULT_PASSPHRASE_MIN_FLOOR,
    default: VAULT_PASSPHRASE_MIN_DEFAULT,
    schema: z.number().int().min(VAULT_PASSPHRASE_MIN_FLOOR).max(256),
  },
  /** Ceiling = the session idle limit of the user, applied by the resolver. */
  vaultAutoLockMs: { st: 'ST-089', source: 'ui_within_env', env: AUTH_ENV.vaultAutoLockMinutes, floor: 1 * MINUTE_MS, default: 15 * MINUTE_MS, schema: ms },
  personalProfiles: { st: 'ST-090', source: 'ui_within_env', env: AUTH_ENV.personalProfiles, default: true, schema: z.boolean() },
  allowEmptyTargetPassword: {
    st: 'ST-123',
    source: 'ui_within_env',
    env: AUTH_ENV.allowEmptyTargetPassword,
    default: false,
    schema: z.boolean(),
  },
  denyRootTarget: { st: 'ST-124', source: 'ui_within_env', env: AUTH_ENV.denyRootTarget, default: false, schema: z.boolean() },
  loginAutofocus: { st: 'UI-ISS-134', source: 'ui', default: false, schema: z.boolean() },
  loginRecall: { st: 'ST-074', source: 'env', env: AUTH_ENV.loginRecall, default: false, schema: z.boolean() },
  stepUpWindowMs: { st: 'ST-034', source: 'env', env: AUTH_ENV.stepUpMinutes, floor: 1 * MINUTE_MS, default: STEPUP_WINDOW_DEFAULT_MS, ceiling: 15 * MINUTE_MS, schema: ms },
} as const satisfies Record<string, SettingSpec<unknown>>

export type AuthSettingKey = keyof typeof AUTH_SETTINGS
export const AUTH_SETTING_KEYS = Object.keys(AUTH_SETTINGS) as AuthSettingKey[]
/** Settings the wizard's step 3 may write (the rest stay `.env` or admin-module UI). */
export const SETUP_SITE_SETTING_KEYS = [
  'mfaScope',
  'mfaGraceMs',
  'mfaFactors',
  'primaryCredentials',
  'passwordMinLength',
  'breachedCheck',
  'tempPasswordMs',
  'sessionsPerUser',
  'sessionsAtLimit',
  'inviteLifetimeMs',
  'recoveryLinkLifetimeMs',
  'vaultPassphraseMin',
  'vaultAutoLockMs',
  'personalProfiles',
  'allowEmptyTargetPassword',
  'denyRootTarget',
  'loginAutofocus',
] as const satisfies readonly AuthSettingKey[]
export type SetupSiteSettingKey = (typeof SETUP_SITE_SETTING_KEYS)[number]

/** Effective values (`resolveAuthSettings()`), plus the `.env`-only values that are not in the table. */
export type ResolvedAuthSettings = { [K in AuthSettingKey]: z.infer<(typeof AUTH_SETTINGS)[K]['schema']> } & {
  /** `DBLOOM_PUBLIC_ORIGIN`; RP ID is its host (ST-060). Null only in direct mode. */
  publicOrigin: string | null
  rpId: string | null
  /** `DBLOOM_SETUP_NETWORKS` (CIDR list); empty = any address (ST-031). */
  setupNetworks: string[]
  /** Path of the operator's breached list (Q3); null = the bundled list. */
  breachedListPath: string | null
}

// ---- Server-function inputs (zod) --------------------------------------------------------------------------

const nfkc = (s: string) => s.normalize('NFKC')
const codePoints = (s: string) => [...s].length

/** User name: NFKC, 1 to 64 characters of `USERNAME_PATTERN` (FR-AUT-004). */
export const usernameInput = z
  .string()
  .max(USERNAME_MAX_CHARS * 4)
  .transform(nfkc)
  .pipe(
    z
      .string()
      .refine((s) => codePoints(s) >= 1 && codePoints(s) <= USERNAME_MAX_CHARS, 'username_length')
      .refine((s) => USERNAME_PATTERN.test(s), 'username_chars'),
  )
/** Sign-in name: any string up to the bound; unknown or malformed names fail like a wrong password. */
export const signInUsernameInput = z.string().max(USERNAME_MAX_CHARS * 4)
export const displayNameInput = z.string().trim().max(DISPLAY_NAME_MAX_CHARS)
/** Raw password field; NFKC and the policy (ST-063 to 066) run in the service and give `password_rejected`. */
export const passwordInput = z.string().min(1).max(PASSWORD_INPUT_MAX_CHARS)
export const passphraseInput = z.string().min(1).max(VAULT_PASSPHRASE_INPUT_MAX_CHARS)
export const totpCodeInput = z
  .string()
  .max(16)
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/))
/** Case-insensitive, spaces and dashes ignored (FR-AUT-010); the service normalises. */
export const recoveryCodeInput = z.string().min(1).max(32)
/** 32 Crockford characters, groups optional; the service normalises. */
export const vaultRecoveryKeyInput = z.string().min(1).max(64)
/** Generated (Crockford, 32 characters plus separators) or from `.env` (≥ 22 base64url characters). */
export const setupTokenInput = z.string().min(1).max(256)
export const linkTokenInput = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${LINK_TOKEN_CHARS}}$`))
export const userIdInput = z.uuid()
export const profileIdInput = z.uuid()
export const connectionIdInput = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${CONNECTION_ID_CHARS}}$`))
export const passkeyIdInput = z.string().min(1).max(CREDENTIAL_ID_MAX_CHARS).regex(/^[A-Za-z0-9_-]+$/)
export const passkeyNameInput = z
  .string()
  .trim()
  .refine((s) => codePoints(s) >= 1 && codePoints(s) <= PASSKEY_NAME_MAX_CHARS)
export const roleInput = z.enum(ROLES)

const b64url = z.string().max(WEBAUTHN_RESPONSE_MAX_CHARS).regex(/^[A-Za-z0-9_-]*$/)
const transports = z.array(z.string().max(32)).max(10)
const registrationShape = z.looseObject({
  id: b64url.min(1),
  rawId: b64url.min(1),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: b64url, attestationObject: b64url, transports: transports.optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.string().max(32).optional(),
})
const authenticationShape = z.looseObject({
  id: b64url.min(1),
  rawId: b64url.min(1),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.string().max(32).optional(),
})
/** Shape and size check only; the library verifies the content. */
export const registrationResponseInput = registrationShape.transform((v) => v as unknown as RegistrationResponseJSON)
export const authenticationResponseInput = authenticationShape.transform((v) => v as unknown as AuthenticationResponseJSON)

const empty = z.object({}).strict()

// Setup (FR-AUT-002, 003)
export const setupVerifyTokenInput = z.object({ token: setupTokenInput }).strict()
export const setupSiteValuesInput = z
  .object({
    siteName: z.string().trim().min(1).max(80),
    mfaScope: z.enum(MFA_SCOPES),
    mfaRoles: roleList,
    mfaGraceMs: ms,
    mfaFactors: factorList,
    primaryCredentials: primaryList,
    passwordMinLength: z.number().int().min(PASSWORD_MIN_LENGTH_ENV_FLOOR).max(PASSWORD_MIN_LENGTH_CEILING),
    breachedCheck: z.boolean(),
    tempPasswordMs: ms,
    sessionsPerUser: z.number().int().min(1).max(20),
    sessionsAtLimit: z.enum(SESSION_LIMIT_ACTIONS),
    inviteLifetimeMs: ms,
    recoveryLinkLifetimeMs: ms,
    vaultPassphraseMin: z.number().int().min(VAULT_PASSPHRASE_MIN_FLOOR).max(256),
    vaultAutoLockMs: ms,
    personalProfiles: z.boolean(),
    allowEmptyTargetPassword: z.boolean(),
    denyRootTarget: z.boolean(),
    loginAutofocus: z.boolean(),
  })
  .strict()
export type SetupSiteValues = z.infer<typeof setupSiteValuesInput>
export const setupSaveStepInput = z.discriminatedUnion('step', [
  z.object({ step: z.literal(2), loginMode: z.enum(LOGIN_MODES) }).strict(),
  z.object({ step: z.literal(3), site: setupSiteValuesInput }).strict(),
  z.object({ step: z.literal(4), username: usernameInput, displayName: displayNameInput, password: passwordInput }).strict(),
])
export const setupPasskeyVerifyInput = z.object({ response: registrationResponseInput, name: passkeyNameInput }).strict()
export const setupTotpVerifyInput = z.object({ code: totpCodeInput }).strict()
export const setupCompleteInput = z
  .object({ codesSaved: z.literal(true).optional(), acknowledgeAdminNetwork: z.boolean().default(false) })
  .strict()

// Sign-in (FR-AUT-006, 011)
export const passwordSignInInput = z.object({ username: signInUsernameInput, password: passwordInput }).strict()
export const mfaOptionsInput = z.object({ method: z.enum(MFA_METHODS) }).strict()
export const mfaVerifyInput = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: totpCodeInput }).strict(),
  z.object({ method: z.literal('passkey'), response: authenticationResponseInput }).strict(),
  z.object({ method: z.literal('recovery'), code: recoveryCodeInput }).strict(),
])
export const passkeyBeginInput = empty
export const passkeyFinishInput = z.object({ response: authenticationResponseInput }).strict()
export const signOutInput = empty

// Step-up (FR-AUT-013)
export const stepUpOptionsInput = z.object({ method: z.enum(STEPUP_METHODS) }).strict()
export const stepUpVerifyInput = z.discriminatedUnion('method', [
  z.object({ method: z.literal('passkey'), response: authenticationResponseInput }).strict(),
  z.object({ method: z.literal('totp'), code: totpCodeInput }).strict(),
  z.object({ method: z.literal('password'), password: passwordInput }).strict(),
])

// Account security (FR-AUT-005, 008 to 012, 017, 026)
export const changePasswordInput = z.object({ currentPassword: passwordInput, newPassword: passwordInput }).strict()
export const passkeyRegisterOptionsInput = empty
export const passkeyRegisterVerifyInput = z.object({ response: registrationResponseInput, name: passkeyNameInput }).strict()
export const passkeyRenameInput = z.object({ id: passkeyIdInput, name: passkeyNameInput }).strict()
export const passkeyRemoveInput = z.object({ id: passkeyIdInput }).strict()
export const totpStartInput = empty
export const totpConfirmInput = z.object({ code: totpCodeInput }).strict()
export const totpRemoveInput = empty
export const recoveryCodesRegenerateInput = empty
/** Switch 2FA off (only when not required for the user; step-up). Removes every factor and the codes. */
export const disableMfaInput = z.object({ confirm: z.literal(true) }).strict()
export const revokeSessionInput = z.object({ ref: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict()

// Users (FR-AUT-014, 028)
export const createUserInput = z
  .object({ username: usernameInput, displayName: displayNameInput, role: roleInput, password: passwordInput })
  .strict()
export const setUserStatusInput = z.object({ userId: userIdInput, status: z.enum(USER_STATUSES) }).strict()
export const setUserRoleInput = z.object({ userId: userIdInput, role: roleInput }).strict()
export const userIdOnlyInput = z.object({ userId: userIdInput }).strict()

// Invites and recovery (FR-AUT-015, 016)
export const issueInviteInput = z.object({ role: roleInput, lifetimeMs: ms.min(MINUTE_MS).optional() }).strict()
export const revokeInviteInput = z.object({ id: z.uuid() }).strict()
export const invitePasskeyOptionsInput = z.object({ token: linkTokenInput, username: usernameInput }).strict()
const newCredential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), password: passwordInput }).strict(),
  z.object({ kind: z.literal('passkey'), response: registrationResponseInput, name: passkeyNameInput }).strict(),
])
export const redeemInviteInput = z
  .object({ token: linkTokenInput, username: usernameInput, displayName: displayNameInput.optional(), credential: newCredential })
  .strict()
export const issueRecoveryInput = userIdOnlyInput
export const recoveryPasskeyOptionsInput = z.object({ token: linkTokenInput }).strict()
export const redeemRecoveryInput = z.object({ token: linkTokenInput, credential: newCredential }).strict()

// Connections (FR-AUT-018 to 020)
const hostInput = z.string().trim().min(1).max(300)
const portInput = z.number().int().min(1).max(65535)
const dbName = z.string().min(1).max(64)
const collationName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/)
export const openConnectionInput = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('typed'),
      host: hostInput,
      port: portInput.optional(),
      username: z.string().max(200),
      password: z.string().max(PASSWORD_INPUT_MAX_CHARS),
      tls: z.enum(TLS_MODES).optional(),
      database: dbName.optional(),
      collation: collationName.optional(),
    })
    .strict(),
  z.object({ source: z.literal('profile'), profileId: profileIdInput, database: dbName.optional() }).strict(),
])
export type OpenConnectionInput = z.infer<typeof openConnectionInput>
export const closeConnectionInput = z.object({ connectionId: connectionIdInput }).strict()

// Vault (FR-AUT-021)
export const vaultCreateInput = z.object({ passphrase: passphraseInput }).strict()
export const vaultUnlockInput = z.object({ passphrase: passphraseInput }).strict()
export const vaultChangePassphraseInput = z.object({ currentPassphrase: passphraseInput, newPassphrase: passphraseInput }).strict()
export const vaultUseRecoveryKeyInput = z.object({ recoveryKey: vaultRecoveryKeyInput, newPassphrase: passphraseInput }).strict()
export const vaultRegenerateRecoveryKeyInput = empty
export const vaultRotateKeyInput = z.object({ passphrase: passphraseInput }).strict()
export const vaultLockInput = empty

// Profiles (FR-AUT-022)
export const profileOptionsInput = z
  .object({
    compress: z.boolean().default(false),
    database: dbName.nullable().default(null),
    collation: collationName.nullable().default(null),
    activateRoles: z.boolean().default(false),
    caPem: z.string().max(PEM_MAX_CHARS).nullable().default(null),
    clientCertPem: z.string().max(PEM_MAX_CHARS).nullable().default(null),
  })
  .strict()
export const saveProfileInput = z
  .object({
    /** Absent = new profile. */
    id: profileIdInput.optional(),
    name: z
      .string()
      .trim()
      .refine((s) => codePoints(s) >= 1 && codePoints(s) <= PROFILE_NAME_MAX_CHARS),
    host: hostInput,
    port: portInput.default(PROFILE_DEFAULT_PORT),
    tls: z.enum(TLS_MODES).default('verify'),
    options: profileOptionsInput.default(() => profileOptionsInput.parse({})),
    /** Absent on edit = secrets unchanged; `password` absent = "password unchanged". */
    credentials: z
      .object({
        user: z.string().max(200),
        password: z.string().max(PASSWORD_INPUT_MAX_CHARS).optional(),
        clientKeyPem: z.string().max(PEM_MAX_CHARS).optional(),
      })
      .strict()
      .optional(),
    /** Save without a working test (FR-CFG-042). */
    saveAnyway: z.boolean().default(false),
  })
  .strict()
export type SaveProfileInput = z.infer<typeof saveProfileInput>
export const profileIdOnlyInput = z.object({ id: profileIdInput }).strict()

// Preferences (FR-AUT-024, 025)
export const prefTargetInput = z.string().min(1).max(600)
export const getPrefsInput = z.object({ targetKey: prefTargetInput.optional() }).strict()
export const setPrefInput = z.object({ key: z.string().min(1).max(100), value: z.unknown(), targetKey: prefTargetInput.optional() }).strict()
export const resetPrefsInput = z.object({ confirm: z.literal(true) }).strict()
export const importPrefsInput = z
  .object({
    /** The file text; at most 256 KiB (checked in bytes by the service). */
    json: z.string().max(PREFS_IMPORT_MAX_BYTES),
    mode: z.enum(['merge', 'replace']).default('merge'),
    validOnly: z.boolean().default(false),
  })
  .strict()

/** Export file (FR-AUT-025): no secrets, no factors. */
export const prefsExportFile = z
  .object({
    dbloomPreferences: z.literal(PREFS_EXPORT_VERSION),
    exportedAt: z.string().max(40),
    user: z.record(z.string().max(100), z.unknown()),
    targets: z.record(z.string().max(600), z.record(z.string().max(100), z.unknown())),
  })
  .strict()
export type PrefsExportFile = z.infer<typeof prefsExportFile>

/** Names of the server functions (thin handlers; packages C and D). */
export const AUTH_SERVER_FUNCTIONS = {
  setup: ['setupGetState', 'setupVerifyToken', 'setupSaveStep', 'setupPasskeyOptions', 'setupPasskeyVerify', 'setupTotpStart', 'setupTotpVerify', 'setupComplete'],
  auth: ['passwordSignIn', 'mfaOptions', 'mfaVerify', 'passkeyBegin', 'passkeyFinish', 'signOut', 'stepUpOptions', 'stepUpVerify', 'getSessionInfo', 'getLoginPageInfo'],
  account: [
    'changePassword',
    'listFactors',
    'passkeyRegisterOptions',
    'passkeyRegisterVerify',
    'passkeyRename',
    'passkeyRemove',
    'totpStart',
    'totpConfirm',
    'totpRemove',
    'recoveryCodesRegenerate',
    'disableMfa',
    'listSessions',
    'revokeSession',
    'listNotices',
  ],
  users: ['listUsers', 'createUser', 'setUserStatus', 'setUserRole', 'deleteUser', 'revokeUserSessions'],
  invites: ['issueInvite', 'listInvites', 'revokeInvite', 'invitePasskeyOptions', 'redeemInvite', 'issueRecovery', 'recoveryPasskeyOptions', 'redeemRecovery'],
  connections: ['listConnections', 'openConnection', 'closeConnection'],
  vault: ['vaultStatus', 'vaultCreate', 'vaultUnlock', 'vaultLock', 'vaultChangePassphrase', 'vaultUseRecoveryKey', 'vaultRegenerateRecoveryKey', 'vaultRotateKey'],
  profiles: ['listProfiles', 'saveProfile', 'testProfile', 'deleteProfile'],
  prefs: ['getPrefs', 'setPref', 'exportPrefs', 'importPrefs', 'resetPrefs'],
} as const

/** Functions allowed per session state (section 5.5); `full` = everything the role allows. */
export const STATE_ALLOWED_FUNCTIONS: Record<Exclude<SessionState, 'full'>, readonly string[]> = {
  pending_mfa: ['mfaOptions', 'mfaVerify', 'signOut', 'getSessionInfo'],
  enrol_only: [
    'passkeyRegisterOptions',
    'passkeyRegisterVerify',
    'totpStart',
    'totpConfirm',
    'listFactors',
    'listSessions',
    'signOut',
    'getSessionInfo',
  ],
  must_change: ['changePassword', 'signOut', 'getSessionInfo'],
}

// ---- Preferences registry (FR-AUT-024) ---------------------------------------------------------------------

export const PREF_SCOPES = ['user', 'user+target'] as const
export type PrefScopeKind = (typeof PREF_SCOPES)[number]
/** Categories of the Preferences page (FR-CFG-096). */
export const PREF_CATEGORIES = ['features', 'sql', 'navigation', 'main', 'export', 'import', 'manage'] as const
export type PrefCategory = (typeof PREF_CATEGORIES)[number]

export type PrefDefinition<T = unknown> = {
  key: string
  module: 'auth' | 'rows' | 'io' | 'sql' | 'structure'
  scope: PrefScopeKind
  category: PrefCategory
  schema: z.ZodType<T>
  default: T
  /** `t()` key of the label. */
  label: string
  /** Key as stored today when it differs (rows and io keep their rows; FR-AUT-024). */
  storedAs?: { scope: string; key: string }
}

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]
/** Auth-owned keys (FR-AUT-024). `language` is checked against the shipped list by package D. */
export const AUTH_PREF_KEYS = ['theme', 'language', 'hiddenDatabases', 'navWidth', 'collation', 'loginLanding'] as const
export type AuthPrefKey = (typeof AUTH_PREF_KEYS)[number]
export const AUTH_PREF_SCHEMAS = {
  theme: z.enum(THEMES),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
  hiddenDatabases: z.array(dbName).max(HIDDEN_DATABASES_MAX),
  navWidth: z.number().int().min(160).max(800),
  collation: collationName.nullable(),
  loginLanding: z.boolean(),
} as const satisfies Record<AuthPrefKey, z.ZodType>

export interface PrefsRegistry {
  register(def: PrefDefinition): void
  get(key: string): PrefDefinition | undefined
  all(): readonly PrefDefinition[]
}
export type PrefImportProblem = { key: string; target?: string; reason: string }
export type PrefImportResult = { written: number; skipped: number; problems: PrefImportProblem[] }

// ---- Package A interfaces: crypto primitives ---------------------------------------------------------------

/** `password.ts` (FR-AUT-005). */
export interface PasswordService {
  /** `PASSWORD_NORMALISATION`; length in code points and UTF-8 bytes. */
  normalise(raw: string): string
  /** Policy check; `null` = accepted. `breached` is fail-closed when `failClosed` and the list is unavailable. */
  check(
    password: string,
    ctx: { username: string; minLength: number; breachedCheck: boolean; failClosed: boolean },
  ): Promise<{ reason: PasswordRejectReason | null; breachedListUnavailable: boolean }>
  /** Argon2id PHC; queued (ARGON2_MAX_CONCURRENT, ARGON2_QUEUE_MAX), throws AuthError('auth_throttled') when full. */
  hash(password: string, params: Argon2Params): Promise<string>
  verify(phc: string, password: string): Promise<boolean>
  needsRehash(phc: string, params: Argon2Params): boolean
  /** Same cost as `verify` against a hash of a random password made at start. */
  dummyVerify(password: string): Promise<false>
}

/** `breached.ts` (Q3): sorted SHA-1 list, binary search; `unavailable` when no list could be read. */
export interface BreachedList {
  contains(password: string): Promise<boolean | 'unavailable'>
  source(): { kind: 'bundled' | 'operator' | 'none'; entries: number }
}

/** `secret-key.ts` (FR-AUT-023). */
export interface SecretKeyRing {
  /** First 8 bytes of HMAC(key, "key-id"), base64url, of the current key. */
  readonly currentKeyId: string
  subkey(kind: SubkeyKind): Buffer
  seal(kind: SubkeyKind, aad: string, plaintext: Buffer): string
  /** Undefined for every failure (tamper, wrong AAD, unknown key id; SEC-SAU-067). */
  open(kind: SubkeyKind, aad: string, record: string): Buffer | undefined
  /** True when the record was sealed with the previous key and should be re-sealed on its next write. */
  isStale(record: string): boolean
}
export type LoadSecretKeyResult = { ok: true; ring: SecretKeyRing } | { ok: false; reason: 'missing' | 'short' | 'placeholder' | 'unreadable_file' }

/** `totp.ts` (FR-AUT-008). */
export interface TotpService {
  newSecret(): Buffer
  base32(secret: Buffer): string
  otpauthUri(secret: Buffer, issuer: string, account: string): string
  /** SVG of the URI (uqr). */
  qrSvg(uri: string): string
  /** Accepts steps t−window … t+window greater than `lastStep`; returns the accepted step. Constant-time compare. */
  verify(secret: Buffer, code: string, lastStep: number, window: number, nowMs: number): { ok: true; step: number } | { ok: false }
}

/** `codes.ts` (FR-AUT-010). */
export interface RecoveryCodeService {
  /** RECOVERY_CODE_COUNT codes, formatted `XXXX-XXXX-XXXX`. */
  generate(): string[]
  /** Upper case, Crockford substitutions, without spaces and dashes; undefined when malformed. */
  normalise(input: string): string | undefined
  mac(userId: UserId, normalisedCode: string): string
}

/** `tokens.ts` (FR-AUT-002, 015, 016). */
export interface TokenService {
  /** 160-bit Crockford token in groups of four. */
  newSetupToken(): string
  normaliseSetupToken(input: string): string
  /** 256-bit base64url (ST-082). */
  newLinkToken(): string
  /** SHA-256 hex. */
  hashToken(token: string): string
  /** Constant time over equal-length hashes. */
  equalHashes(a: string, b: string): boolean
  newConnectionId(): ConnectionId
}

/** `vault-crypto.ts` (FR-AUT-021, 022). Keys are Buffers the caller zeroes. */
export interface VaultCrypto {
  /** New vault key, passphrase wrap and recovery wrap; `recoveryKey` is the display form. */
  create(userId: UserId, passphrase: string, params: Argon2Params): Promise<{ record: Omit<VaultRecord, 'createdAt' | 'updatedAt'>; vaultKey: Buffer; recoveryKey: string }>
  unwrapWithPassphrase(record: VaultRecord, passphrase: string): Promise<Buffer | undefined>
  unwrapWithRecoveryKey(record: VaultRecord, recoveryKey: string): Buffer | undefined
  rewrapPassphrase(userId: UserId, vaultKey: Buffer, passphrase: string, params: Argon2Params): Promise<Pick<VaultRecord, 'kdfParams' | 'kdfSalt' | 'wrapPassphrase'>>
  rewrapRecovery(userId: UserId, vaultKey: Buffer): { fields: Pick<VaultRecord, 'recoverySalt' | 'wrapRecovery'>; recoveryKey: string }
  sealProfile(vaultKey: Buffer, userId: UserId, profileId: ProfileId, secret: ProfileSecret): string
  openProfile(vaultKey: Buffer, userId: UserId, profileId: ProfileId, sealed: string): ProfileSecret | undefined
}

// ---- Package B interfaces: store, users, settings, throttle, sessions ---------------------------------------

/** Store additions of migration 5 (section 5.7); only `sqlite-store.ts` implements it, plus a test double. */
export interface AccountStore {
  /** Runs `fn` in one `BEGIN IMMEDIATE` transaction; rethrows after rollback. */
  transaction<T>(fn: () => T): T

  // site and settings
  getSite(): Partial<SiteState>
  setSite(values: Partial<SiteState>): void
  getSettings(): SettingRow[]
  setSetting(row: SettingRow): void

  // users
  createUser(user: User): void
  getUser(id: UserId): User | undefined
  getUserByKey(usernameKey: string): User | undefined
  listUsers(): UserSummary[]
  updateUser(id: UserId, patch: Partial<Omit<User, 'id' | 'usernameKey' | 'webauthnUserId' | 'createdAt' | 'createdBy'>>): void
  /** Cascades to factors, codes, vault, profiles, notices, sessions; preferences by owner key `u:<id>`. */
  deleteUser(id: UserId): void
  countActiveAdmins(): number

  // passwords
  getPassword(userId: UserId): PasswordRecord | undefined
  setPassword(record: PasswordRecord): void
  deletePassword(userId: UserId): void

  // passkeys
  listPasskeys(userId: UserId): PasskeyRecord[]
  getPasskey(id: string): PasskeyRecord | undefined
  addPasskey(record: PasskeyRecord): void
  updatePasskey(id: string, patch: Partial<Pick<PasskeyRecord, 'counter' | 'name' | 'lastUsedAt' | 'backedUp'>>): void
  deletePasskey(userId: UserId, id: string): boolean
  deletePasskeys(userId: UserId): number

  // totp
  getTotp(userId: UserId): TotpRecord | undefined
  setTotp(record: TotpRecord): void
  /** Compare-and-set of `last_step` (replay block): false when `step` is not greater than the stored one. */
  advanceTotpStep(userId: UserId, step: number): boolean
  deleteTotp(userId: UserId): boolean

  // recovery codes
  replaceRecoveryCodes(userId: UserId, macs: string[], createdAt: number): void
  /** Deletes the code when present; true = it existed (single use). */
  consumeRecoveryCode(userId: UserId, codeMac: string): boolean
  countRecoveryCodes(userId: UserId): number
  deleteRecoveryCodes(userId: UserId): number

  // invite and recovery tokens
  addToken(record: LinkTokenRecord): void
  getTokenByHash(tokenHash: string): LinkTokenRecord | undefined
  listOpenInvites(now: number): LinkTokenRecord[]
  /** Open (unused, unrevoked, unexpired) recovery tokens of one user. */
  listOpenRecoveryTokens(userId: UserId, now: number): LinkTokenRecord[]
  /** Sets `used_at` when the token is open (not used, revoked or expired); false otherwise. */
  markTokenUsed(id: string, now: number, userId?: UserId): boolean
  revokeToken(id: string, now: number): boolean
  purgeTokens(before: number): number

  // vault and profiles
  getVault(userId: UserId): VaultRecord | undefined
  setVault(record: VaultRecord): void
  deleteVault(userId: UserId): void
  listProfiles(userId: UserId): ProfileRecord[]
  getProfile(userId: UserId, id: ProfileId): ProfileRecord | undefined
  saveProfile(record: ProfileRecord): void
  deleteProfile(userId: UserId, id: ProfileId): boolean
  countProfiles(userId: UserId): number

  // notices
  addNotice(notice: UserNotice): void
  listNotices(userId: UserId): UserNotice[]
  markNoticeRead(userId: UserId, id: string, at: number): void

  // account sessions (the sessions table with the migration-5 columns)
  createAccountSession(record: AccountSessionRecord): void
  getAccountSession(idHash: string): AccountSessionRecord | undefined
  updateAccountSession(idHash: string, patch: Partial<Omit<AccountSessionRecord, 'idHash' | 'kind' | 'createdAt'>>): void
  /** Replaces the id hash (token regeneration at every state change, SEC-TGT-040). */
  renameSession(oldIdHash: string, newIdHash: string): void
  listUserSessions(userId: UserId): AccountSessionRecord[]
  deleteUserSessions(userId: UserId, exceptIdHash?: string): string[]
}
/** The SQLite store after migration 5. */
export type StoreWithAccounts = Store & { accounts: AccountStore }
/** Migration number that adds the tables of section 5.7. */
export const AUTH_MIGRATION = 5
/** Columns added to `sessions` by migration 5 (8 × `ALTER TABLE ADD COLUMN`). */
export const SESSIONS_NEW_COLUMNS = ['kind', 'user_id', 'state', 'mfa_at', 'stepup_at', 'security_version', 'client_hint', 'address'] as const

/** `settings.ts` (FR-AUT-029). */
export interface AuthSettingsResolver {
  /** Precedence of SEC-TGT-150: `.env` limits, stored value, `.env` default, built-in default; clamped on read. */
  resolve(): ResolvedAuthSettings
  /** Wizard step 3 and the admin module; validated and clamped before writing. */
  write(values: Partial<Pick<ResolvedAuthSettings, SetupSiteSettingKey>>, by: string): void
}

/** `throttle.ts` (FR-AUT-007): keys `acct:<username_key>`, `ip:<address>`, `tgt:<user id>:<host:port:user>`. */
export type ThrottleKey = `acct:${string}` | `ip:${string}` | `tgt:${string}`
export interface Throttle {
  /** Milliseconds to wait before another attempt (0 = allowed). Checked before any hash. */
  delayMs(key: ThrottleKey): number
  fail(key: ThrottleKey): void
  reset(key: ThrottleKey): void
}

/** `users.ts` (FR-AUT-004, 014). Every call audits with actor, subject and outcome. */
export interface UserService {
  usernameKey(username: string): string
  create(input: { username: string; displayName: string; role: Role; password: string }, actor: AuthUser | 'setup' | 'cli', opts?: { temporary: boolean }): Promise<User>
  list(): UserSummary[]
  setStatus(userId: UserId, status: UserStatus, actor: AuthUser): void
  setRole(userId: UserId, role: Role, actor: AuthUser): void
  delete(userId: UserId, actor: AuthUser): void
  revokeSessions(userId: UserId, actor: AuthUser | 'cli'): number
  /** Increments `security_version` and ends the user's other sessions (ST-075). */
  bumpSecurityVersion(userId: UserId, keepIdHash?: string): void
  /** ST-054, ST-055: whether 2FA is required, and whether the grace period has ended. */
  mfaRequirement(user: User, now: number): { required: boolean; graceEnded: boolean }
}

/** Additions to `SessionManager` (FR-AUT-017, 018); direct mode keeps `create`/`resolve` unchanged. */
export interface AccountSessions {
  createAccount(user: User, state: SessionState, meta: { clientHint: string; address: string }): { token: string; csrf: string; evicted: string[] }
  resolveAccount(token: string | undefined, opts: { background: boolean }): AccountContext | undefined
  /** New token and id hash, same row (SEC-TGT-040). */
  transition(token: string, patch: { state?: SessionState; mfaAt?: number; stepupAt?: number }): { token: string; evicted?: string[] }
  addConnection(idHash: string, entry: ConnectionEntry): void
  getConnection(idHash: string, connectionId: ConnectionId): ConnectionEntry | undefined
  listConnections(idHash: string): ConnectionEntry[]
  closeConnection(idHash: string, connectionId: ConnectionId): Promise<boolean>
  /** Target-scoped context for `sessionMiddleware` (header `x-dbloom-connection`). */
  resolveTarget(token: string | undefined, connectionId: string | undefined, opts: { background: boolean }): AccountLiveSession | undefined
  setVaultKey(idHash: string, key: Buffer | undefined): void
  /** Returns the key and counts as vault activity (ST-089). */
  getVaultKey(idHash: string, now: number): Buffer | undefined
  /** Same expiry rules as `getVaultKey` but does not count as vault activity (status polling must not keep the vault open). */
  peekVaultKey(idHash: string, now: number): Buffer | undefined
  /** Epoch ms at which the vault key auto-locks, or undefined when locked. */
  vaultLockAt(idHash: string): number | undefined
  listUserSessions(userId: UserId, currentIdHash: string): SessionInfo[]
  endSession(idHash: string, reason: 'signout' | 'evicted' | 'security' | 'expired' | 'revoked'): Promise<void>
}
/** `scopeKey` of the per-session registries (plans, cell handles, uploads, SQL runs, io jobs). */
export type ScopeKeyFn = (idHash: string, connectionId?: ConnectionId) => string
/** `ownerKeyFor(session)` replaces the three `ownerKeyOf(session.target)` call sites (section 5.2). */
export type OwnerKeyFn = (session: AccountLiveSession | AccountContext) => string

/** Middleware context shapes (package B builds the middlewares). */
export type SessionMiddlewareContext = { session: AccountLiveSession }
export type AccountMiddlewareContext = { account: AccountContext }

// ---- Package C interfaces: setup, sign-in, factors, step-up, invites, recovery ---------------------------------

export interface SetupService {
  startupState(): StartupState
  /** Called at start while setup is pending: loads or generates the token, writes the 0600 file, prints the banner. */
  prepareToken(now: number): void
  verifyToken(token: string, address: string): { cookie: string } // throws AuthError('auth_throttled') or a fixed failure
  state(cookie: string): { draft: SetupDraft; env: SetupEnvStatus } | undefined
  saveStep(cookie: string, input: z.infer<typeof setupSaveStepInput>): Promise<SetupDraft>
  passkeyOptions(cookie: string): Promise<PublicKeyCredentialCreationOptionsJSON>
  passkeyVerify(cookie: string, response: RegistrationResponseJSON, name: string): Promise<void>
  totpStart(cookie: string): { uri: string; secret: string; qrSvg: string }
  totpVerify(cookie: string, code: string): { recoveryCodes: string[] }
  /** One store transaction; a second call or a race loses with 404. */
  complete(cookie: string, input: z.infer<typeof setupCompleteInput>): void
  /** `DBLOOM_AUTO_SETUP=direct` (Q8). */
  autoSetupDirect(now: number): void
  isComplete(): boolean
}

export type SignInResult = { token: string; csrf: string; state: SessionState }
export interface SignInService {
  passwordSignIn(input: { username: string; password: string }, meta: { address: string; clientHint: string }): Promise<SignInResult>
  mfaOptions(ctx: AccountContext, method: MfaMethod): Promise<PublicKeyCredentialRequestOptionsJSON | { method: 'totp' | 'recovery' }>
  mfaVerify(ctx: AccountContext, token: string, input: z.infer<typeof mfaVerifyInput>): Promise<SignInResult>
  passkeyBegin(meta: { address: string }): Promise<{ preAuthCookie: string; options: PublicKeyCredentialRequestOptionsJSON }>
  passkeyFinish(preAuthCookie: string, response: AuthenticationResponseJSON, meta: { address: string; clientHint: string }): Promise<SignInResult>
  signOut(token: string | undefined): Promise<void>
}

export interface ChallengeStore {
  create(owner: string, purpose: ChallengePurpose, data?: { userId?: UserId; challenge?: string }): ChallengeRecord
  /** Removes and returns the challenge (single use, FR-AUT-011). */
  take(owner: string, purpose: ChallengePurpose): ChallengeRecord | undefined
  /** TOTP step: counts a try and keeps it until CHALLENGE_MAX_TRIES. */
  countTry(owner: string, purpose: ChallengePurpose): ChallengeRecord | undefined
  dropOwner(owner: string): void
}

/**
 * The library throws for origin, RP, challenge, UV and counter failures but returns `verified: false` for a bad
 * signature (spike 0): implementations treat both as `mfa_failed`.
 */
export interface WebAuthnService {
  registrationOptions(user: User, existing: PasskeyRecord[], purpose: ChallengePurpose, owner: string): Promise<PublicKeyCredentialCreationOptionsJSON>
  /** `requireUserVerification` per SEC-TGT-014; library errors map to `mfa_failed`, detail to the log. */
  verifyRegistration(owner: string, purpose: ChallengePurpose, response: RegistrationResponseJSON, opts: { requireUserVerification: boolean }): Promise<Omit<PasskeyRecord, 'userId' | 'name' | 'createdAt' | 'lastUsedAt'>>
  authenticationOptions(owner: string, purpose: ChallengePurpose, allow?: PasskeyRecord[]): Promise<PublicKeyCredentialRequestOptionsJSON>
  verifyAuthentication(owner: string, purpose: ChallengePurpose, response: AuthenticationResponseJSON, credential: PasskeyRecord, opts: { requireUserVerification: boolean }): Promise<{ newCounter: number; userVerified: boolean; backedUp: boolean }>
}

export interface StepUp {
  /** Throws AuthError('stepup_required') when `stepup_at` is outside the window. */
  requireRecentFactor(ctx: AccountContext, purpose: string): void
  options(ctx: AccountContext, method: StepUpMethod): Promise<PublicKeyCredentialRequestOptionsJSON | { method: 'totp' | 'password' }>
  verify(ctx: AccountContext, token: string, input: z.infer<typeof stepUpVerifyInput>): Promise<{ token: string; stepUpUntil: number }>
}

export interface InviteService {
  issue(actor: AuthUser, input: { role: Role; lifetimeMs?: number }): { id: string; link: string; expiresAt: number }
  list(): InviteInfo[]
  revoke(actor: AuthUser, id: string): void
  passkeyOptions(token: string, username: string, preAuthOwner: string): Promise<PublicKeyCredentialCreationOptionsJSON>
  redeem(input: z.infer<typeof redeemInviteInput>, meta: { address: string; preAuthOwner?: string }): Promise<{ userId: UserId }>
}

export interface RecoveryService {
  issue(actor: AuthUser | 'cli', userId: UserId): { link: string; expiresAt: number }
  passkeyOptions(token: string, preAuthOwner: string): Promise<PublicKeyCredentialCreationOptionsJSON>
  /** One transaction (ST-085): new credential, factors and codes deleted, sessions ended, notices, vault untouched. */
  redeem(input: z.infer<typeof redeemRecoveryInput>, meta: { address: string; preAuthOwner?: string }): Promise<{ userId: UserId }>
}

export type CliResult = { exitCode: 0 | 1 | 2; stdout: string }

// ---- Package D interfaces: connections, vault, profiles, preferences ------------------------------------------

export interface ConnectionService {
  open(ctx: AccountContext, input: OpenConnectionInput, meta: { address: string }): Promise<ConnectionInfo>
  close(ctx: AccountContext, connectionId: ConnectionId): Promise<void>
  list(ctx: AccountContext): ConnectionInfo[]
  /** G5 reconnect with the held credential (typed: session memory; profile: unlocked vault, else `vault_locked`). */
  reconnect(session: AccountLiveSession): Promise<TargetPool>
  /** Hook for the server module's "change my password" (FR-SAU-029). */
  updateHeldCredential(scopeKey: string, password: string): { profileUpdateOffered: boolean }
}

/** Rules before any network contact and after connecting (FR-AUT-020); used by both modes. */
export interface TargetConnectRules {
  checkPolicy(target: TargetKey, password: string, settings: Pick<ResolvedAuthSettings, 'allowEmptyTargetPassword' | 'denyRootTarget'>): void // throws AuthError('target_policy')
  afterConnect(pool: TargetPool, opts: { collation?: string | null; activateRoles?: boolean; database?: string | null }): Promise<{ database: string | null }>
}

export interface VaultService {
  status(ctx: AccountContext): VaultStatus
  create(ctx: AccountContext, passphrase: string): Promise<{ recoveryKey: string }>
  unlock(ctx: AccountContext, passphrase: string): Promise<void>
  lock(ctx: AccountContext): void
  changePassphrase(ctx: AccountContext, current: string, next: string): Promise<void>
  /** Forces a new passphrase and a new recovery key. */
  useRecoveryKey(ctx: AccountContext, recoveryKey: string, newPassphrase: string): Promise<{ recoveryKey: string }>
  regenerateRecoveryKey(ctx: AccountContext): { recoveryKey: string }
  /** Needs the passphrase (re-wrap) and returns the new recovery key. */
  rotateKey(ctx: AccountContext, passphrase: string): Promise<{ recoveryKey: string }>
}

export interface ProfileService {
  list(ctx: AccountContext): ProfileInfo[]
  save(ctx: AccountContext, input: SaveProfileInput): Promise<{ profile: ProfileInfo; test: 'ok' | 'failed' | 'skipped' }>
  test(ctx: AccountContext, input: SaveProfileInput): Promise<{ ok: true } | { ok: false; error: AuthErrorBody }>
  delete(ctx: AccountContext, id: ProfileId): void
  /** Decrypted secret for `connections.open`; needs the unlocked vault. */
  secretFor(ctx: AccountContext, id: ProfileId): { profile: ProfileRecord; secret: ProfileSecret }
}

export interface PrefsService {
  get(ownerKey: string, targetKey?: string): Record<string, unknown>
  /** Per key (FR-CFG-014, FR-UPD-003); never touches another key or a security table. */
  set(ownerKey: string, key: string, value: unknown, targetKey?: string): void
  export(ownerKey: string, user: AuthUser | null): PrefsExportFile
  import(ownerKey: string, input: z.infer<typeof importPrefsInput>): PrefImportResult
  reset(ownerKey: string): void
}
