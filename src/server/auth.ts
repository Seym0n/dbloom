import type { Config } from './config'
import { audit } from './audit'
import { openTargetPool } from './db/target-pool'
import { resolveAllowedAddress } from './host-policy'
import { FailureLimiter } from './rate-limit'
import type { SessionManager } from './sessions'
import { normaliseTarget } from './target'

export const LOGIN_FAILED = 'Sign-in failed. Check the server, user name and password.'

export class LoginFailedError extends Error {
  constructor() {
    super(LOGIN_FAILED)
    this.name = 'LoginFailedError'
  }
}

export type LoginInput = { host: string; port?: number; username: string; password: string }

const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60_000

/** Direct-mode login (SCN-004). Every failure, whatever the cause, is the same error (SEC-TGT-018). */
export class DirectAuth {
  private byAddress = new FailureLimiter(MAX_FAILURES * 4, WINDOW_MS)
  private byTarget = new FailureLimiter(MAX_FAILURES, WINDOW_MS)

  constructor(
    private config: Config,
    private sessions: SessionManager,
  ) {}

  async login(input: LoginInput, clientAddress: string): Promise<{ token: string; csrf: string }> {
    const addressKey = `ip:${clientAddress}`
    let targetKey = `raw:${input.host.trim().toLowerCase()}:${input.username}`
    try {
      const target = normaliseTarget(input.host, input.port, input.username)
      targetKey = `${target.host}${target.zone ?? ''}:${target.port}:${target.username}`
      if (this.byAddress.isBlocked(addressKey) || this.byTarget.isBlocked(targetKey)) {
        throw new LoginFailedError()
      }
      const address = await resolveAllowedAddress(target, this.config)
      const pool = await openTargetPool(target, address, input.password, this.config)
      const session = this.sessions.create(target, pool)
      this.byTarget.reset(targetKey)
      audit('login.ok', { target: `${target.host}:${target.port}`, user: target.username })
      return session
    } catch (error) {
      this.byAddress.fail(addressKey)
      this.byTarget.fail(targetKey)
      audit('login.failed', {
        target: targetKey,
        reason:
          error instanceof LoginFailedError
            ? 'blocked'
            : error instanceof Error
              ? error.name
              : 'unknown',
      })
      throw new LoginFailedError()
    }
  }
}
