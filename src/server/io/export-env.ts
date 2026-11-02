/** Builds the export environment of a live session (the one place that knows the runtime, store and SQL tab). */
import { getRuntime } from '../runtime'
import type { LiveSession } from '../sessions'
import { openResultStream } from '../sql/export-source'
import { envOf as sqlEnvOf } from '../sql/service'
import { isStateless } from '../sql/state'
import type { ExportServiceEnv } from './export-service'
import { ioEnvOf } from './http'
import { ioBoundsFromConfig } from './limits'
import { memoryIoPrefs, memoryIoTemplates } from './store'

export function exportEnvOf(session: LiveSession, httpHost?: string): ExportServiceEnv {
  const runtime = getRuntime()
  const base = ioEnvOf(session, runtime)
  const stateless = isStateless()
  return {
    pool: session.pool,
    temp: base.temp,
    jobs: base.jobs,
    owner: base.owner,
    limits: base.limits,
    mayDisableFormulaNeutralisation: ioBoundsFromConfig(runtime.config).formulaOptOut,
    prefs: stateless ? (runtime.statelessPrefs?.io ?? memoryIoPrefs) : runtime.store.ioPrefs,
    templates: stateless ? memoryIoTemplates : runtime.store.ioTemplates,
    targetLabel: base.targetLabel,
    serverName: session.target.host,
    httpHost,
    openResult: (r) =>
      openResultStream(sqlEnvOf(session), {
        db: r.db,
        text: r.text,
        statementIndex: r.statementIndex,
        raw: true,
        limits: { timeoutMs: r.timeoutMs },
      }),
  }
}
