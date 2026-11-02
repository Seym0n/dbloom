/** Client-side check of the setup wizard's site values (step 3); the server validates again with the same bounds. */
import {
  MFA_SCOPES,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_ENV_FLOOR,
  VAULT_PASSPHRASE_MIN_FLOOR,
  type SetupSiteValues,
} from '~/server/auth/types'

export type SiteField = keyof SetupSiteValues
export type SiteErrors = Partial<Record<SiteField, 'required' | 'range' | 'pick'>>

const intIn = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max

export function validateSite(v: SetupSiteValues, mode: 'account' | 'direct'): SiteErrors {
  const e: SiteErrors = {}
  if (v.siteName.trim().length < 1) e.siteName = 'required'
  else if (v.siteName.trim().length > 80) e.siteName = 'range'
  if (mode === 'direct') return e
  if (!(MFA_SCOPES as readonly string[]).includes(v.mfaScope)) e.mfaScope = 'pick'
  if (v.mfaScope === 'roles' && v.mfaRoles.length === 0) e.mfaRoles = 'pick'
  if (v.mfaFactors.length === 0) e.mfaFactors = 'pick'
  if (v.primaryCredentials.length === 0) e.primaryCredentials = 'pick'
  if (!(Number.isFinite(v.mfaGraceMs) && v.mfaGraceMs >= 0 && v.mfaGraceMs <= 7 * 86_400_000)) e.mfaGraceMs = 'range'
  if (!intIn(v.passwordMinLength, PASSWORD_MIN_LENGTH_ENV_FLOOR, PASSWORD_MIN_LENGTH_CEILING)) e.passwordMinLength = 'range'
  if (!intIn(v.sessionsPerUser, 1, 20)) e.sessionsPerUser = 'range'
  if (!(v.tempPasswordMs >= 3_600_000)) e.tempPasswordMs = 'range'
  if (!(v.inviteLifetimeMs >= 60_000)) e.inviteLifetimeMs = 'range'
  if (!(v.recoveryLinkLifetimeMs >= 60_000)) e.recoveryLinkLifetimeMs = 'range'
  if (!intIn(v.vaultPassphraseMin, VAULT_PASSPHRASE_MIN_FLOOR, 256)) e.vaultPassphraseMin = 'range'
  if (!(v.vaultAutoLockMs >= 60_000)) e.vaultAutoLockMs = 'range'
  return e
}
