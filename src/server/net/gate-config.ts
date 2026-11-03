import { loadConfig, type Config } from '../config'

/** Config for the Nitro-level gate and header hook. Loaded once per process; a bad config fails closed (null). */
let cached: { config: Config | null } | undefined

export function gateConfig(): Config | null {
  if (cached) return cached.config
  try {
    process.loadEnvFile('.env')
  } catch {
    // no .env file (containers pass real variables)
  }
  try {
    cached = { config: loadConfig() }
  } catch {
    // The runtime reports the reason (startup route and log); the gate only refuses to serve.
    cached = { config: null }
  }
  return cached.config
}
