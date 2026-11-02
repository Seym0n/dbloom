/** Package C task 5: host CLI (FR-AUT-030). Runs against a temporary store while a second handle stays open (server running). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli, type CliDeps } from '~/server/auth/cli/commands'
import { main } from '~/server/auth/cli/main'
import { ServerKeyRing, decodeKeyText } from '~/server/auth/secret-key'
import { createUserService } from '~/server/auth/users'
import { AAD, SETUP_TOKEN_FILE, type User } from '~/server/auth/types'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'

let dir: string
let server: SqliteStore
let events: Record<string, unknown>[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-cli-'))
  server = openSqliteStore(join(dir, 'dbloom.db')) // "the running server"
  events = []
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const users = () => createUserService(server.accounts, async (p) => `$phc$${p}`)
const mkUser = (name: string) => users().create({ username: name, displayName: name, role: 'user', password: 'x' }, 'setup')
const deps = (over: Partial<CliDeps> = {}): CliDeps => ({
  accounts: server.accounts,
  dataDir: dir,
  recovery: { issue: (_a, id) => ({ link: `https://x/recover#TOKEN-${id}`, expiresAt: 5_000 }) },
  users: users(),
  audit: (_e, f) => void events.push(f),
  ...over,
})

describe('usage', () => {
  it('unknown or incomplete commands give exit 2 and the usage text', async () => {
    for (const argv of [[], ['nope'], ['sessions'], ['sessions', 'list'], ['recover'], ['sessions', 'revoke']]) {
      const r = await runCli(argv, deps())
      expect(r.exitCode).toBe(2)
      expect(r.stdout).toContain('Usage')
    }
  })
})

describe('setup-token', () => {
  it('prints the pending token and audits with actor cli', async () => {
    writeFileSync(join(dir, SETUP_TOKEN_FILE), 'ABCD-EFGH\nexpires=9000\n')
    const r = await runCli(['setup-token'], deps({ now: () => 1000 }))
    expect(r).toEqual({ exitCode: 0, stdout: 'ABCD-EFGH\n' })
    expect(events).toEqual([expect.objectContaining({ actor: 'cli', actorKind: 'cli', reason: 'setup-token', outcome: 'ok' })])
    expect(JSON.stringify(events)).not.toContain('ABCD')
  })
  it('fails when expired, absent or when setup is complete', async () => {
    writeFileSync(join(dir, SETUP_TOKEN_FILE), 'ABCD-EFGH\nexpires=9000\n')
    expect((await runCli(['setup-token'], deps({ now: () => 9001 }))).exitCode).toBe(1)
    rmSync(join(dir, SETUP_TOKEN_FILE))
    expect((await runCli(['setup-token'], deps())).exitCode).toBe(1)
    server.accounts.setSite({ loginMode: 'direct', setupCompletedAt: 1, siteName: 'x' })
    expect((await runCli(['setup-token'], deps())).stdout).toContain('complete')
  })
})

describe('recover and sessions revoke', () => {
  it('prints a recovery link for a user, found case-insensitively', async () => {
    const u = await mkUser('Ana')
    const r = await runCli(['recover', 'ana'], deps())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`#TOKEN-${u.id}`)
    expect(events[0]).toMatchObject({ actor: 'cli', reason: 'recover', subject: u.id })
    expect(JSON.stringify(events)).not.toContain('TOKEN-')
    expect((await runCli(['recover', 'ghost'], deps())).exitCode).toBe(1)
  })

  it('ends the sessions of a user', async () => {
    const u: User = await mkUser('bo')
    for (const h of ['h1', 'h2']) {
      server.createSession({ idHash: h, targetKey: '', userName: '', createdAt: 1, lastSeenAt: 1, expiresAt: 99 })
      server.accounts.createAccountSession({ idHash: h, targetKey: '', userName: '', createdAt: 1, lastSeenAt: 1, expiresAt: 99, kind: 'account', userId: u.id, state: 'full', mfaAt: null, stepupAt: null, securityVersion: 0, clientHint: '', address: '' })
    }
    const r = await runCli(['sessions', 'revoke', 'bo'], deps())
    expect(r.stdout).toContain('Ended 2 sessions')
    expect(server.accounts.listUserSessions(u.id)).toEqual([])
  })
})

describe('rotate-secret', () => {
  const oldKey = decodeKeyText('11'.repeat(32))
  const newKey = decodeKeyText('22'.repeat(32))
  it('re-seals TOTP secrets sealed under the previous key and reports unreadable ones', async () => {
    const u = await mkUser('cy')
    const oldRing = new ServerKeyRing(oldKey, undefined)
    const secret = Buffer.alloc(20, 7)
    server.accounts.setTotp({ userId: u.id, sealed: oldRing.seal('totp', AAD.totp(u.id), secret), lastStep: 4, createdAt: 1 })
    const ring = new ServerKeyRing(newKey, oldKey)
    const r = await runCli(['rotate-secret'], deps({ ring }))
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('re-sealed: 1')
    const after = server.accounts.getTotp(u.id)!
    expect(ring.isStale(after.sealed)).toBe(false)
    expect(new ServerKeyRing(newKey, undefined).open('totp', AAD.totp(u.id), after.sealed)).toEqual(secret)
    expect(after.lastStep).toBe(4)
    // Second run: nothing to do. Without the previous key the old record is unreadable (exit 1).
    expect((await runCli(['rotate-secret'], deps({ ring }))).stdout).toContain('re-sealed: 0')
    server.accounts.setTotp({ userId: u.id, sealed: oldRing.seal('totp', AAD.totp(u.id), secret), lastStep: 4, createdAt: 1 })
    expect((await runCli(['rotate-secret'], deps({ ring: new ServerKeyRing(newKey, undefined) }))).exitCode).toBe(1)
    expect(JSON.stringify(events)).not.toContain(secret.toString('hex'))
  })
  it('needs a server key', async () => {
    expect((await runCli(['rotate-secret'], deps())).exitCode).toBe(1)
  })
})

describe('main (real wiring, second connection beside the open "server" store)', () => {
  it('runs setup-token and recover through the real services', async () => {
    const env = { DBLOOM_DATA_DIR: dir, DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com', DBLOOM_SECRET_KEY: 'cd'.repeat(32) } as NodeJS.ProcessEnv
    const u = await mkUser('dee')
    let out = ''
    const code = await main(['recover', 'dee'], env, (s) => void (out += s))
    expect(code).toBe(0)
    expect(out).toMatch(/^https:\/\/db\.example\.com\/recover#[A-Za-z0-9_-]{43}\n/)
    const rec = server.accounts.getTokenByHash(
      (await import('node:crypto')).createHash('sha256').update(out.split('#')[1]!.split('\n')[0]!).digest('hex'),
    )
    expect(rec).toMatchObject({ kind: 'recovery', userId: u.id, createdBy: 'cli' })
    expect(await main([], env, () => {})).toBe(2)
  })
})
