/**
 * Maintenance mode (SPEC/32 FR-ASE-011, ST-218). Pure rules plus the guard the server functions share.
 *
 * Active means: `DBLOOM_MAINTENANCE` forces it, or the stored switch is on with no end time, or it is on and the end time
 * is still in the future. It ends by itself at the end time: the state is computed on every read from the resolved
 * settings and the clock, so there is no timer to lose on a restart. Administrators are exempt (and told); a user is
 * refused with `maintenance`. Account mode only: direct and stateless installs have no administrators, so there nobody could
 * be exempt and the switch is not offered.
 */
import { AuthError, type AuthUser, type MaintenanceView, type ResolvedAuthSettings } from './auth/types'

export type MaintenanceSettings = Pick<ResolvedAuthSettings, 'maintenanceOn' | 'maintenanceEndsAt'>

/** `.env` forces maintenance on (the same words the registry accepts for a boolean). */
export const maintenanceForced = (env: NodeJS.ProcessEnv): boolean => {
  const raw = env.DBLOOM_MAINTENANCE?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export function maintenanceView(settings: MaintenanceSettings, env: NodeJS.ProcessEnv, now: number): MaintenanceView {
  if (maintenanceForced(env)) return { active: true, endsAt: null }
  if (!settings.maintenanceOn) return { active: false, endsAt: null }
  if (settings.maintenanceEndsAt > 0) return now < settings.maintenanceEndsAt ? { active: true, endsAt: settings.maintenanceEndsAt } : { active: false, endsAt: null }
  return { active: true, endsAt: null }
}

/** Whether `user` is refused now. A missing user is refused too: only a signed-in administrator is exempt. */
export const maintenanceBlocks = (view: MaintenanceView, user: Pick<AuthUser, 'role'> | null | undefined): boolean => view.active && user?.role !== 'admin'

export type MaintenanceRuntime = { settings?: () => MaintenanceSettings }

/**
 * Throws `AuthError('maintenance')` for a user while maintenance is active. `mode` is checked by the caller; a runtime
 * without `settings` (a test fake, a stateless install) never blocks.
 */
export function assertNotInMaintenance(runtime: MaintenanceRuntime, user: Pick<AuthUser, 'role'> | null | undefined, now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): void {
  if (!runtime.settings) return
  if (maintenanceBlocks(maintenanceView(runtime.settings(), env, now), user)) throw new AuthError('maintenance')
}
