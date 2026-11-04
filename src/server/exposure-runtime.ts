import { auditSinkStatus } from './audit/file-sink'
import { createExposureService, type ExposureService, type StatusBlock } from './exposure-service'
import { createExposureState } from './exposure-state'
import { checkReady } from './lifecycle/readiness'
import { getRuntime } from './runtime'

const KEY = Symbol.for('dbloom.exposure.service')

/**
 * The exposure service of this process, wired to the runtime. Server only (kept out of `exposure.functions.ts` so the
 * client build does not pull the runtime in). Kept on `globalThis` like the readiness flag: the built server holds
 * several bundles, and an acknowledgement must be seen by all of them.
 */
export function exposureService(): ExposureService {
  const g = globalThis as unknown as Record<symbol, ExposureService | undefined>
  const cached = g[KEY]
  if (cached) return cached
  const rt = getRuntime()
  const stateless = rt.statelessPrefs !== undefined
  const mode = (): 'account' | 'direct' | 'setup' | 'stateless' => {
    if (stateless) return 'stateless'
    const s = rt.setup.startupState()
    if (s.kind === 'setup_pending') return 'setup'
    return s.kind === 'ready' ? s.mode : 'stateless'
  }
  const state = createExposureState({
    report: rt.exposure,
    host: rt.config.host,
    startedAt: rt.startedAt,
    probe: { mode, mfaScope: () => rt.settings().mfaScope, sink: () => auditSinkStatus() },
  })
  const status = (): StatusBlock => {
    const ready = checkReady({ runtime: () => ({ stateless, mode: mode(), ping: () => void rt.store.db.prepare('SELECT 1').get() }) })
    const sink = auditSinkStatus()
    const version = (rt.store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    return {
      ready: ready.ready,
      readyState: ready.state,
      loginMode: mode(),
      store: stateless ? 'none' : ready.state === 'store' ? 'unavailable' : 'ok',
      schemaVersion: stateless ? null : version,
      version: process.env.npm_package_version ?? 'unknown',
      auditSink: sink.sink === 'file' ? { sink: sink.sink, state: sink.state, buffered: sink.buffered, drops: sink.drops } : { sink: sink.sink, state: sink.state },
    }
  }
  return (g[KEY] = createExposureService({ state, store: rt.store.accounts, status }))
}
