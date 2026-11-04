/** Package C composition: builds the sign-in, WebAuthn and step-up services once from the runtime.
 *
 * Kept out of `*.functions.ts` (a server-function file must export only server functions). Other server code that
 * needs the step-up primitive calls `getSignInServices().stepUp`; the runtime wiring passes it to `setLinkServices`.
 */
import { loadSecretKey } from './secret-key'
import { createChallengeStore } from './challenges'
import { createRecoveryCodeService } from './codes'
import { lazyBreachedList } from './breached'
import { createPasswordService } from './password'
import { createSignInService, type SignInDeps } from './signin'
import { createStepUp } from './stepup'
import { auditSettingClamp, createAuthSettingsResolver } from './settings'
import { onSettingsChanged } from '../settings-runtime'
import { maintenanceBlocks, maintenanceView } from '../maintenance'
import { OwnTotp } from './totp'
import { getPrefsService } from './prefs/runtime'
import { createUserService } from './users'
import { createWebAuthnService } from './webauthn'
import { getRuntime } from '../runtime'
import { AuthError, type ChallengeStore, type SignInService, type StepUp } from './types'

export type SignInServices = { deps: SignInDeps; signIn: SignInService; stepUp: StepUp; challenges: ChallengeStore }

let services: SignInServices | undefined

/** Builds the services over the given dependencies (tests and the runtime wiring use this directly). */
export function buildSignInServices(deps: SignInDeps): SignInServices {
  return { deps, signIn: createSignInService(deps), stepUp: createStepUp(deps), challenges: deps.challenges }
}

export function getSignInServices(): SignInServices {
  if (services) return services
  const runtime = getRuntime()
  const store = runtime.store.accounts
  const resolver = createAuthSettingsResolver(store, process.env, { onClamp: auditSettingClamp })
  // Settings are re-read on a short cache; the limiter takes the values it has at start (a change applies on restart).
  let cached: { at: number; value: ReturnType<typeof resolver.resolve> } | undefined
  onSettingsChanged(() => (cached = undefined))
  const settings = {
    resolve() {
      const now = Date.now()
      if (!cached || now - cached.at > 5_000) cached = { at: now, value: resolver.resolve() }
      return cached.value
    },
    describe: resolver.describe,
    write: resolver.write,
  }
  const loaded = loadSecretKey(process.env)
  if (!loaded.ok) throw new Error(`server key unavailable: ${loaded.reason}`)
  const challenges = createChallengeStore()
  // The same list as the setup wizard: a stub that always answers `unavailable` would refuse every new password when the check is on.
  const password = createPasswordService(lazyBreachedList(() => settings.resolve().breachedListPath))
  const users = createUserService(store, (plain) => password.hash(plain, settings.resolve().argon2Login), Date.now, () => settings.resolve(), {
    // Sessions the store drops must close their in-memory connections; a deleted user takes the preferences along (FR-AUT-024).
    onSessionsEnded: (ids) => ids.forEach((id) => void runtime.sessions.endSession(id)),
    onUserDeleted: (id) => getPrefsService(false).deleteOwner(`u:${id}`),
  })
  const deps: SignInDeps = {
    store,
    sessions: runtime.sessions,
    users,
    settings,
    throttle: runtime.throttle,
    password,
    totp: new OwnTotp(),
    codes: createRecoveryCodeService(loaded.ring),
    ring: loaded.ring,
    maintenanceBlocks: (user) => maintenanceBlocks(maintenanceView(settings.resolve(), process.env, Date.now()), user),
    challenges,
    webauthn: createWebAuthnService({
      challenges,
      relyingParty: () => {
        const s = settings.resolve()
        if (!s.publicOrigin || !s.rpId) throw new AuthError('mfa_failed')
        return { rpId: s.rpId, origin: new URL(s.publicOrigin).origin, rpName: store.getSite().siteName ?? 'DBLoom' }
      },
    }),
  }
  services = buildSignInServices(deps)
  return services
}
