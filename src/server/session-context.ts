/**
 * Mode-aware session resolution for target-scoped server functions and raw routes (SPEC/26 FR-AUT-018, 5.2, 5.5).
 * Pure over the runtime parts it needs, so unit tests pass fakes.
 *
 * Account mode: the session cookie plus the `x-dbloom-connection` header select one held connection. The returned
 * `LiveSession` has the same shape modules already use, with `idHash` = scope key (`idHash/connectionId`), so every
 * per-session registry (plans, handles, uploads, runs, io jobs) is scoped to the connection without touching the
 * modules; `ownerKey` is `u:<user id>`. Direct mode: unchanged (`idHash` is the session id hash, no `ownerKey`).
 */
import type { TargetPool } from './db/target-pool'
import { getAccountServices } from './auth/account-runtime'
import { assertNotInMaintenance } from './maintenance'
import type { Runtime } from './runtime'
import type { LiveSession } from './sessions'
import { AuthError, STATE_ALLOWED_FUNCTIONS, type AccountContext, type AccountLiveSession, type LoginMode, type SessionState } from './auth/types'

export type SessionContextRuntime = Pick<Runtime, 'sessions'> & Partial<Pick<Runtime, 'setup' | 'settings'>>
/** Resolved target session; `sessionIdHash` is the real session id hash (`idHash` is the scope key). */
export type TargetSession = AccountLiveSession & { sessionIdHash: string }

/** `setup_pending` while the first-run wizard has not completed; the result of "ready" is remembered per runtime. */
const readyRuntimes = new WeakSet<object>()
export function assertSetupDone(runtime: Pick<Runtime, 'setup'>): void {
  if (readyRuntimes.has(runtime)) return
  if (runtime.setup.startupState().kind === 'setup_pending') throw new AuthError('setup_pending')
  readyRuntimes.add(runtime)
}

/** Stateless installs and direct installs are `direct`; only a completed account setup is `account`. */
export function loginModeOf(runtime: Partial<Pick<Runtime, 'setup'>>): LoginMode {
  const state = runtime.setup?.startupState()
  return state?.kind === 'ready' ? state.mode : 'direct'
}

/** A pool that was ended (`pool.end()`) and must be reopened with the held credential (G5). */
export const poolIsClosed = (pool: TargetPool): boolean => (pool as unknown as { pool?: { _closed?: boolean } }).pool?._closed === true

/** G5: the account services reopen a closed pool with the held credential. */
const defaultReconnect = (session: AccountLiveSession) => getAccountServices().connections.reconnect(session)

export type ResolveInput = { token: string | undefined; connectionId: string | undefined; csrf: string | undefined; background: boolean; /** Raw GET routes (downloads) skip the CSRF check, like the skeleton did. Default true. */ requireCsrf?: boolean }

export async function resolveTargetSession(
  runtime: SessionContextRuntime,
  input: ResolveInput,
  reconnect: (session: AccountLiveSession) => Promise<TargetPool> = defaultReconnect,
): Promise<(LiveSession & { sessionIdHash?: string }) | undefined> {
  const { sessions } = runtime
  if (loginModeOf(runtime) !== 'account') {
    const session = sessions.resolve(input.token)
    if (!session || (input.requireCsrf !== false && !sessions.verifyCsrf(session, input.csrf))) return undefined
    return session
  }
  const resolved = sessions.resolveTarget(input.token, input.connectionId, { background: input.background })
  if (!resolved || (input.requireCsrf !== false && !sessions.verifyCsrf(resolved, input.csrf))) return undefined
  // Maintenance mode (ST-218): throws `maintenance` for a user; raw routes turn it into their neutral refusal.
  assertNotInMaintenance(runtime, resolved.user)
  let pool = resolved.pool
  if (poolIsClosed(pool)) {
    try {
      pool = await reconnect(resolved)
    } catch {
      return undefined
    }
  }
  return { ...resolved, pool, sessionIdHash: resolved.idHash, idHash: resolved.scopeKey }
}

/** Per-state allow-list of section 5.5: throws the state's error code unless the function may run in the state. */
const STATE_CODES = { pending_mfa: 'mfa_required', enrol_only: 'enrol_required', must_change: 'password_change_required' } as const
export function stateGate(state: SessionState, fn?: string): void {
  if (state === 'full') return
  if (fn && STATE_ALLOWED_FUNCTIONS[state].includes(fn)) return
  throw new AuthError(STATE_CODES[state])
}

export type { AccountContext }
