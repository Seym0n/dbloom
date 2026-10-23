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
}

const bool = (v: string | undefined) => v === 'true' || v === '1'
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tls = env.DBLOOM_TARGET_TLS ?? 'verify'
  if (tls !== 'verify' && tls !== 'skip-verify' && tls !== 'off') {
    throw new Error('DBLOOM_TARGET_TLS must be verify, skip-verify or off')
  }
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
  }
  // SEC-TGT-018: free-form targets need a named allow-list or an explicit acknowledgement.
  if (config.allowedTargets.length === 0 && !config.freeFormAck) {
    throw new Error(
      'Direct mode needs DBLOOM_DIRECT_TARGETS (host:port list) or DBLOOM_DIRECT_FREE_FORM_ACK=true',
    )
  }
  return config
}
