import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DirectAuth } from './auth'
import { loadConfig, type Config } from './config'
import { readyClassifier } from './sql/a-deps'
import { SessionManager } from './sessions'
import { openSqliteStore, type SqliteStore } from './store/sqlite-store'

export type Runtime = {
  config: Config
  sessions: SessionManager
  auth: DirectAuth
  /** Holds the SQL history and bookmarks (`store.sql`); see `getSqlState` for the mode choice. */
  store: SqliteStore
}

let runtime: Runtime | undefined

/** Lazy singleton: config errors surface on the first request and in the log, not at import time. */
export function getRuntime(): Runtime {
  if (runtime) return runtime
  // Dev and local runs: read .env without overriding variables that are already set.
  try {
    process.loadEnvFile('.env')
  } catch {
    // no .env file (containers pass real variables)
  }
  const config = loadConfig()
  void readyClassifier() // loads the SQL parser once; a failure leaves the classifier on `parser-off`
  mkdirSync(config.dataDir, { recursive: true })
  const store = openSqliteStore(join(config.dataDir, 'dbloom.db'))
  const sessions = new SessionManager(store, config)
  setInterval(() => void sessions.sweep(), 60_000).unref()
  runtime = { config, sessions, auth: new DirectAuth(config, sessions), store }
  return runtime
}
