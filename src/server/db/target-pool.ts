import { createPool, type Pool, type PoolOptions } from 'mysql2/promise'
import type { Config, TlsMode } from '../config'
import type { TargetKey } from '../target'

/** The only module that opens connections to a target (spec section 9). */
export type TargetPool = Pool

/** Per-connection options of an account-mode profile (FR-AUT-022); direct mode passes none. */
export type TargetPoolExtras = {
  /** Overrides `config.tls`; the caller never passes a weaker mode than `.env` permits. */
  tls?: TlsMode
  compress?: boolean
  /** PEM text, never a path (Q9). */
  ca?: string
  cert?: string
  key?: string
}

function tlsOptions(config: Config, host: string, extras: TargetPoolExtras = {}): PoolOptions['ssl'] {
  const mode = extras.tls ?? config.tls
  if (mode === 'off') return undefined
  // `servername` reaches tls.connect, which the mysql2 type does not list; it makes the certificate
  // check use the typed host name while the socket goes to the pinned address.
  return {
    servername: host,
    rejectUnauthorized: mode === 'verify',
    minVersion: 'TLSv1.2',
    ...(extras.ca ? { ca: extras.ca } : {}),
    ...(extras.cert ? { cert: extras.cert } : {}),
    ...(extras.key ? { key: extras.key } : {}),
  } as PoolOptions['ssl']
}

/** `address` is the validated IP (SEC-TGT-031); the certificate is checked against the typed host name. */
export async function openTargetPool(
  target: TargetKey,
  address: string,
  password: string,
  config: Config,
  extras: TargetPoolExtras = {},
): Promise<TargetPool> {
  const pool = createPool({
    host: address,
    port: target.port,
    user: target.username,
    password,
    ssl: tlsOptions(config, target.host, extras),
    compress: extras.compress === true,
    connectTimeout: config.connectTimeoutMs,
    connectionLimit: 4,
    multipleStatements: false,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    // `execute` (module rows) caches prepared statements per connection; the server allows 16 382 in total.
    maxPreparedStatements: 100,
  })
  try {
    await pool.query('SELECT 1')
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
  return pool
}
