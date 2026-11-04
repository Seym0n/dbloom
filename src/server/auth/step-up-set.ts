/** SPEC/33 FR-APR-001 (SEC-TGT-143, ST-093): the declared step-up set.
 *
 * Every purpose passed to `requireRecentFactor` is listed here with its area. `tests/protect-stepup-set.test.ts`
 * scans `src/server` and fails on a literal purpose outside this set and on an entry with no caller, so a new
 * administrative action cannot skip step-up silently. The window (ST-034) is one value for all purposes.
 */
export type StepUpArea = 'settings' | 'users' | 'invites' | 'audit' | 'account'

export const STEP_UP_SET = {
  'settings.write': 'settings',
  'user.create': 'users',
  'user.status': 'users',
  'user.role': 'users',
  'user.delete': 'users',
  'user.revoke_sessions': 'users',
  'invite.issue': 'invites',
  'invite.revoke': 'invites',
  'recovery.issue': 'invites',
  'audit.export': 'audit',
  'passkey.add': 'account',
  'passkey.remove': 'account',
  'totp.add': 'account',
  'totp.remove': 'account',
  'recovery.regenerate': 'account',
  'mfa.disable': 'account',
} as const satisfies Record<string, StepUpArea>

export type StepUpPurpose = keyof typeof STEP_UP_SET

export const isStepUpPurpose = (purpose: string): purpose is StepUpPurpose => Object.hasOwn(STEP_UP_SET, purpose)
