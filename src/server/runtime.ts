import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DirectAuth } from './auth'
import { loadConfig, type Config } from './config'
import { SessionManager } from './sessions'
import { openSqliteStore } from './store/sqlite-store'

type Runtime = { config: Config; sessions: SessionManager; auth: DirectAuth }

let runtime: Runtime | undefined

/** Lazy singleton: config errors surface on the first request and in the log, not at import time. */
export function getRuntime(): Runtime {
  if (runtime) return runtime
  const config = loadConfig()
  mkdirSync(config.dataDir, { recursive: true })
  const store = openSqliteStore(join(config.dataDir, 'dbloom.db'))
  const sessions = new SessionManager(store, config)
  setInterval(() => void sessions.sweep(), 60_000).unref()
  runtime = { config, sessions, auth: new DirectAuth(config, sessions) }
  return runtime
}
