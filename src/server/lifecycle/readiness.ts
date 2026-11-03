/**
 * Readiness state (FR-SVR-010): shutdown flag and the readiness decision. The flag lives on `globalThis` because the
 * built server holds several bundles (Nitro plugins, the server-render bundle); a plain module variable would exist
 * once per bundle and the shutdown sequence (task 5) would flip the wrong copy.
 */
const KEY = Symbol.for('dbloom.readiness')
type State = { shuttingDown: boolean }
const state = (): State => {
  const g = globalThis as unknown as Record<symbol, State | undefined>
  return (g[KEY] ??= { shuttingDown: false })
}

/** Called once by the shutdown sequence when `SIGTERM` arrives; readiness answers 503 from then on. */
export function setShuttingDown(): void {
  state().shuttingDown = true
}
export function isShuttingDown(): boolean {
  return state().shuttingDown
}
/** Tests only. */
export function resetReadiness(): void {
  state().shuttingDown = false
}

export type ReadyInput = {
  /** Reads the runtime (config valid, store opened); throws when the configuration or the store is bad. */
  runtime: () => { stateless: boolean; mode?: string; ping: () => void }
}
export type ReadyState = 'ok' | 'shutting-down' | 'config' | 'store'
export type ReadyResult = { ready: boolean; state: ReadyState; stateless?: boolean; mode?: string }

/** Pure decision; never throws. The route turns it into a response. */
export function checkReady(input: ReadyInput): ReadyResult {
  if (isShuttingDown()) return { ready: false, state: 'shutting-down' }
  let rt: ReturnType<ReadyInput['runtime']>
  try {
    rt = input.runtime()
  } catch {
    return { ready: false, state: 'config' }
  }
  const mode = rt.mode ? { mode: rt.mode } : {}
  if (!rt.stateless) {
    try {
      rt.ping()
    } catch {
      return { ready: false, state: 'store', stateless: false, ...mode }
    }
  }
  return { ready: true, state: 'ok', stateless: rt.stateless, ...mode }
}

export const READY_BODY = '{"ready":true}'
export const NOT_READY_BODY = '{"ready":false}'
