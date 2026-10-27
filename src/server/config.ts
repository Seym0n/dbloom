import { isAbsolute } from 'node:path'

export type TlsMode = 'verify' | 'skip-verify' | 'off'

export type Config = {
  dataDir: string
  /** Named targets `host:port` (normalised). Empty means free-form, which needs `freeFormAck`. */
  allowedTargets: string[]
  freeFormAck: boolean
  allowLoopback: boolean
  allowPrivate: boolean
  tls: TlsMode
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
}

const bool = (v: string | undefined) => v === 'true' || v === '1'
const intIn = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
}
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    trustProxy: bool(env.DBLOOM_TRUST_PROXY),
    sessionIdleMs: num(env.DBLOOM_SESSION_IDLE_MINUTES, 30) * 60_000,
    sessionAbsoluteMs: num(env.DBLOOM_SESSION_ABSOLUTE_HOURS, 12) * 3_600_000,
    connectTimeoutMs: num(env.DBLOOM_CONNECT_TIMEOUT_SECONDS, 10) * 1000,
    readOnly: bool(env.DBLOOM_READ_ONLY),
    statementTimeoutMs: timeoutMs,
    tempDir: env.DBLOOM_TEMP_DIR?.trim() || undefined,
    tempQuotaMiB: intIn(env, 'DBLOOM_TEMP_QUOTA_MIB', 10_240, 1, 10_000_000),
    importMaxMiB: intIn(env, 'DBLOOM_IMPORT_MAX_MIB', 2048, 1, 2048),
    importDir: env.DBLOOM_IMPORT_DIR?.trim() || undefined,
  }
  if (config.importDir !== undefined && !isAbsolute(config.importDir)) {
    throw new Error('DBLOOM_IMPORT_DIR must be an absolute path')
  }
  // SEC-TGT-018: free-form targets need a named allow-list or an explicit acknowledgement.
  if (config.allowedTargets.length === 0 && !config.freeFormAck) {
    throw new Error(
      'Direct mode needs DBLOOM_DIRECT_TARGETS (host:port list) or DBLOOM_DIRECT_FREE_FORM_ACK=true',
    )
  }
  return config
}
