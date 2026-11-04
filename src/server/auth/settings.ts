import { audit } from '../audit'
import { SETTING_META, type SettingMeta } from './setting-meta'
import {
  AUTH_ENV,
  AUTH_SETTINGS,
  DAY_MS,
  HOUR_MS,
  MFA_SCOPES,
  MINUTE_MS,
  type AccountStore,
  type Argon2Params,
  type AuthSettingKey,
  type AuthSettingsResolver,
  type ResolvedAuthSettings,
  type SettingDescription,
  type SettingSourceLabel,
  type SettingValue,
  type SettingSpec,
  type SetupSiteSettingKey,
} from './types'

const SPECS: Record<string, SettingSpec<unknown>> = AUTH_SETTINGS
const ARGON2_PARALLELISM_MAX = 16

/** Env names of the Argon2 settings (ST-067, ST-086); the table has no `env` for them because there are three each. */
const ARGON2_ENV: Record<'argon2Login' | 'argon2Vault', { memoryMiB: string; passes: string; parallelism: string }> = {
  argon2Login: { memoryMiB: AUTH_ENV.argon2MemoryMiB, passes: AUTH_ENV.argon2Passes, parallelism: AUTH_ENV.argon2Parallelism },
  argon2Vault: { memoryMiB: AUTH_ENV.vaultArgon2MemoryMiB, passes: AUTH_ENV.vaultArgon2Passes, parallelism: AUTH_ENV.vaultArgon2Parallelism },
}

/** Unit of a duration variable, from its name (`..._MINUTES`, `..._HOURS`, `..._DAYS`); the settings are milliseconds. */
function envUnitMs(name: string): number {
  if (name.endsWith('_MINUTES')) return MINUTE_MS
  if (name.endsWith('_HOURS')) return HOUR_MS
  if (name.endsWith('_DAYS')) return DAY_MS
  return 1
}

function parseEnv(raw: string, spec: SettingSpec<unknown>, name: string): unknown {
  const unit = spec.envUnit ?? envUnitMs(name)
  const text = raw.trim()
  if (typeof spec.default === 'number') {
    const n = Number(text)
    return Number.isFinite(n) ? n * unit : text
  }
  if (typeof spec.default === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(text)) return true
    if (/^(0|false|no|off)$/i.test(text)) return false
    return text
  }
  // Strings (choices, site text) are taken as written; a value like `123` or `"x"` is not JSON here.
  if (typeof spec.default === 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return Array.isArray(spec.default) ? text.split(',').map((s) => s.trim()).filter(Boolean) : text
  }
}

function clampNumber(spec: SettingSpec<unknown>, value: unknown): unknown {
  if (typeof value !== 'number') return value
  let n = value
  if (typeof spec.floor === 'number') n = Math.max(spec.floor, n)
  if (typeof spec.ceiling === 'number') n = Math.min(spec.ceiling, n)
  return n
}

/** Positive integer from an env variable, else undefined (an unusable value falls back to the default, never below the floor). */
function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Argon2id parameters: default, overlaid by the env names, each field raised to the code minimum (ST-067, ST-086). */
function resolveArgon2(key: 'argon2Login' | 'argon2Vault', env: NodeJS.ProcessEnv): Argon2Params {
  const spec = SPECS[key]!
  const names = ARGON2_ENV[key]
  const base = spec.default as Argon2Params
  const floor = spec.floor as Argon2Params
  const memoryMiB = envInt(env, names.memoryMiB)
  const passes = envInt(env, names.passes)
  const parallelism = envInt(env, names.parallelism)
  return {
    memoryKiB: Math.max(floor.memoryKiB, memoryMiB === undefined ? base.memoryKiB : memoryMiB * 1024),
    passes: Math.max(floor.passes, passes ?? base.passes),
    parallelism: Math.min(ARGON2_PARALLELISM_MAX, Math.max(floor.parallelism, parallelism ?? base.parallelism)),
  }
}

const scopeRank = (scope: unknown) => MFA_SCOPES.indexOf(scope as (typeof MFA_SCOPES)[number])

/** Settings the UI may only narrow within the `.env` list (ST-056, ST-057): intersection, never empty. */
function narrowList(saved: unknown, allowed: unknown): unknown {
  if (!Array.isArray(saved) || !Array.isArray(allowed)) return allowed
  const kept = saved.filter((v) => allowed.includes(v))
  return kept.length ? kept : allowed
}

/** Keys named by `DBLOOM_SETTINGS_LOCK` (SPEC/32 FR-ASE-006): the stored value is ignored, the `.env` value or default stays. */
export function lockedKeys(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env[AUTH_ENV.settingsLock] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

type Computed = {
  effective: unknown
  envValue: unknown
  /** The stored value when it parses; undefined when none or ignored. */
  stored: unknown
  hasStored: boolean
  storedIgnored: boolean
  locked: boolean
  forced: boolean
  limits: SettingDescription['limits']
}

/** One key through the precedence of SEC-TGT-150; shared by `resolve()` and `describe()`. */
function compute(key: AuthSettingKey, row: string | undefined, env: NodeJS.ProcessEnv, lock: Set<string>): Computed {
  const spec = SPECS[key]!
  const locked = lock.has(key)
  if (key === 'argon2Login' || key === 'argon2Vault') {
    const floor = spec.floor
    return { effective: spec.schema.parse(resolveArgon2(key, env)), envValue: undefined, stored: undefined, hasStored: false, storedIgnored: false, locked, forced: false, limits: { floor: floor as SettingValue } }
  }
  const raw = spec.env ? env[spec.env] : undefined
  const envValue = raw !== undefined && raw !== '' && spec.env ? parseEnv(raw, spec, spec.env) : undefined
  let value: unknown = envValue ?? spec.default
  let stored: unknown
  let hasStored = false
  let storedIgnored = false
  if (spec.source !== 'env' && row !== undefined) {
    try {
      stored = spec.schema.parse(JSON.parse(row))
      hasStored = true
    } catch {
      // A stored value that no longer parses is ignored: the `.env` value or the default stays.
      storedIgnored = true
    }
  }
  if (hasStored && !locked) value = stored
  const limits: SettingDescription['limits'] = {}
  if (typeof spec.floor === 'number') limits.floor = spec.floor
  if (typeof spec.ceiling === 'number') limits.ceiling = spec.ceiling
  let forced = false
  if (key === 'mfaScope') {
    // The `.env` scope is a floor: the UI can raise it, never lower it (ST-054).
    const floor = envValue ?? 'none'
    if (scopeRank(value) < scopeRank(floor)) value = floor
    limits.floor = floor as SettingValue
    limits.ceiling = 'all'
  } else if (key === 'mfaRoles' && Array.isArray(envValue) && Array.isArray(value)) {
    value = [...new Set([...envValue, ...value])]
    limits.floor = envValue
  } else if (key === 'mfaGraceMs' && typeof envValue === 'number') {
    // The `.env` grace period is the longest the UI may set (ST-055).
    if (typeof value === 'number') value = Math.min(value, envValue)
    limits.ceiling = Math.min(envValue, typeof spec.ceiling === 'number' ? spec.ceiling : envValue)
  } else if (key === 'mfaFactors' || key === 'primaryCredentials') {
    const envelope = envValue ?? spec.default
    value = narrowList(value, envelope)
    if (Array.isArray(envelope)) limits.envelope = envelope
  } else if (key === 'maintenanceOn' && envValue === true) {
    // `DBLOOM_MAINTENANCE` forces maintenance mode on; the UI cannot switch it off.
    value = true
    forced = true
  }
  return { effective: spec.schema.parse(clampNumber(spec, value)), envValue, stored, hasStored, storedIgnored, locked, forced, limits }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Effective value and limits of one key for a given stored row text (`undefined` = none), under the lock list of `env`. */
export function computeSetting(key: AuthSettingKey, row: string | undefined, env: NodeJS.ProcessEnv = process.env): { effective: unknown; limits: SettingDescription['limits'] } {
  const c = compute(key, row, env, lockedKeys(env))
  return { effective: c.effective, limits: c.limits }
}

const reportedClamps = new Set<string>()
/** Clamp report of `resolve()` (SPEC/32 FR-ASE-007): one `settings.clamped` audit line per distinct (key, stored, effective) per process. */
export function auditSettingClamp(e: { key: string; stored: unknown; effective: unknown }): void {
  const id = `${e.key}|${JSON.stringify(e.stored)}|${JSON.stringify(e.effective)}`
  if (reportedClamps.has(id)) return
  reportedClamps.add(id)
  audit('settings.clamped', { setting: e.key, stored: JSON.stringify(e.stored), effective: JSON.stringify(e.effective), actorKind: 'system' })
}
/** Test hook. */
export function resetClampReports(): void {
  reportedClamps.clear()
}

export type ResolverOptions = {
  /** Called when a stored value is not the effective value (a limit clamped or narrowed it). The server passes `auditSettingClamp`; the CLI passes nothing. */
  onClamp?: (e: { key: AuthSettingKey; stored: unknown; effective: unknown }) => void
}

export function createAuthSettingsResolver(store: AccountStore, env: NodeJS.ProcessEnv = process.env, options: ResolverOptions = {}): AuthSettingsResolver {
  return {
    describe() {
      const rows = new Map(store.getSettings().map((s) => [s.key, s]))
      const lock = lockedKeys(env)
      const out: SettingDescription[] = []
      for (const key of Object.keys(SPECS) as AuthSettingKey[]) {
        const spec = SPECS[key]!
        if (spec.source === 'ui') continue // a per-user preference, not a site setting
        const row = rows.get(key)
        const c = compute(key, row?.value, env, lock)
        const meta: SettingMeta = SETTING_META[key]
        const defined =
          key === 'argon2Login' || key === 'argon2Vault' ? Object.values(ARGON2_ENV[key]).some((name) => (env[name] ?? '').trim() !== '') : c.envValue !== undefined
        let source: SettingSourceLabel
        if (c.locked || spec.source === 'env' || spec.source === 'wizard' || !c.hasStored) source = defined ? 'env_default' : 'built_in'
        else source = same(c.stored, c.effective) ? 'ui_override' : 'limit'
        out.push({
          key,
          st: spec.st,
          group: meta.group,
          kind: meta.kind,
          unit: meta.unit,
          factor: meta.factor,
          ...(meta.choices ? { choices: meta.choices } : {}),
          stored: c.hasStored ? (c.stored as SettingValue) : null,
          storedIgnored: c.storedIgnored,
          effective: c.effective as SettingValue,
          source,
          limits: c.limits,
          locked: c.locked,
          forced: c.forced,
          editable: spec.source === 'ui_within_env' && !c.locked && !c.forced,
          updatedAt: row?.updatedAt ?? null,
          updatedBy: row?.updatedBy ?? null,
        })
      }
      return out
    },
    resolve() {
      const rows = new Map(store.getSettings().map((s) => [s.key, s.value]))
      const lock = lockedKeys(env)
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(SPECS) as AuthSettingKey[]) {
        const c = compute(key, rows.get(key), env, lock)
        out[key] = c.effective
        if (options.onClamp && c.hasStored && !c.locked && !same(c.stored, c.effective)) options.onClamp({ key, stored: c.stored, effective: c.effective })
      }
      const publicOrigin = env[AUTH_ENV.publicOrigin] ?? null
      out.publicOrigin = publicOrigin
      out.rpId = publicOrigin ? new URL(publicOrigin).hostname : null
      out.setupNetworks = (env[AUTH_ENV.setupNetworks] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      out.breachedListPath = env[AUTH_ENV.breachedList] ?? null
      return out as ResolvedAuthSettings
    },
    write(values: Partial<Pick<ResolvedAuthSettings, SetupSiteSettingKey>>, by: string) {
      const at = Date.now()
      for (const [key, value] of Object.entries(values)) {
        const spec = SPECS[key]
        if (!spec) continue
        const parsed = spec.schema.parse(clampNumber(spec, value))
        store.setSetting({ key: key as AuthSettingKey, value: JSON.stringify(parsed), updatedAt: at, updatedBy: by })
      }
    },
  }
}
