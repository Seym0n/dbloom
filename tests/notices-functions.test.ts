/** SPEC/30 FR-AUS-003, server side: own notices only, dismissal only of one's own, no delete anywhere. */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountSecurity } from '~/server/auth/account-security'
import { createChallengeStore } from '~/server/auth/challenges'
import { createRecoveryCodeService } from '~/server/auth/codes'
import { createPasswordService } from '~/server/auth/password'
import { ServerKeyRing } from '~/server/auth/secret-key'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createStepUp } from '~/server/auth/stepup'
import type { SignInDeps } from '~/server/auth/signin'
import { BackoffThrottle } from '~/server/auth/throttle'
import { OwnTotp } from '~/server/auth/totp'
import { ARGON2_LOGIN_DEFAULT, STATE_ALLOWED_FUNCTIONS, dismissNoticeInput, type AccountContext } from '~/server/auth/types'
import { createUserService } from '~/server/auth/users'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'

let dir: string
let store: SqliteStore
let t = 1_800_000_000_000

function rig() {
  const resolver = createAuthSettingsResolver(store.accounts, { DBLOOM_PUBLIC_ORIGIN: 'https://dbloom.test' } as NodeJS.ProcessEnv)
  const sessions = new SessionManager(store, { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3600_000 }, () => t, () => resolver.resolve())
  const password = createPasswordService({ contains: async () => false, source: () => ({ kind: 'none', entries: 0 }) })
  const ring = new ServerKeyRing(randomBytes(32), undefined)
  const challenges = createChallengeStore(() => t)
  const users = createUserService(store.accounts, (p) => password.hash(p, ARGON2_LOGIN_DEFAULT), () => t, () => resolver.resolve())
  const throttle = new BackoffThrottle(5, 15 * 60_000, 15 * 60_000, () => t)
  const deps: SignInDeps = {
    store: store.accounts, sessions, users, settings: resolver, throttle, password, totp: new OwnTotp(), codes: createRecoveryCodeService(ring), ring, challenges,
    webauthn: createWebAuthnService({ challenges, relyingParty: () => ({ rpId: 'dbloom.test', origin: 'https://dbloom.test', rpName: 'DBLoom' }) }),
    now: () => t,
  }
  const security = createAccountSecurity({
    store: store.accounts, sessions, users, settings: resolver, throttle, password, totp: deps.totp, codes: deps.codes, ring, challenges,
    webauthn: deps.webauthn, stepUp: createStepUp(deps), siteName: () => 'DBLoom', onSessionsEnded: () => undefined, now: () => t,
  })
  return { security, sessions }
}

const addUser = (id: string, status: 'active' | 'disabled' = 'active') =>
  store.db
    .prepare("INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES (?,?,?,?,'admin',?,?,1,1,'system')")
    .run(id, id, id, id, status, `w-${id}`)
const ctxOf = (r: ReturnType<typeof rig>, id: string): AccountContext => {
  const made = r.sessions.createAccount(store.accounts.getUser(id)!, 'full', { address: '203.0.113.7', clientHint: 'x' })
  return r.sessions.resolveAccount(made.token, { background: true })!
}
const notice = (id: string, userId: string, detail?: string) =>
  store.accounts.addNotice({ id, userId, kind: 'failed_burst', createdAt: t, readAt: null, ...(detail ? { detail } : {}) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-notices-fn-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  addUser('adm1')
  addUser('adm2')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('listNotices and dismissNotice', () => {
  it('lists only the caller’s notices with their detail', () => {
    const r = rig()
    notice('aaaaaaaa1', 'adm1', 'account bob: 3 failed sign-in steps in 10 min')
    notice('bbbbbbbb2', 'adm2')
    expect(r.security.listNotices(ctxOf(r, 'adm1'))).toMatchObject([{ id: 'aaaaaaaa1', detail: 'account bob: 3 failed sign-in steps in 10 min' }])
  })

  it('dismisses the caller’s own notice and keeps the first read time', () => {
    const r = rig()
    notice('aaaaaaaa1', 'adm1')
    r.security.dismissNotice(ctxOf(r, 'adm1'), 'aaaaaaaa1')
    const first = r.security.listNotices(ctxOf(r, 'adm1'))[0]!.readAt
    expect(first).not.toBeNull()
    t += 60_000
    r.security.dismissNotice(ctxOf(r, 'adm1'), 'aaaaaaaa1')
    expect(r.security.listNotices(ctxOf(r, 'adm1'))[0]!.readAt).toBe(first)
  })

  it('a foreign or unknown id changes nothing and gives the same answer', () => {
    const r = rig()
    notice('bbbbbbbb2', 'adm2')
    expect(() => r.security.dismissNotice(ctxOf(r, 'adm1'), 'bbbbbbbb2')).not.toThrow()
    expect(() => r.security.dismissNotice(ctxOf(r, 'adm1'), 'does-not-exist')).not.toThrow()
    expect(r.security.listNotices(ctxOf(r, 'adm2'))[0]!.readAt).toBeNull()
  })

  it('is not on the allow-list of any partial session state, so the middleware refuses it unless the session is full', () => {
    for (const fns of Object.values(STATE_ALLOWED_FUNCTIONS)) expect(fns).not.toContain('dismissNotice')
  })

  it('the input accepts ids of the generated shapes only', () => {
    for (const id of ['2f1c9a4e-1111-4222-8333-444455556666', 'Zm9vYmFyYmF6cXV4']) expect(dismissNoticeInput.safeParse({ id }).success).toBe(true)
    for (const id of ['', 'short', 'x'.repeat(65), 'has space1234', "a'; DROP", '../etc/passwd1']) expect(dismissNoticeInput.safeParse({ id }).success).toBe(false)
    expect(dismissNoticeInput.safeParse({ id: 'aaaaaaaa1', extra: 1 }).success).toBe(false)
  })
})

describe('no delete path', () => {
  it('no function or service method deletes a notice', () => {
    const r = rig()
    expect(Object.keys(r.security).filter((k) => /notice/i.test(k)).sort()).toEqual(['dismissNotice', 'listNotices'])
    const src = readFileSync('src/server/auth.functions.ts', 'utf8')
    const names = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!)
    expect(names.filter((n) => /notice/i.test(n)).sort()).toEqual(['dismissNotice', 'listNotices'])
    expect(readFileSync('src/server/auth/account-security.ts', 'utf8')).not.toMatch(/DELETE FROM user_notices/)
  })
})
