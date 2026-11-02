/** Link services (invites, recovery) and the step-up primitive they share with the administrator functions. */
import { createInviteService } from './invites'
import type { LinkDeps } from './links'
import { createRecoveryService } from './recovery'
import { getRuntime } from '../runtime'
import { getSignInServices } from './signin-runtime'
import { tokens } from './tokens'
import type { AccountStore, InviteService, PasswordService, RecoveryService, ResolvedAuthSettings, StepUp, Throttle, UserService, WebAuthnService } from './types'

export type LinkServices = { invites: InviteService; recovery: RecoveryService; stepUp: Pick<StepUp, 'requireRecentFactor'> }

export type LinkWiring = {
  store: AccountStore
  throttle: Throttle
  settings: () => ResolvedAuthSettings
  users: Pick<UserService, 'usernameKey'>
  passwords: Pick<PasswordService, 'check' | 'hash'>
  webauthn: Pick<WebAuthnService, 'registrationOptions' | 'verifyRegistration'>
  stepUp: Pick<StepUp, 'requireRecentFactor'>
  /** Closes the in-memory connections of sessions the store dropped (recovery, FR-AUT-016). */
  onSessionsEnded: (idHashes: string[]) => void
  now?: () => number
}

/** Pure composition (tests pass fakes); `LinkDeps` is the shared dependency record of both services. */
export function buildLinkServices(w: LinkWiring): LinkServices {
  const deps: LinkDeps = {
    store: w.store, tokens, users: w.users, passwords: w.passwords, webauthn: w.webauthn, throttle: w.throttle,
    settings: w.settings, onSessionsEnded: w.onSessionsEnded, ...(w.now ? { now: w.now } : {}),
  }
  return { invites: createInviteService(deps), recovery: createRecoveryService(deps), stepUp: w.stepUp }
}

let services: LinkServices | undefined

export function setLinkServices(s: LinkServices): void {
  services = s
}

/** Built on first use from the runtime and the sign-in services (account mode; direct installs never call it). */
export function getLinkServices(): LinkServices {
  if (services) return services
  const runtime = getRuntime()
  const { deps, stepUp } = getSignInServices()
  services = buildLinkServices({
    store: runtime.store.accounts,
    throttle: runtime.throttle,
    settings: () => deps.settings.resolve(),
    users: deps.users,
    passwords: deps.password,
    webauthn: deps.webauthn,
    stepUp,
    onSessionsEnded: (ids) => ids.forEach((id) => void runtime.sessions.endSession(id)),
  })
  return services
}
