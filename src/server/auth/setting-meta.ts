/**
 * Display metadata of the settings registry (SPEC/32 FR-ASE-001): group, kind, unit and choices per key. Kept beside
 * `AUTH_SETTINGS` rather than inside it so the table of limits stays one line per key. `satisfies` makes a new key without
 * metadata a compile error; a test checks that every key has an i18n label.
 */
import {
  DAY_MS,
  FACTOR_KINDS,
  HOUR_MS,
  MFA_SCOPES,
  MINUTE_MS,
  PRIMARY_CREDENTIALS,
  ROLES,
  SESSION_LIMIT_ACTIONS,
  type AuthSettingKey,
} from './types'

export type SettingKind = 'number' | 'boolean' | 'choice' | 'list' | 'text' | 'object'
export const SETTING_GROUPS = ['signin', 'passwords', 'sessions', 'throttling', 'links', 'vault', 'targets', 'audit', 'site', 'system'] as const
export type SettingGroup = (typeof SETTING_GROUPS)[number]
export type SettingUnit = 'count' | 'minutes' | 'hours' | 'days' | 'characters' | 'milliseconds' | 'none'

export type SettingMeta = {
  group: SettingGroup
  kind: SettingKind
  unit: SettingUnit
  /** Milliseconds (or characters, counts) per displayed unit: the page shows `stored / factor`. */
  factor: number
  /** Allowed members of a `choice` or `list` setting. */
  choices?: readonly string[]
}

const n = (group: SettingGroup, unit: SettingUnit = 'count', factor = 1): SettingMeta => ({ group, kind: 'number', unit, factor })
const min = (group: SettingGroup) => n(group, 'minutes', MINUTE_MS)
const hrs = (group: SettingGroup) => n(group, 'hours', HOUR_MS)
const days = (group: SettingGroup) => n(group, 'days', DAY_MS)
const bool = (group: SettingGroup): SettingMeta => ({ group, kind: 'boolean', unit: 'none', factor: 1 })
const choice = (group: SettingGroup, choices: readonly string[]): SettingMeta => ({ group, kind: 'choice', unit: 'none', factor: 1, choices })
const list = (group: SettingGroup, choices: readonly string[]): SettingMeta => ({ group, kind: 'list', unit: 'none', factor: 1, choices })
const text = (group: SettingGroup): SettingMeta => ({ group, kind: 'text', unit: 'characters', factor: 1 })
const object = (group: SettingGroup): SettingMeta => ({ group, kind: 'object', unit: 'none', factor: 1 })

export const SETTING_META = {
  loginMode: choice('system', ['account', 'direct']),
  setupTokenValidityMs: min('system'),
  mfaScope: choice('signin', MFA_SCOPES),
  mfaRoles: list('signin', ROLES),
  mfaGraceMs: days('signin'),
  mfaFactors: list('signin', FACTOR_KINDS),
  primaryCredentials: list('signin', PRIMARY_CREDENTIALS),
  totpWindow: n('signin'),
  passwordMinLength: n('passwords', 'characters'),
  breachedCheck: bool('passwords'),
  argon2Login: object('passwords'),
  argon2Vault: object('vault'),
  tempPasswordMs: hrs('passwords'),
  adminSessionIdleMs: min('sessions'),
  adminSessionAbsoluteMs: hrs('sessions'),
  sessionsPerUser: n('sessions'),
  sessionsPerAdmin: n('sessions'),
  sessionsAtLimit: choice('sessions', SESSION_LIMIT_ACTIONS),
  loginFailures: n('throttling'),
  loginBackoffCapMs: min('throttling'),
  loginWindowMs: min('throttling'),
  loginAddressFailures: n('throttling'),
  inviteLifetimeMs: hrs('links'),
  recoveryLinkLifetimeMs: hrs('links'),
  vaultPassphraseMin: n('vault', 'characters'),
  vaultAutoLockMs: min('vault'),
  personalProfiles: bool('targets'),
  allowEmptyTargetPassword: bool('targets'),
  denyRootTarget: bool('targets'),
  loginAutofocus: bool('system'),
  loginRecall: bool('signin'),
  auditRetentionDays: n('audit', 'days'),
  noticeBurstFailures: n('audit'),
  noticeBurstMinutes: n('audit', 'minutes'),
  noticeLocationDays: n('audit', 'days'),
  stepUpWindowMs: min('signin'),
  autoRevertMs: min('signin'),
  loginNotice: text('site'),
  infoBanner: text('site'),
  maintenanceOn: bool('site'),
  maintenanceEndsAt: n('site', 'milliseconds'),
} as const satisfies Record<AuthSettingKey, SettingMeta>
