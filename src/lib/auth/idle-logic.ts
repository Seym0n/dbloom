import { IDLE_WARNING_MS } from '~/server/auth/types'

/** Time until the idle warning opens (0 when it is open or the limit has passed). Pure, for tests. */
export function msUntilIdleWarning(idleExpiresAt: number, now: number, warningMs = IDLE_WARNING_MS): number {
  return Math.max(0, idleExpiresAt - warningMs - now)
}

/** `active` before the warning window, `warning` inside it, `expired` at or after the limit (SEC-UIX-109). */
export function idlePhase(idleExpiresAt: number, now: number, warningMs = IDLE_WARNING_MS): 'active' | 'warning' | 'expired' {
  if (now >= idleExpiresAt) return 'expired'
  return idleExpiresAt - now <= warningMs ? 'warning' : 'active'
}

/** Remaining time as m:ss for the warning text. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
