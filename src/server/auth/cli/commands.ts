/** Host CLI commands (FR-AUT-030): pure over injected dependencies; `main.ts` wires the real store. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AAD,
  CLI_COMMANDS,
  SETUP_TOKEN_FILE,
  type AccountStore,
  type AuthAuditFields,
  type CliResult,
  type RecoveryService,
  type SecretKeyRing,
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
  now?: () => number
}

export const CLI_USAGE = `Usage: dbloom <command>
  setup-token                  print the pending setup token
  recover <username>           print a recovery link
  sessions revoke <username>   end all sessions of a user
  rotate-secret                re-seal TOTP secrets under the current server key`

const done = (exitCode: CliResult['exitCode'], ...lines: string[]): CliResult => ({ exitCode, stdout: lines.join('\n') + '\n' })

/** `argv` is the command line after the program name. Returns the exit code and what to print on stdout. */
export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const now = deps.now ?? Date.now
  const [first, second, third] = argv
  const command = first === 'sessions' ? `sessions ${second ?? ''}`.trim() : first
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
