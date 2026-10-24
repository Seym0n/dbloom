import { createPool, type Pool, type PoolOptions } from 'mysql2/promise'
import type { Config } from '../config'
import type { TargetKey } from '../target'

/** The only module that opens connections to a target (spec section 9). */
export type TargetPool = Pool

function tlsOptions(config: Config, host: string): PoolOptions['ssl'] {
  if (config.tls === 'off') return undefined
  // `servername` reaches tls.connect, which the mysql2 type does not list; it makes the certificate
  // check use the typed host name while the socket goes to the pinned address.
  return {
    servername: host,
    rejectUnauthorized: config.tls === 'verify',
    minVersion: 'TLSv1.2',
  } as PoolOptions['ssl']
}

/** `address` is the validated IP (SEC-TGT-031); the certificate is checked against the typed host name. */
export async function openTargetPool(
  target: TargetKey,
  address: string,
  password: string,
  config: Config,
): Promise<TargetPool> {
  const pool = createPool({
    host: address,
    port: target.port,
    user: target.username,
    password,
    ssl: tlsOptions(config, target.host),
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
