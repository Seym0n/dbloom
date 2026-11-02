/** Composition of the account-security and administrator-user services from the runtime and the sign-in services.
 *
 * Kept out of `*.functions.ts` so no server code reaches the client bundle (see `signin-runtime.ts`).
 */
import { getRuntime } from '../runtime'
import { createAccountSecurity, type AccountSecurityService } from './account-security'
import { createAdminUsers, type AdminUsersService } from './admin-users'
import { getSignInServices } from './signin-runtime'

export type SecurityServices = { security: AccountSecurityService; adminUsers: AdminUsersService }

let services: SecurityServices | undefined

export function getSecurityServices(): SecurityServices {
  if (services) return services
  const runtime = getRuntime()
  const { deps, stepUp } = getSignInServices()
  const onSessionsEnded = (ids: string[]) => ids.forEach((id) => void runtime.sessions.endSession(id))
  services = {
    security: createAccountSecurity({
      store: deps.store,
      sessions: deps.sessions,
      users: deps.users,
      settings: deps.settings,
      throttle: deps.throttle,
      password: deps.password,
      totp: deps.totp,
      codes: deps.codes,
      ring: deps.ring,
      challenges: deps.challenges,
      webauthn: deps.webauthn,
      stepUp,
      siteName: () => deps.store.getSite().siteName ?? 'DBLoom',
      onSessionsEnded,
    }),
    adminUsers: createAdminUsers({ store: deps.store, users: deps.users, password: deps.password, settings: deps.settings, stepUp }),
  }
  return services
}
