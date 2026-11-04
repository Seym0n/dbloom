/** CLI entry wiring (FR-AUT-030): opens the same store as the server and runs one command. */
import { join } from 'node:path'
import { createRecoveryService } from '../recovery'
import { loadSecretKey } from '../secret-key'
import { createAuthSettingsResolver } from '../settings'
import { createSettingsWriter } from '../settings-write'
import { createThrottle } from '../throttle'
import { tokens } from '../tokens'
import { createUserService } from '../users'
import { AuthError, type AuthSettingKey } from '../types'
import { openSqliteStore } from '../../store/sqlite-store'
import { audit, registerAuditStore, unregisterAuditStore } from '../../audit'
import { auditExportCommand } from '../../audit/cli-export'
import { exposureCommand } from '../../exposure'
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
  if (argv[0] === 'exposure') {
    const r = exposureCommand(env)
    write(r.stdout)
    return r.exitCode
  }
  const dataDir = env.DBLOOM_DATA_DIR ?? './data'
  const store = openSqliteStore(join(dataDir, 'dbloom.db'))
  registerAuditStore(store.db)
  try {
    const resolver = createAuthSettingsResolver(store.accounts, env)
    if (argv[0] === 'audit') {
      const code = auditExportCommand(argv.slice(1), store.db, write, resolver.resolve().auditRetentionDays)
      if (code === 2) write(`${CLI_USAGE}\n`)
      return code
    }
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
      audit: (event, fields) => audit(event, fields),
      settings: {
        describe: () => resolver.describe(),
        pending: () => store.accounts.getPendingSettings('pending'),
        // Best-effort audit on purpose: the owner must be able to undo a setting even when the audit log is unavailable.
        // The CLI reset is the recovery path: no auto-revert of its own, and it closes a pending change of the key
        // (a running server notices at its next sweep that nothing is pending any more).
        reset: (key, basedOn) => {
          const r = createSettingsWriter({ store: store.accounts, env, guard: false, audit: (event, fields) => audit(event, fields) }).reset(key, basedOn, 'cli')
          store.accounts.resolvePending(key as AuthSettingKey, 'superseded')
          return r
        },
      },
    })
    write(result.stdout)
    return result.exitCode
  } finally {
    unregisterAuditStore()
    store.close()
  }
}
