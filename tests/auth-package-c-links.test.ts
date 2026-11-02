/** Package C: invites and recovery links (SPEC/26 task 7). SQLite store in a temp dir; no Docker needed. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { createUserService } from '~/server/auth/users'
import { createInviteService } from '~/server/auth/invites'
import { createRecoveryService } from '~/server/auth/recovery'
import { AuthTokens } from '~/server/auth/tokens'
import { BackoffThrottle } from '~/server/auth/throttle'
import type { LinkDeps } from '~/server/auth/links'
import { ARGON2_LOGIN_DEFAULT, AuthError, type AuthUser } from '~/server/auth/types'

type RegistrationResponseJSONLike = never

let dir: string
let store: SqliteStore
let clock = 1_000_000
let ended: string[][]
let verifyFails = false

const settings = {
  publicOrigin: 'https://db.example/',
  inviteLifetimeMs: 7 * 86_400_000,
  recoveryLinkLifetimeMs: 24 * 3_600_000,
  passwordMinLength: 12,
  breachedCheck: false,
  argon2Login: ARGON2_LOGIN_DEFAULT,
}
const fakeHash = async (pw: string) => `$phc$${pw}`
const realUsers = () => createUserService(store.accounts, fakeHash, () => clock)
const deps = (over: Partial<LinkDeps> = {}): LinkDeps => ({
  store: store.accounts,
  tokens: new AuthTokens(),
  users: realUsers(),
  passwords: {
    hash: fakeHash,
    check: async (pw, ctx) => ({ reason: pw.length < ctx.minLength ? 'too_short' : null, breachedListUnavailable: false }),
  },
  webauthn: {
    registrationOptions: async () => ({ challenge: 'c' }) as never,
    verifyRegistration: async () => {
      if (verifyFails) throw new AuthError('mfa_failed')
      return { id: 'cred1', publicKey: new Uint8Array([1]), counter: 0, transports: [], backedUp: false, uvInitial: true }
    },
  },
  throttle: new BackoffThrottle(5, 60_000, 60_000, () => clock),
  settings: () => settings,
  now: () => clock,
  onSessionsEnded: (ids) => void ended.push(ids),
  ...over,
})

const admin = async (): Promise<AuthUser> => {
  const u = await realUsers().create({ username: 'root', displayName: 'Root', role: 'admin', password: 'correct horse battery' }, 'setup')
  return { id: u.id, username: u.username, displayName: u.displayName, role: 'admin', securityVersion: 0 }
}
const tokenOf = (link: string) => link.split('#')[1]!
const pw = { kind: 'password' as const, password: 'a good long password' }
const meta = { address: '10.0.0.1' }
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AuthError ? e.code : String(e)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-authc-'))
  store = openSqliteStore(join(dir, 'store.db'))
  clock = 1_000_000
  ended = []
  verifyFails = false
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('invites', () => {
  it('issues a fragment link, stores the hash only, clamps the lifetime', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    const r = inv.issue(a, { role: 'user' })
    expect(r.link).toMatch(/^https:\/\/db\.example\/invite#[A-Za-z0-9_-]{43}$/)
    expect(r.expiresAt).toBe(clock + settings.inviteLifetimeMs)
    const row = store.accounts.getTokenByHash(d.tokens.hashToken(tokenOf(r.link)))!
    expect(row.tokenHash).not.toContain(tokenOf(r.link))
    expect(inv.issue(a, { role: 'user', lifetimeMs: 3_600_000 }).expiresAt).toBe(clock + 3_600_000)
    expect(inv.issue(a, { role: 'user', lifetimeMs: 99 * 86_400_000 }).expiresAt).toBe(clock + settings.inviteLifetimeMs)
    expect(inv.list()).toHaveLength(3)
  })

  it('refuses non-admins and a missing public origin', async () => {
    const d = deps()
    const a = await admin()
    const user: AuthUser = { ...a, role: 'user' }
    expect(() => createInviteService(d).issue(user, { role: 'user' })).toThrow(AuthError)
    const noOrigin = deps({ settings: () => ({ ...settings, publicOrigin: null }) })
    expect(() => createInviteService(noOrigin).issue(a, { role: 'user' })).toThrow(AuthError)
    expect(store.accounts.listOpenInvites(clock)).toHaveLength(0)
  })

  it('redeems once with a password; user is created with the role and a hash', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    const token = tokenOf(inv.issue(a, { role: 'user' }).link)
    const { userId } = await inv.redeem({ token, username: 'Ana', credential: pw }, meta)
    const u = store.accounts.getUser(userId)!
    expect(u).toMatchObject({ username: 'Ana', role: 'user', displayName: 'Ana', createdBy: expect.stringMatching(/^invite:/) })
    expect(store.accounts.getPassword(userId)?.phc).toBeTruthy()
    expect(await code(inv.redeem({ token, username: 'Bob', credential: pw }, meta))).toBe('invite_invalid')
    expect(inv.list()).toHaveLength(0)
  })

  it('taken name keeps the invite usable; free name then works', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    const token = tokenOf(inv.issue(a, { role: 'user' }).link)
    expect(await code(inv.redeem({ token, username: 'ROOT', credential: pw }, meta))).toBe('auth_failed')
    expect(await code(inv.redeem({ token, username: 'free', credential: pw }, meta))).toBe('ok')
  })

  it('weak password is rejected with a reason and does not consume the invite', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    const token = tokenOf(inv.issue(a, { role: 'user' }).link)
    const err = await inv.redeem({ token, username: 'x1', credential: { kind: 'password', password: 'short' } }, meta).catch((e) => e)
    expect(err).toMatchObject({ code: 'password_rejected', detail: { reason: 'too_short' } })
    expect(inv.list()).toHaveLength(1)
  })

  it('revoked, expired, unknown and used give the same error', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    const revoked = inv.issue(a, { role: 'user' })
    inv.revoke(a, revoked.id)
    const expiring = inv.issue(a, { role: 'user', lifetimeMs: 60_000 })
    clock += 61_000
    const bad = ['A'.repeat(43), tokenOf(revoked.link), tokenOf(expiring.link)]
    for (const token of bad) expect(await code(inv.redeem({ token, username: 'zed', credential: pw }, meta))).toBe('invite_invalid')
    expect(await code(inv.passkeyOptions(tokenOf(revoked.link), 'zed', 'o'))).toBe('invite_invalid')
  })

  it('a recovery token is not an invite', async () => {
    const d = deps()
    const a = await admin()
    const { link } = createRecoveryService(d).issue(a, a.id)
    expect(await code(createInviteService(d).redeem({ token: tokenOf(link), username: 'zed', credential: pw }, meta))).toBe('invite_invalid')
  })

  it('throttles an address after repeated invalid tokens', async () => {
    const d = deps()
    const inv = createInviteService(d)
    for (let i = 0; i < 5; i += 1) await code(inv.redeem({ token: 'B'.repeat(43), username: 'zed', credential: pw }, meta))
    const err = await inv.redeem({ token: 'B'.repeat(43), username: 'zed', credential: pw }, meta).catch((e) => e)
    expect(err).toMatchObject({ code: 'auth_throttled', detail: { retryAfterSeconds: expect.any(Number) } })
  })

  it('admin invite notifies every active administrator at issue', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    inv.issue(a, { role: 'user' })
    expect(store.accounts.listNotices(a.id)).toHaveLength(0)
    inv.issue(a, { role: 'admin' })
    expect(store.accounts.listNotices(a.id).map((n) => n.kind)).toEqual(['admin_invite_issued'])
  })

  it('redeems with a passkey; failed verification leaves invite and user untouched', async () => {
    const d = deps()
    const a = await admin()
    const inv = createInviteService(d)
    const token = tokenOf(inv.issue(a, { role: 'user' }).link)
    const cred = { kind: 'passkey' as const, response: {} as RegistrationResponseJSONLike, name: 'Laptop' }
    expect(await code(inv.redeem({ token, username: 'pk', credential: cred }, meta))).toBe('mfa_failed') // no pre-auth owner
    verifyFails = true
    expect(await code(inv.redeem({ token, username: 'pk', credential: cred }, { ...meta, preAuthOwner: 'o' }))).toBe('mfa_failed')
    expect(inv.list()).toHaveLength(1)
    verifyFails = false
    const { userId } = await inv.redeem({ token, username: 'pk', credential: cred }, { ...meta, preAuthOwner: 'o' })
    expect(store.accounts.getPassword(userId)).toBeUndefined()
    expect(store.accounts.listPasskeys(userId)).toMatchObject([{ id: 'cred1', name: 'Laptop', uvInitial: true }])
  })
})

describe('recovery', () => {
  it('issues a fragment link with a 24 h lifetime; only admins or the CLI', async () => {
    const d = deps()
    const a = await admin()
    const ana = await realUsers().create({ username: 'ana', displayName: 'Ana', role: 'user', password: 'correct horse battery' }, a)
    const rec = createRecoveryService(d)
    const r = rec.issue(a, ana.id)
    expect(r.link).toMatch(/^https:\/\/db\.example\/recover#[A-Za-z0-9_-]{43}$/)
    expect(r.expiresAt).toBe(clock + settings.recoveryLinkLifetimeMs)
    const again = rec.issue('cli', ana.id) // revokes the first link
    expect(d.store.listOpenRecoveryTokens(ana.id, clock)).toHaveLength(1)
    expect(await code(rec.redeem({ token: tokenOf(r.link), credential: { kind: 'password', password: 'another long passphrase' } }, meta))).toBe('recovery_invalid')
    expect(again.link).not.toBe(r.link)
    expect(() => rec.issue({ ...a, role: 'user' }, ana.id)).toThrow(AuthError)
    expect(() => rec.issue('cli', 'nope')).toThrow(AuthError)
  })

  it('redeem applies ST-085: factors gone, password set, version bumped, sessions ended, vault kept, notices', async () => {
    const d = deps()
    const a = await admin()
    const ana = await realUsers().create({ username: 'ana', displayName: 'Ana', role: 'user', password: 'old password long' }, a, { temporary: true })
    const s = store.accounts
    s.addPasskey({ id: 'p1', userId: ana.id, publicKey: new Uint8Array([1]), counter: 3, transports: [], backedUp: false, uvInitial: true, name: 'k', createdAt: 1, lastUsedAt: null })
    s.setTotp({ userId: ana.id, sealed: 'x', lastStep: 1, createdAt: 1 })
    s.replaceRecoveryCodes(ana.id, ['m1', 'm2'], 1)
    store.createSession({ idHash: 'h1', targetKey: 'k', userName: 'ana', createdAt: 1, lastSeenAt: 1, expiresAt: clock + 9999 })
    s.createAccountSession({ idHash: 'h1', kind: 'account', userId: ana.id, state: 'full', mfaAt: null, stepupAt: null, securityVersion: 0, clientHint: '', address: '' } as never)
    d.throttle.fail(`acct:${ana.usernameKey}`)
    const rec = createRecoveryService(d)
    const token = tokenOf(rec.issue(a, ana.id).link)
    const { userId } = await rec.redeem({ token, credential: { kind: 'password', password: 'brand new password' } }, meta)
    expect(userId).toBe(ana.id)
    expect(s.listPasskeys(ana.id)).toHaveLength(0)
    expect(s.getTotp(ana.id)).toBeUndefined()
    expect(s.countRecoveryCodes(ana.id)).toBe(0)
    expect(s.getPassword(ana.id)?.phc).toBe('$phc$brand new password')
    expect(s.getUser(ana.id)).toMatchObject({ securityVersion: 1, mustChangePassword: false, tempPasswordExpiresAt: null })
    expect(s.listUserSessions(ana.id)).toHaveLength(0)
    expect(ended).toEqual([['h1']])
    expect(s.listNotices(ana.id).map((n) => n.kind)).toEqual(['recovery_redeemed'])
    expect(s.listNotices(a.id).map((n) => n.kind)).toEqual(['recovery_redeemed'])
    expect(d.throttle.delayMs(`acct:${ana.usernameKey}`)).toBe(0)
    expect(await code(rec.redeem({ token, credential: pw }, meta))).toBe('recovery_invalid')
  })

  it('administrator recovering herself gets one notice', async () => {
    const d = deps()
    const a = await admin()
    const rec = createRecoveryService(d)
    await rec.redeem({ token: tokenOf(rec.issue('cli', a.id).link), credential: pw }, meta)
    expect(store.accounts.listNotices(a.id)).toHaveLength(1)
  })

  it('passkey recovery removes the password and registers the passkey', async () => {
    const d = deps()
    const a = await admin()
    const rec = createRecoveryService(d)
    const token = tokenOf(rec.issue('cli', a.id).link)
    const cred = { kind: 'passkey' as const, response: {} as RegistrationResponseJSONLike, name: 'Key' }
    await rec.redeem({ token, credential: cred }, { ...meta, preAuthOwner: 'o' })
    expect(store.accounts.getPassword(a.id)).toBeUndefined()
    expect(store.accounts.listPasskeys(a.id)).toHaveLength(1)
  })

  it('weak password or failed passkey leaves everything intact and the link usable', async () => {
    const d = deps()
    const a = await admin()
    const s = store.accounts
    s.replaceRecoveryCodes(a.id, ['m1'], 1)
    const rec = createRecoveryService(d)
    const token = tokenOf(rec.issue('cli', a.id).link)
    expect(await code(rec.redeem({ token, credential: { kind: 'password', password: 'short' } }, meta))).toBe('password_rejected')
    verifyFails = true
    expect(await code(rec.redeem({ token, credential: { kind: 'passkey', response: {} as never, name: 'k' } }, { ...meta, preAuthOwner: 'o' }))).toBe('mfa_failed')
    expect(s.countRecoveryCodes(a.id)).toBe(1)
    expect(s.getUser(a.id)?.securityVersion).toBe(0)
    expect(await code(rec.redeem({ token, credential: pw }, meta))).toBe('ok')
  })

  it('expired, unknown, invite-kind and disabled-user tokens give recovery_invalid', async () => {
    const d = deps()
    const a = await admin()
    const ana = await realUsers().create({ username: 'ana', displayName: 'Ana', role: 'user', password: 'correct horse battery' }, a)
    const rec = createRecoveryService(d)
    const old = tokenOf(rec.issue(a, ana.id).link)
    clock += settings.recoveryLinkLifetimeMs + 1
    const fresh = tokenOf(rec.issue(a, ana.id).link)
    store.accounts.updateUser(ana.id, { status: 'disabled' })
    const inviteTok = tokenOf(createInviteService(d).issue(a, { role: 'user' }).link)
    for (const token of [old, fresh, inviteTok, 'C'.repeat(43)]) expect(await code(rec.redeem({ token, credential: pw }, meta))).toBe('recovery_invalid')
    expect(await code(rec.passkeyOptions(old, 'o'))).toBe('recovery_invalid')
  })
})
