/** SPEC/33 FR-APR-003: the guarded set.
 *
 * Settings whose change can lock administrators or all users out of DBLoom itself (SPEC/12 C-02). A guarded change
 * applies at once and reverts after the auto-revert period unless an administrator confirms it from a session that
 * signed in after the change. Fixed in code, never configurable. A later key (IP lists of `admin-plane`) joins by
 * being added here; the pending table and the page need no change.
 */
import type { AuthSettingKey } from './auth/types'

export const GUARDED_KEYS = [
  // second factor (ST-054, 056, 057)
  'mfaScope',
  'mfaRoles',
  'mfaFactors',
  'primaryCredentials',
  // login throttling (ST-076 to 078)
  'loginFailures',
  'loginBackoffCapMs',
  'loginWindowMs',
  'loginAddressFailures',
  // administrator session lifetimes (ST-069, 070)
  'adminSessionIdleMs',
  'adminSessionAbsoluteMs',
] as const satisfies readonly AuthSettingKey[]

export type GuardedKey = (typeof GUARDED_KEYS)[number]

const GUARDED = new Set<string>(GUARDED_KEYS)
export const isGuardedKey = (key: string): key is GuardedKey => GUARDED.has(key)
