/**
 * Catalog of audit event names (SPEC/29 FR-AAU-010). `audit()` checks every event against it so a typo or an unlisted
 * new event is caught: it throws under test and logs an error in production (the line is still written, losing audit
 * evidence would be worse). To add an event: add its name here, then use it.
 */
export const AUDIT_EVENTS = [
  // auth-account (FR-AUT-027)
  'setup.token',
  'setup.token_failed',
  'setup.complete',
  'setup.auto',
  'auth.signin',
  'auth.mfa',
  'auth.signout',
  'auth.stepup',
  'auth.error',
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
  // direct mode and account pages
  'login.ok',
  'login.failed',
  'logout',
  'account.factor',
  'account.password',
  'account.session.revoked',
  'table.open',
  'table.count',
  // structure, sql, rows
  'structure.preview',
  'structure.statement',
  'sql.run',
  'sql.statement',
  'rows.change',
  'rows.refused',
  // io
  'io.export.start',
  'io.export.end',
  'io.import.start',
  'io.import.end',
  'io.import.analyse',
  'io.job.cancel',
  'io.job.resume',
  'io.upload',
  'io.upload.refused',
  // the audit module itself
  'audit.purge',
  'audit.export',
  'audit.sink',
  'exposure.ack',
  // the settings editor (SPEC/32); `settings.clamped` is in the auth-account list above
  'settings.change',
  'settings.reset',
  // guarded changes and their auto-revert (SPEC/33)
  'settings.pending',
  'settings.confirm',
  'settings.cancel',
  'settings.revert',
] as const

export type AuditEventName = (typeof AUDIT_EVENTS)[number]

const KNOWN: ReadonlySet<string> = new Set(AUDIT_EVENTS)

export const isAuditEvent = (name: string): name is AuditEventName => KNOWN.has(name)
