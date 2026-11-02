/** Start gate (FR-AUT-001): login mode, setup state and the account-mode start checks. Pure; the runtime feeds it. */
import { loadSecretKey } from './secret-key'
import { AUTH_ENV, LOGIN_MODES, type LoginMode, type SiteState, type StartupState } from './types'

/** A configuration that must stop the start; the message names the cause and never a secret. */
export class StartRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartRefusal'
  }
}

export type StartDecision = {
  state: StartupState
  /** `DBLOOM_AUTO_SETUP=direct` on a fresh store: the caller completes the direct setup before serving. */
  autoSetup: boolean
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i

/** `DBLOOM_PUBLIC_ORIGIN`: https, or http on loopback only; no path, query or credentials. Returns the origin. */
export function parsePublicOrigin(raw: string | undefined): { ok: true; origin: URL } | { ok: false } {
  if (!raw || !raw.trim()) return { ok: false }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false }
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return { ok: false }
  if (url.protocol === 'https:') return { ok: true, origin: url }
  if (url.protocol === 'http:' && LOOPBACK.test(url.hostname)) return { ok: true, origin: url }
  return { ok: false }
}

export function parseLoginMode(raw: string | undefined): LoginMode | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if ((LOGIN_MODES as readonly string[]).includes(value)) return value as LoginMode
  throw new StartRefusal(`${AUTH_ENV.loginMode} must be account or direct`)
}

/** Account mode needs a valid public origin and the server key (FR-AUT-001, FR-AUT-023). */
export function checkAccountEnv(env: NodeJS.ProcessEnv): void {
  if (!parsePublicOrigin(env[AUTH_ENV.publicOrigin]).ok) {
    throw new StartRefusal(`Account mode needs ${AUTH_ENV.publicOrigin} (https, or http on a loopback address)`)
  }
  const key = loadSecretKey(env)
  if (!key.ok) {
    throw new StartRefusal(`Account mode needs the server key in ${AUTH_ENV.secretKey} or ${AUTH_ENV.secretKeyFile} (${key.reason})`)
  }
}

/**
 * Decides the start state. `site` is the stored `site` table (empty while setup is pending); `stateless` is
 * `DBLOOM_STORE=none`. Throws `StartRefusal` for a mode mismatch or a missing account-mode prerequisite.
 */
export function evaluateStart(input: { env: NodeJS.ProcessEnv; stateless: boolean; site: Partial<SiteState> }): StartDecision {
  const { env, stateless, site } = input
  const envMode = parseLoginMode(env[AUTH_ENV.loginMode])
  const auto = env[AUTH_ENV.autoSetup]?.trim()
  if (auto && auto !== 'direct') throw new StartRefusal(`${AUTH_ENV.autoSetup} accepts only the value direct`)

  if (stateless) {
    if (envMode === 'account') throw new StartRefusal(`${AUTH_ENV.loginMode}=account needs a store; DBLOOM_STORE=none is always direct mode`)
    return { state: { kind: 'stateless' }, autoSetup: false }
  }

  if (site.setupCompletedAt === undefined) {
    if (auto === 'direct') {
      if (envMode === 'account') throw new StartRefusal(`${AUTH_ENV.autoSetup}=direct conflicts with ${AUTH_ENV.loginMode}=account; account mode always uses the wizard`)
      return { state: { kind: 'ready', mode: 'direct' }, autoSetup: true }
    }
    return { state: { kind: 'setup_pending', storeMode: 'stateful', ...(envMode ? { preselectedMode: envMode } : {}) }, autoSetup: false }
  }

  const stored = site.loginMode
  if (!stored) throw new StartRefusal('The store has a completed setup but no login mode; restore the store or reset it')
  if (envMode && envMode !== stored) {
    throw new StartRefusal(
      `${AUTH_ENV.loginMode}=${envMode} differs from the stored login mode "${stored}". Remove the variable or set it to ${stored}; switching modes needs the migration command (not available yet)`,
    )
  }
  if (stored === 'account') checkAccountEnv(env)
  return { state: { kind: 'ready', mode: stored }, autoSetup: false }
}
