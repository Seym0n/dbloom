import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { ENV_VARS, ENV_NAMES, type EnvVar } from './env-registry'
import { parseCidrEntry } from './net/cidr'
import { isLoopbackHost, parsePublicOrigin } from './net/origin'

export { ENV_VARS, ENV_NAMES, renderEnvExample, type EnvVar, type VarKind } from './env-registry'

export type TlsMode = 'verify' | 'skip-verify' | 'off'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Config = {
  dataDir: string
  /** Named targets `host:port` (normalised). Empty means free-form, which needs `freeFormAck`. */
  allowedTargets: string[]
  freeFormAck: boolean
  allowLoopback: boolean
  allowPrivate: boolean
  tls: TlsMode
  /**
   * Legacy switch read by the existing `getRequestIP` callers: true for `DBLOOM_TRUST_PROXY=true` or when a CIDR list is
   * set. FR-SVR-005 (task 2) replaces it with `trustedProxies` + the client-address module.
   */
  trustProxy: boolean
  sessionIdleMs: number
  sessionAbsoluteMs: number
  connectTimeoutMs: number
  /** DBLOOM_READ_ONLY: forces every session read-only. */
  readOnly: boolean
  /** DBLOOM_STATEMENT_TIMEOUT_SECONDS (default 30). */
  statementTimeoutMs: number
  /** DBLOOM_TEMP_DIR: staging and spool files of module io; empty means `<dataDir>/tmp` (FR-CFG-079). */
  tempDir?: string
  /** DBLOOM_TEMP_QUOTA_MIB: total bytes of staged and spooled files (default 10240). */
  tempQuotaMiB?: number
  /** DBLOOM_IMPORT_MAX_MIB: ENV bound of the upload size (1 to 2048, default 2048; the effective default is lower). */
  importMaxMiB?: number
  /** DBLOOM_IMPORT_DIR: enables the server import folder (ST-153); absolute path. */
  importDir?: string

  // --- module `server` (SPEC/27) ---
  /** DBLOOM_STORE: `none` is stateless mode (DEP-TGT-125); anything else the SQLite store. */
  store: 'sqlite' | 'none'
  /** DBLOOM_HOST (FR-SVR-002). */
  host: string
  /** PORT. */
  port: number
  /** DBLOOM_PUBLIC_ORIGIN normalised to `scheme://host[:port]`; undefined when unset (FR-SVR-003). */
  publicOrigin?: string
  /** DBLOOM_ALLOWED_HOSTS, lower case `host[:port]`, wildcards possible; default the origin host or the loopback names. */
  allowedHosts: string[]
  /** DBLOOM_TRUST_PROXY as validated CIDR strings (empty when unset or legacy `true`). */
  trustedProxies: string[]
  /** DBLOOM_TRUST_PROXY=true (legacy, accepted for one release with a warning; Q4). */
  trustProxyLegacy: boolean
  /** DBLOOM_PROXY_HOPS: optional hop count of the rightmost-untrusted rule (0 = unused). */
  proxyHops: number
  /** DBLOOM_TLS: only `proxy` today; `own` is reserved and refused (SPEC/27 assumption 2). */
  tlsMode: 'proxy'
  hsts: { enabled: boolean; maxAgeSeconds: number; includeSubDomains: boolean }
  shutdownSeconds: number
  logLevel: LogLevel
  allowDebug: boolean
  probeHosts: string[]
  probeAllow: string[]
  /** FR-SVR-009: body caps only; the rest is left to Node defaults and the reverse proxy. */
  limits: {
    functionBodyKiB: number
    otherBodyKiB: number
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export type LoadResult = { config: Config; warnings: string[] }

const byName = new Map<string, EnvVar>(ENV_VARS.map((e) => [e.name, e]))

const bool = (x: string | undefined) => x === 'true' || x === '1'
const intIn = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
}
const num = (x: string | undefined, fallback: number) => {
  const n = Number(x)
  return x !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
}

/** Unset and empty are the same: the default applies (Compose passes `NAME=` for unset interpolations). */
const raw = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const x = env[name]?.trim()
  return x === undefined || x === '' ? undefined : x
}

/** Strict parse of one registered variable through zod. Messages name the variable, never the value. */
function strict(env: NodeJS.ProcessEnv, name: string): string | number | boolean | undefined {
  const e = byName.get(name)
  if (!e) throw new Error(`${name} is not registered`)
  const text = raw(env, name)
  if (text === undefined) return undefined
  let schema: z.ZodType<string | number | boolean>
  let hint: string
  switch (e.kind) {
    case 'int':
      schema = z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().min(e.min ?? 0).max(e.max ?? Number.MAX_SAFE_INTEGER))
      hint = `a whole number from ${e.min ?? 0} to ${e.max}`
      break
    case 'bool':
      schema = z.enum(['true', 'false', '1', '0']).transform((x) => x === 'true' || x === '1')
      hint = 'true or false'
      break
    case 'enum':
      schema = z.string().transform((x) => x.toLowerCase()).pipe(z.enum(e.values as [string, ...string[]]))
      hint = (e.values ?? []).join(', ')
      break
    default:
      schema = z.string().min(1)
      hint = 'a non-empty string'
  }
  const r = schema.safeParse(text)
  if (!r.success) throw new ConfigError(`${name} must be ${hint}`)
  return r.data
}

const listOf = (env: NodeJS.ProcessEnv, name: string): string[] | undefined => {
  const text = raw(env, name)
  if (text === undefined) return undefined
  return text.split(',').map((s) => s.trim()).filter(Boolean)
}

export { isLoopbackHost }

/** `10.0.0.0/8`, `::1/128`, or a bare address (host route). Returns the normalised text or null. */
export function parseCidr(text: string): string | null {
  const [addr, prefix, extra] = text.trim().split('/')
  if (extra !== undefined || !addr) return null
  const family = isIP(addr)
  if (family === 0) return null
  const max = family === 4 ? 32 : 128
  if (prefix === undefined) return parseCidrEntry(text) ? `${addr.toLowerCase()}/${max}` : null
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return null
  if (!parseCidrEntry(text)) return null
  return `${addr.toLowerCase()}/${Number(prefix)}`
}

const HOST_ENTRY = /^(\*|(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(:\d{1,5})?$/

const PLACEHOLDER = /^<?\s*(change[-_ ]?me|replace[-_ ]?me|your[-_ ].*|todo|x{3,})\s*>?$/i

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]!
}

/** Typo guard (FR-SVR-001): every `DBLOOM_*` name that is not registered. Names only, never values. */
export function unknownVariableWarnings(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  for (const name of Object.keys(env)) {
    if (!name.startsWith('DBLOOM_') || ENV_NAMES.has(name)) continue
    const near = ENV_VARS.map((e) => e.name).find((n) => distance(n, name) <= 2)
    out.push(`Unknown variable ${name} is ignored${near ? ` (did you mean ${near}?)` : ''}`)
  }
  return out
}

/** Loads and validates the whole configuration. Throws on the first violated rule; warnings are returned. */
export function loadConfigWithWarnings(env: NodeJS.ProcessEnv = process.env): LoadResult {
  const warnings = unknownVariableWarnings(env)

  // Placeholders stop startup for any registered variable (DEP-TGT-140). The value is never echoed.
  for (const e of ENV_VARS) {
    const x = env[e.name]?.trim()
    if (x && PLACEHOLDER.test(x)) throw new ConfigError(`${e.name} still holds a placeholder value; set a real value or remove it`)
  }

  const tls = env.DBLOOM_TARGET_TLS ?? 'verify'
  if (tls !== 'verify' && tls !== 'skip-verify' && tls !== 'off') {
    throw new Error('DBLOOM_TARGET_TLS must be verify, skip-verify or off')
  }
  const timeoutRaw = env.DBLOOM_STATEMENT_TIMEOUT_SECONDS
  const timeoutSeconds = timeoutRaw === undefined || timeoutRaw === '' ? 30 : Number(timeoutRaw)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('DBLOOM_STATEMENT_TIMEOUT_SECONDS must be a number greater than zero')
  }
  const timeoutMs = timeoutSeconds * 1000

  // --- listener (FR-SVR-002, 003) ---
  const host = raw(env, 'DBLOOM_HOST') ?? '127.0.0.1'
  if (/\s/.test(host) || host.includes('/')) throw new ConfigError('DBLOOM_HOST must be a host name or address')
  const loopbackBind = isLoopbackHost(host)
  const port = (strict(env, 'PORT') as number | undefined) ?? 3000
  const tlsMode = (strict(env, 'DBLOOM_TLS') as string | undefined) ?? 'proxy'
  if (tlsMode === 'own') {
    throw new ConfigError('DBLOOM_TLS=own is reserved and not supported; terminate TLS at a reverse proxy')
  }

  const originText = raw(env, 'DBLOOM_PUBLIC_ORIGIN')
  const parsedOrigin = originText === undefined ? undefined : parsePublicOrigin(originText)
  if (parsedOrigin && !parsedOrigin.ok && parsedOrigin.reason === 'invalid') {
    throw new ConfigError('DBLOOM_PUBLIC_ORIGIN must be scheme://host[:port] without path, query or credentials')
  }
  if (parsedOrigin && !parsedOrigin.ok) {
    throw new ConfigError('DBLOOM_PUBLIC_ORIGIN must use https unless its host is a loopback address')
  }
  const origin = parsedOrigin?.ok ? parsedOrigin.value : undefined

  // DBLOOM_TRUST_PROXY: CIDR list, or the legacy boolean (Q4).
  const trustText = raw(env, 'DBLOOM_TRUST_PROXY')
  const trustedProxies: string[] = []
  let trustProxyLegacy = false
  if (trustText !== undefined) {
    const lower = trustText.toLowerCase()
    if (lower === 'true' || lower === '1') {
      trustProxyLegacy = true
      warnings.push('DBLOOM_TRUST_PROXY=true is deprecated and trusts any private-range peer; list the proxy networks as CIDR instead')
    } else if (lower !== 'false' && lower !== '0') {
      for (const item of listOf(env, 'DBLOOM_TRUST_PROXY') ?? []) {
        const cidr = parseCidr(item)
        if (!cidr) throw new ConfigError('DBLOOM_TRUST_PROXY must be a comma separated CIDR list such as 10.0.0.0/8')
        trustedProxies.push(cidr)
      }
    }
  }
  const proxyHops = (strict(env, 'DBLOOM_PROXY_HOPS') as number | undefined) ?? 0

  const allowedRaw = listOf(env, 'DBLOOM_ALLOWED_HOSTS')
  // Host matching is exact including the port, so the loopback default lists both forms.
  const loopbackNames = ['localhost', '127.0.0.1', '[::1]']
  const defaultHosts = origin ? [origin.host] : [...loopbackNames, ...loopbackNames.map((h) => `${h}:${port}`)]
  const allowedHosts = (allowedRaw ?? defaultHosts).map((h) => h.toLowerCase())
  for (const h of allowedHosts) {
    if (!HOST_ENTRY.test(h)) throw new ConfigError('DBLOOM_ALLOWED_HOSTS must list host names or addresses, optionally with a port')
    if (h.includes('*') && !loopbackBind) {
      throw new ConfigError('DBLOOM_ALLOWED_HOSTS must not contain wildcards when DBLOOM_HOST is not a loopback address')
    }
  }

  if (!loopbackBind) {
    if (!origin) throw new ConfigError('DBLOOM_PUBLIC_ORIGIN is required when DBLOOM_HOST is not a loopback address')
    if (trustedProxies.length === 0 && !trustProxyLegacy) {
      throw new ConfigError(
        'DBLOOM_TRUST_PROXY must list the trusted proxy networks (CIDR) when DBLOOM_HOST is not a loopback address',
      )
    }
  }

  const hstsOff = (strict(env, 'DBLOOM_HSTS') ?? 'on') === 'off'
  if (hstsOff) warnings.push('DBLOOM_HSTS=off disables Strict-Transport-Security')

  const logLevel = (strict(env, 'DBLOOM_LOG_LEVEL') as LogLevel | undefined) ?? 'info'
  const allowDebug = (strict(env, 'DBLOOM_ALLOW_DEBUG') as boolean | undefined) ?? false
  if (logLevel === 'debug' && env.NODE_ENV === 'production') {
    if (!allowDebug) throw new ConfigError('DBLOOM_LOG_LEVEL=debug in production needs DBLOOM_ALLOW_DEBUG=true')
    warnings.push('Debug logging is enabled in production (DBLOOM_ALLOW_DEBUG=true)')
  }

  const probeAllow: string[] = []
  for (const item of listOf(env, 'DBLOOM_PROBE_ALLOW') ?? ['127.0.0.0/8', '::1/128']) {
    const cidr = parseCidr(item)
    if (!cidr) throw new ConfigError('DBLOOM_PROBE_ALLOW must be a comma separated CIDR list')
    probeAllow.push(cidr)
  }
  const probeHosts = (listOf(env, 'DBLOOM_PROBE_HOSTS') ?? ['localhost', '127.0.0.1']).map((h) => h.toLowerCase())
  for (const h of probeHosts) {
    if (!HOST_ENTRY.test(h) || h.includes('*')) throw new ConfigError('DBLOOM_PROBE_HOSTS must list host names or addresses')
  }

  const store = env.DBLOOM_STORE === 'none' ? 'none' : 'sqlite'
  if (store === 'none' && env.DBLOOM_LOGIN_MODE?.trim() === 'account') {
    throw new ConfigError('DBLOOM_LOGIN_MODE=account needs a store; DBLOOM_STORE=none is always direct mode')
  }

  const n = (name: string, def: number) => (strict(env, name) as number | undefined) ?? def
  const config: Config = {
    dataDir: env.DBLOOM_DATA_DIR ?? './data',
    allowedTargets: (env.DBLOOM_DIRECT_TARGETS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    freeFormAck: bool(env.DBLOOM_DIRECT_FREE_FORM_ACK),
    allowLoopback: bool(env.DBLOOM_ALLOW_LOOPBACK),
    allowPrivate: bool(env.DBLOOM_ALLOW_PRIVATE),
    tls,
    trustProxy: trustProxyLegacy || trustedProxies.length > 0,
    sessionIdleMs: num(env.DBLOOM_SESSION_IDLE_MINUTES, 30) * 60_000,
    sessionAbsoluteMs: num(env.DBLOOM_SESSION_ABSOLUTE_HOURS, 12) * 3_600_000,
    connectTimeoutMs: num(env.DBLOOM_CONNECT_TIMEOUT_SECONDS, 10) * 1000,
    readOnly: bool(env.DBLOOM_READ_ONLY),
    statementTimeoutMs: timeoutMs,
    tempDir: env.DBLOOM_TEMP_DIR?.trim() || undefined,
    tempQuotaMiB: intIn(env, 'DBLOOM_TEMP_QUOTA_MIB', 10_240, 1, 10_000_000),
    importMaxMiB: intIn(env, 'DBLOOM_IMPORT_MAX_MIB', 2048, 1, 2048),
    importDir: env.DBLOOM_IMPORT_DIR?.trim() || undefined,
    store,
    host,
    port,
    publicOrigin: origin?.origin,
    allowedHosts,
    trustedProxies,
    trustProxyLegacy,
    proxyHops,
    tlsMode: 'proxy',
    hsts: {
      enabled: !hstsOff,
      maxAgeSeconds: n('DBLOOM_HSTS_MAX_AGE', 31_536_000),
      includeSubDomains: (strict(env, 'DBLOOM_HSTS_SUBDOMAINS') as boolean | undefined) ?? false,
    },
    shutdownSeconds: n('DBLOOM_SHUTDOWN_SECONDS', 25),
    logLevel,
    allowDebug,
    probeHosts,
    probeAllow,
    limits: {
      functionBodyKiB: n('DBLOOM_BODY_LIMIT_FUNCTIONS_KIB', 1024),
      otherBodyKiB: n('DBLOOM_BODY_LIMIT_OTHER_KIB', 64),
    },
  }
  if (config.importDir !== undefined && !isAbsolute(config.importDir)) {
    throw new Error('DBLOOM_IMPORT_DIR must be an absolute path')
  }
  return { config, warnings }
}

/** Same as `loadConfigWithWarnings` for callers that only need the values (warnings dropped). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return loadConfigWithWarnings(env).config
}

/**
 * SEC-TGT-018: direct mode needs a named allow-list or an explicit free-form acknowledgement. Called by the runtime
 * once the login mode is known; account mode (FR-AUT-001) has per-user profiles and does not use these variables.
 */
export function assertDirectTargets(config: Pick<Config, 'allowedTargets' | 'freeFormAck'>): void {
  if (config.allowedTargets.length === 0 && !config.freeFormAck) {
    throw new Error('Direct mode needs DBLOOM_DIRECT_TARGETS (host:port list) or DBLOOM_DIRECT_FREE_FORM_ACK=true')
  }
}
