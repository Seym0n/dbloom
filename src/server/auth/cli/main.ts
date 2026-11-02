/** CLI entry wiring (FR-AUT-030): opens the same store as the server and runs one command. */
import { join } from 'node:path'
import { createRecoveryService } from '../recovery'
import { loadSecretKey } from '../secret-key'
import { createAuthSettingsResolver } from '../settings'
import { createThrottle } from '../throttle'
import { tokens } from '../tokens'
import { createUserService } from '../users'
import { AuthError } from '../types'
import { openSqliteStore } from '../../store/sqlite-store'
import { CLI_USAGE, runCli } from './commands'

/** Runs `argv` (after the program name) against the store in `DBLOOM_DATA_DIR`; returns the exit code. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (s: string) => void = (s) => void process.stdout.write(s),
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    write(CLI_USAGE + '\n')
    return argv.length === 0 ? 2 : 0
  }
  const dataDir = env.DBLOOM_DATA_DIR ?? './data'
  const store = openSqliteStore(join(dataDir, 'dbloom.db'))
  try {
    const resolver = createAuthSettingsResolver(store.accounts, env)
    const key = loadSecretKey(env)
    // The CLI never sets passwords or runs ceremonies; those dependencies of the services refuse.
    const unavailable = async (): Promise<never> => {
      throw new AuthError('auth_failed')
    }
    const users = createUserService(store.accounts, unavailable, Date.now, () => resolver.resolve())
    const recovery = createRecoveryService({
      store: store.accounts,
      tokens,
      users,
      passwords: { check: unavailable, hash: unavailable },
      webauthn: { registrationOptions: unavailable, verifyRegistration: unavailable },
      throttle: createThrottle(),
      settings: () => resolver.resolve(),
    })
    const result = await runCli(argv, {
      accounts: store.accounts,
      dataDir,
      ring: key.ok ? key.ring : undefined,
      recovery,
      users,
      audit: (event, fields) => void process.stderr.write(JSON.stringify({ t: new Date().toISOString(), audit: event, ...fields }) + '\n'),
    })
    write(result.stdout)
    return result.exitCode
  } finally {
    store.close()
  }
}
