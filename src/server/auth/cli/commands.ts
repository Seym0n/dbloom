/** Host CLI commands (FR-AUT-030): pure over injected dependencies; `main.ts` wires the real store. */
import { readFileSync } from 'node:fs'
import { AUDIT_CLI_USAGE } from '../../audit/cli-export'
import { join } from 'node:path'
import { SettingsError } from '../settings-write'
import {
  AAD,
  CLI_COMMANDS,
  SETUP_TOKEN_FILE,
  type AccountStore,
  type AuthAuditFields,
  type CliResult,
  type RecoveryService,
  type SecretKeyRing,
  type SettingDescription,
  type UserService,
} from '../types'

export type CliDeps = {
  accounts: AccountStore
  dataDir: string
  ring?: SecretKeyRing
  recovery: Pick<RecoveryService, 'issue'>
  users: Pick<UserService, 'usernameKey' | 'revokeSessions'>
  /** One audit line with `actor: "cli"`; the real one writes JSON to stderr so stdout holds only the answer. */
  audit: (event: 'cli.command', fields: AuthAuditFields & Record<string, string | number | boolean | undefined>) => void
  /** Settings of the host: the description of every key and a reset that skips role and step-up but keeps every limit and lock. */
  settings?: {
    describe: () => SettingDescription[]
    reset: (key: string, basedOn: number | null) => { changed: boolean }
  }
  now?: () => number
}

export const CLI_USAGE = `Usage: dbloom <command>
  setup-token                  print the pending setup token
  recover <username>           print a recovery link
  sessions revoke <username>   end all sessions of a user
  rotate-secret                re-seal TOTP secrets under the current server key
  exposure                     print the effective exposure and its warnings
  settings list                print every setting: effective value, source, lock
  settings reset <key>         remove the stored value of a setting (back to .env or built-in)
  maintenance off              switch maintenance mode off (not when DBLOOM_MAINTENANCE forces it)
${AUDIT_CLI_USAGE}`

const done = (exitCode: CliResult['exitCode'], ...lines: string[]): CliResult => ({ exitCode, stdout: lines.join('\n') + '\n' })

/** `argv` is the command line after the program name. Returns the exit code and what to print on stdout. */
export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const now = deps.now ?? Date.now
  const [first, second, third] = argv
  const command = first === 'sessions' || first === 'settings' || first === 'maintenance' ? `${first} ${second ?? ''}`.trim() : first
  const known = (CLI_COMMANDS as readonly string[]).includes(command ?? '')
  if (!known) return done(2, CLI_USAGE)

  const record = (outcome: 'ok' | 'failed', subject?: string) =>
    deps.audit('cli.command', { actor: 'cli', actorKind: 'cli', reason: command, outcome, subject })
  const userOf = (name: string | undefined) => (name ? deps.accounts.getUserByKey(deps.users.usernameKey(name)) : undefined)

  switch (command) {
    case 'setup-token': {
      if (deps.accounts.getSite().setupCompletedAt !== undefined) {
        record('failed')
        return done(1, 'Setup is complete; there is no setup token.')
      }
      let text: string
      try {
        text = readFileSync(join(deps.dataDir, SETUP_TOKEN_FILE), 'utf8')
      } catch {
        record('failed')
        return done(1, 'No pending setup token. Start DBLoom (it writes one per start) or set DBLOOM_SETUP_TOKEN.')
      }
      const [token, expiry] = text.split('\n')
      const expiresAt = Number(expiry?.replace('expires=', ''))
      if (!token || (Number.isFinite(expiresAt) && now() > expiresAt)) {
        record('failed')
        return done(1, 'The setup token has expired. Restart DBLoom to get a new one.')
      }
      record('ok')
      return done(0, token)
    }
    case 'recover': {
      if (!second || third !== undefined) return done(2, CLI_USAGE)
      const user = userOf(second)
      if (!user) {
        record('failed')
        return done(1, `No user named "${second}".`)
      }
      try {
        const { link, expiresAt } = deps.recovery.issue('cli', user.id)
        record('ok', user.id)
        return done(0, link, `Valid until ${new Date(expiresAt).toISOString()}.`)
      } catch (error) {
        record('failed', user.id)
        return done(1, `Could not issue a recovery link${error instanceof Error ? `: ${error.message}` : '.'}`)
      }
    }
    case 'sessions revoke': {
      if (!third || argv.length > 3) return done(2, CLI_USAGE)
      const user = userOf(third)
      if (!user) {
        record('failed')
        return done(1, `No user named "${third}".`)
      }
      const count = deps.users.revokeSessions(user.id, 'cli')
      record('ok', user.id)
      return done(0, `Ended ${count} session${count === 1 ? '' : 's'} of ${user.username}.`)
    }
    case 'settings list': {
      if (!deps.settings || argv.length !== 2) return done(2, CLI_USAGE)
      const show = (v: unknown) => {
        const s = JSON.stringify(v)
        return s.length > 60 ? `${s.slice(0, 57)}...` : s
      }
      const lines = deps.settings.describe().map((d) => {
        const stored = d.stored !== null && JSON.stringify(d.stored) !== JSON.stringify(d.effective) ? [`stored ${show(d.stored)}`] : []
        const notes = [d.source.replace('_', ' '), ...(d.locked ? ['locked'] : []), ...(d.forced ? ['forced'] : []), ...stored]
        return `${d.key.padEnd(26)} ${show(d.effective).padEnd(24)} (${notes.join(', ')})`
      })
      record('ok')
      return done(0, ...lines)
    }
    case 'settings reset':
    case 'maintenance off': {
      const maintenance = command === 'maintenance off'
      const key = maintenance ? 'maintenanceOn' : third
      if (!deps.settings || !key || argv.length !== (maintenance ? 2 : 3)) return done(2, CLI_USAGE)
      const d = deps.settings.describe().find((x) => x.key === key)
      if (!d) {
        record('failed', key)
        return done(1, `No setting named "${key}".`)
      }
      if (maintenance && d.forced) {
        record('failed', key)
        return done(1, 'Maintenance mode is forced on by DBLOOM_MAINTENANCE. Unset it and restart DBLoom.')
      }
      try {
        const r = deps.settings.reset(key, d.updatedAt)
        record('ok', key)
        if (maintenance) return done(0, r.changed ? 'Maintenance mode is off (the stored switch was removed; a running server picks it up within seconds).' : 'Maintenance mode was not switched on from the settings page.')
        return done(0, r.changed ? `Setting ${key} was reset.` : `Setting ${key} had no stored value.`)
      } catch (error) {
        record('failed', key)
        if (error instanceof SettingsError) return done(1, `Setting ${key} cannot be reset: ${error.code}${error.detail ? ` (${error.detail})` : ''}.`)
        throw error
      }
    }
    default: {
      // rotate-secret
      if (!deps.ring) {
        record('failed')
        return done(1, 'No server key: set DBLOOM_SECRET_KEY (new) and DBLOOM_SECRET_KEY_PREVIOUS (old) first.')
      }
      let resealed = 0
      let current = 0
      let unreadable = 0
      let codeUsers = 0
      for (const u of deps.accounts.listUsers()) {
        const rec = deps.accounts.getTotp(u.id)
        if (rec) {
          if (!deps.ring.isStale(rec.sealed)) {
            // Not stale: it must still open under the current key (a record of an unknown key is unreadable).
            const plain = deps.ring.open('totp', AAD.totp(u.id), rec.sealed)
            if (plain) {
              plain.fill(0)
              current += 1
            } else unreadable += 1
          } else {
            const secret = deps.ring.open('totp', AAD.totp(u.id), rec.sealed)
            if (!secret) unreadable += 1
            else {
              deps.accounts.setTotp({ ...rec, sealed: deps.ring.seal('totp', AAD.totp(u.id), secret) })
              secret.fill(0)
              resealed += 1
            }
          }
        }
        if (deps.accounts.countRecoveryCodes(u.id) > 0) codeUsers += 1
      }
      record(unreadable ? 'failed' : 'ok')
      return done(
        unreadable ? 1 : 0,
        `TOTP secrets re-sealed: ${resealed}; already under the current key: ${current}; unreadable: ${unreadable}.`,
        ...(codeUsers
          ? [`Recovery codes of ${codeUsers} user${codeUsers === 1 ? '' : 's'} are bound to the key that made them; if the key changed they must be regenerated.`]
          : []),
        ...(unreadable ? ['Unreadable secrets need DBLOOM_SECRET_KEY_PREVIOUS set to the old key.'] : ['You may now remove DBLOOM_SECRET_KEY_PREVIOUS.']),
      )
    }
  }
}
