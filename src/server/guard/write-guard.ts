import type { GuardContext } from '../structure/types'

export type WriteGuardCode =
  | 'read-only'
  | 'token-missing'
  | 'token-invalid'
  | 'token-expired'
  | 'token-used'
  | 'timeout'
  | 'invalid-timeout'

/** Thrown by the write guard. Messages are neutral and never echo input (SEC-TGT-050 guard rail). */
export class WriteGuardError extends Error {
  /** Set on `timeout`: whether the dedicated connection can still be used. */
  connectionUsable?: boolean
  constructor(
    public code: WriteGuardCode,
    message: string,
  ) {
    super(message)
    this.name = 'WriteGuardError'
  }
}

/** SEC-TGT-052: refuses when the connection is read-only (forced by .env or set per session). */
export function assertWritable(ctx: GuardContext): void {
  if (ctx.forcedReadOnly || ctx.sessionReadOnly) {
    throw new WriteGuardError('read-only', 'This connection is read-only.')
  }
}
