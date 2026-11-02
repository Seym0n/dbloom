import type { Config } from './config'
import { audit } from './audit'
import { openTargetPool } from './db/target-pool'
import { resolveAllowedAddress } from './host-policy'
import { FailureLimiter } from './rate-limit'
import { AuthError, type ResolvedAuthSettings } from './auth/types'
import type { ConnectRules } from './auth/connections'
import type { SessionManager } from './sessions'
import { normaliseTarget, type TargetKey } from './target'

export const LOGIN_FAILED = 'Sign-in failed. Check the server, user name and password.'

export class LoginFailedError extends Error {
  constructor() {
    super(LOGIN_FAILED)
    this.name = 'LoginFailedError'
  }
}

export type LoginInput = { host: string; port?: number; username: string; password: string }

/** Connect rules of direct mode (FR-AUT-020, both modes): policy before the network, collation and roles after. */
export type DirectRules = {
  rules?: ConnectRules
  settings?: () => Pick<ResolvedAuthSettings, 'allowEmptyTargetPassword' | 'denyRootTarget'>
  /** The user's saved default collation for a target (preference `collation`); direct mode has no profile. */
  collation?: (target: TargetKey) => string | null | undefined
}

const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60_000

/** Direct-mode login (SCN-004). Every failure, whatever the cause, is the same error (SEC-TGT-018). */
export class DirectAuth {
  private byAddress = new FailureLimiter(MAX_FAILURES * 4, WINDOW_MS)
  private byTarget = new FailureLimiter(MAX_FAILURES, WINDOW_MS)

  constructor(
    private config: Config,
    private sessions: SessionManager,
    private options: DirectRules = {},
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
      // Policy refusals name their reason and count nothing: they reveal nothing about the target (FR-AUT-020).
      this.options.rules?.checkPolicy(target, input.password, this.options.settings?.() ?? { allowEmptyTargetPassword: true, denyRootTarget: false })
      const address = await resolveAllowedAddress(target, this.config)
      const pool = await openTargetPool(target, address, input.password, this.config)
      try {
        await this.options.rules?.afterConnect(pool, { collation: this.options.collation?.(target) ?? null })
      } catch (error) {
        await pool.end().catch(() => undefined)
        throw error
      }
      const session = this.sessions.create(target, pool)
      this.byTarget.reset(targetKey)
      audit('login.ok', { target: `${target.host}:${target.port}`, user: target.username })
      return session
    } catch (error) {
      if (error instanceof AuthError && error.code === 'target_policy') throw error
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
