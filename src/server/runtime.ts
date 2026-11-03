import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DirectAuth } from './auth'
import { log } from './log'
import { createSqlitePrefsBackend, type PrefsBackend } from './auth/prefs/backend'
import { createTargetConnectRules } from './auth/connections'
import { configurePrefsService, getPrefsService } from './auth/prefs/runtime'
import { createAuthSettingsResolver } from './auth/settings'
import { createSetupRuntime } from './auth/setup-runtime'
import { evaluateStart } from './auth/start-gate'
import { createThrottle } from './auth/throttle'
import { AUTH_SETTINGS, type ResolvedAuthSettings, type Throttle } from './auth/types'
import type { SetupApi } from './auth/setup'
import { assertDirectTargets, loadConfigWithWarnings, type Config } from './config'
import type { IoPrefsStore } from './io/store'
import type { PrefsStore } from './rows/prefs'
import { ownerKeyOf } from './sql/state'
import { readyClassifier } from './sql/a-deps'
import { SessionManager } from './sessions'
import { createMemoryPrefsDb, createSqliteIoPrefs, createSqlitePrefs, openSqliteStore, type SqliteStore } from './store/sqlite-store'

export type Runtime = {
  config: Config
  sessions: SessionManager
  auth: DirectAuth
  /** Holds the SQL history and bookmarks (`store.sql`); see `getSqlState` for the mode choice. */
  store: SqliteStore
  /** First-run setup and the start gate (FR-AUT-001 to 003); `setup.startupState()` is live. */
  setup: SetupApi
  /** One backoff throttle for sign-in, vault failures, target connects and setup (FR-AUT-007). */
  throttle: Throttle
  /** Resolved account settings, cached for 5 s. */
  settings: () => ResolvedAuthSettings
  /**
   * Stateless mode (`DBLOOM_STORE=none`): ONE in-memory preference table behind the registry service, rows and io
   * (owner key = session id hash). Undefined in stateful modes.
   */
  statelessPrefs?: { backend: PrefsBackend; rows: PrefsStore; io: IoPrefsStore }
}

let runtime: Runtime | undefined

/** Throttle limits at start; a change in the settings applies on restart. */
export function throttleOptionsOf(s: Pick<ResolvedAuthSettings, 'loginFailures' | 'loginWindowMs' | 'loginBackoffCapMs'>): [number, number, number] {
  return [s.loginFailures, s.loginWindowMs, s.loginBackoffCapMs]
}

/** Lazy singleton: config errors surface on the first request and in the log, not at import time. */
export function getRuntime(): Runtime {
  if (runtime) return runtime
  // Dev and local runs: read .env without overriding variables that are already set.
  try {
    process.loadEnvFile('.env')
  } catch {
    // no .env file (containers pass real variables)
  }
  const { config, warnings: configWarnings } = loadConfigWithWarnings()
  for (const w of configWarnings) log.warn('DBLoom config warning', { warning: w })
  void readyClassifier() // loads the SQL parser once; a failure leaves the classifier on `parser-off`
  mkdirSync(config.dataDir, { recursive: true })
  const store = openSqliteStore(join(config.dataDir, 'dbloom.db'))
  const stateless = process.env.DBLOOM_STORE === 'none'
  // Account-mode limits come from the settings resolver; a short cache keeps it off the per-request path.
  const resolver = createAuthSettingsResolver(store.accounts)
  let cached: { at: number; value: ResolvedAuthSettings } | undefined
  const settings = () => {
    const now = Date.now()
    if (!cached || now - cached.at > 5_000) cached = { at: now, value: resolver.resolve() }
    return cached.value
  }
  const throttle = createThrottle(
    throttleOptionsOf(
      (() => {
        try {
          return settings()
        } catch {
          return { loginFailures: AUTH_SETTINGS.loginFailures.default, loginWindowMs: AUTH_SETTINGS.loginWindowMs.default, loginBackoffCapMs: AUTH_SETTINGS.loginBackoffCapMs.default }
        }
      })(),
    ),
  )
  // Start gate (FR-AUT-001): refuses a mode mismatch or a missing account-mode prerequisite, then prepares setup.
  const setup = createSetupRuntime({ accounts: store.accounts, dataDir: config.dataDir, throttle })
  const gate = evaluateStart({ env: process.env, stateless, site: store.accounts.getSite() })
  if (gate.state.kind === 'stateless' || (gate.state.kind === 'ready' && gate.state.mode === 'direct') || (gate.state.kind === 'setup_pending' && gate.state.preselectedMode === 'direct') || gate.autoSetup) assertDirectTargets(config)
  if (gate.autoSetup) setup.autoSetupDirect(Date.now())
  else if (gate.state.kind === 'setup_pending') setup.prepareToken(Date.now())
  const sessions = new SessionManager(store, config, Date.now, settings)
  setInterval(() => void sessions.sweep(), 60_000).unref()
  // Preferences (FR-AUT-024): the registry service shares the `ui_prefs` table with rows and io. Stateless mode keeps
  // one in-memory table for all three, dropped per session id when the session ends.
  let statelessPrefs: Runtime['statelessPrefs']
  if (stateless) {
    const db = createMemoryPrefsDb()
    const backend = createSqlitePrefsBackend(db)
    statelessPrefs = { backend, rows: createSqlitePrefs(db), io: createSqliteIoPrefs(db) }
    configurePrefsService(backend, { stateless: true })
    sessions.onEnd((idHash) => backend.removeOwner(idHash))
  }
  configurePrefsService(createSqlitePrefsBackend(store.db))
  // Direct login applies the same connect rules as account mode (FR-AUT-020).
  const auth = new DirectAuth(config, sessions, {
    rules: createTargetConnectRules(),
    settings,
    collation: (target) => {
      if (stateless) return null
      try {
        const value = getPrefsService(false).get(ownerKeyOf(target), `${target.host}${target.zone ?? ''}:${target.port}`).collation
        return typeof value === 'string' ? value : null
      } catch {
        return null
      }
    },
  })
  runtime = { config, sessions, auth, store, setup, throttle, settings, ...(statelessPrefs ? { statelessPrefs } : {}) }
  return runtime
}
