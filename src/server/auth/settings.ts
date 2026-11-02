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
  const text = raw.trim()
  if (typeof spec.default === 'number') {
    const n = Number(text)
    return Number.isFinite(n) ? n * envUnitMs(name) : text
  }
  if (typeof spec.default === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(text)) return true
    if (/^(0|false|no|off)$/i.test(text)) return false
    return text
  }
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

export function createAuthSettingsResolver(store: AccountStore, env: NodeJS.ProcessEnv = process.env): AuthSettingsResolver {
  return {
    resolve() {
      const saved = new Map(store.getSettings().map((s) => [s.key, s.value]))
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(SPECS) as AuthSettingKey[]) {
        const spec = SPECS[key]!
        if (key === 'argon2Login' || key === 'argon2Vault') {
          out[key] = spec.schema.parse(resolveArgon2(key, env))
          continue
        }
        const raw = spec.env ? env[spec.env] : undefined
        const envValue = raw !== undefined && raw !== '' && spec.env ? parseEnv(raw, spec, spec.env) : undefined
        let value: unknown = envValue ?? spec.default
        if (spec.source !== 'env' && saved.has(key)) {
          try {
            value = spec.schema.parse(JSON.parse(saved.get(key)!))
          } catch {
            // A stored value that no longer parses is ignored: the `.env` value or the default stays.
          }
        }
        if (key === 'mfaScope') {
          // The `.env` scope is a floor: the UI can raise it, never lower it (ST-054).
          const floor = envValue ?? 'none'
          if (scopeRank(value) < scopeRank(floor)) value = floor
        } else if (key === 'mfaRoles' && Array.isArray(envValue) && Array.isArray(value)) {
          value = [...new Set([...envValue, ...value])]
        } else if (key === 'mfaGraceMs' && typeof envValue === 'number' && typeof value === 'number') {
          // The `.env` grace period is the longest the UI may set (ST-055).
          value = Math.min(value, envValue)
        } else if (key === 'mfaFactors' || key === 'primaryCredentials') {
          value = narrowList(value, envValue ?? spec.default)
        }
        out[key] = spec.schema.parse(clampNumber(spec, value))
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
