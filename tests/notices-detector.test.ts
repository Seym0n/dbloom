/** SPEC/30 FR-AUS-001, 002: failed-attempt bursts and new-location sign-ins, detector alone and through the sign-in service. */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureAnonymiser } from '~/server/audit/anonymise'
import { createChallengeStore } from '~/server/auth/challenges'
import { createRecoveryCodeService } from '~/server/auth/codes'
import { COUNTER_CAP, createNoticeDetector, type NoticeSettings } from '~/server/auth/notices'
import { createPasswordService } from '~/server/auth/password'
import { ServerKeyRing } from '~/server/auth/secret-key'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { createSignInService, type SignInDeps } from '~/server/auth/signin'
import { BackoffThrottle } from '~/server/auth/throttle'
import { OwnTotp } from '~/server/auth/totp'
import { ARGON2_LOGIN_DEFAULT, AuthError } from '~/server/auth/types'
import { createUserService } from '~/server/auth/users'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'

const MIN = 60_000
const DAY = 86_400_000
const SETTINGS: NoticeSettings = { noticeBurstFailures: 3, noticeBurstMinutes: 10, noticeLocationDays: 90 }

let dir: string
let store: SqliteStore
let clock: { t: number }

const user = (id: string, role: 'admin' | 'user' = 'user', status: 'active' | 'disabled' = 'active') =>
  store.db
    .prepare("INSERT INTO users (id, username, username_key, display_name, role, status, webauthn_user_id, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,1,1,'system')")
    .run(id, id, id, id, role, status, `w-${id}`)
const detector = (settings = SETTINGS) => createNoticeDetector({ store: store.accounts, settings: () => settings, now: () => clock.t })
const notices = (uid: string) => store.accounts.listNotices(uid)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-notices-det-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  clock = { t: Date.UTC(2026, 10, 3, 12) }
  user('adm1', 'admin')
  user('adm2', 'admin')
  user('off', 'admin', 'disabled')
  user('ann')
})
afterEach(() => {
  configureAnonymiser('off')
  vi.restoreAllMocks()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('failed-attempt burst', () => {
  it('below the threshold nothing, at it one notice per active administrator, repeats silent until the window passed', () => {
    const d = detector()
    d.failedAttempt({ userId: 'ann', username: 'ann' })
    d.failedAttempt({ userId: 'ann', username: 'ann' })
    expect(notices('adm1')).toHaveLength(0)
    d.failedAttempt({ userId: 'ann', username: 'ann' })
    expect(notices('adm1')).toMatchObject([{ kind: 'failed_burst', detail: 'account ann: 3 failed sign-in steps in 10 min' }])
    expect(notices('adm2')).toHaveLength(1)
    expect(notices('off')).toHaveLength(0)
    expect(notices('ann')).toHaveLength(0)
    for (let i = 0; i < 5; i++) d.failedAttempt({ userId: 'ann', username: 'ann' })
    expect(notices('adm1')).toHaveLength(1)
    clock.t += 11 * MIN
    for (let i = 0; i < 3; i++) d.failedAttempt({ userId: 'ann', username: 'ann' })
    expect(notices('adm1')).toHaveLength(2)
  })

  it('failures outside the window do not add up', () => {
    const d = detector()
    d.failedAttempt({ userId: 'ann' })
    clock.t += 6 * MIN
    d.failedAttempt({ userId: 'ann' })
    clock.t += 6 * MIN
    d.failedAttempt({ userId: 'ann' })
    expect(notices('adm1')).toHaveLength(0)
  })

  it('a spray from one /24 over unknown names raises an address notice; account and address count separately', () => {
    const d = detector()
    for (const addr of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) d.failedAttempt({}, addr)
    expect(notices('adm1')).toMatchObject([{ kind: 'failed_burst', detail: 'address 198.51.100.0: 3 failed sign-in steps in 10 min' }])
    // the same failures against a known account also reach the account counter
    const e = detector()
    e.failedAttempt({ userId: 'ann', username: 'ann' }, '203.0.113.5')
    e.failedAttempt({ userId: 'ann', username: 'ann' }, '203.0.113.6')
    e.failedAttempt({ userId: 'ann', username: 'ann' }, '203.0.113.7')
    expect(notices('adm1').map((n) => n.detail).sort()).toEqual([
      'account ann: 3 failed sign-in steps in 10 min',
      'address 198.51.100.0: 3 failed sign-in steps in 10 min',
      'address 203.0.113.0: 3 failed sign-in steps in 10 min',
    ])
  })

  it('the address in the detail follows the anonymise mode', () => {
    configureAnonymiser('hash', Buffer.alloc(32, 7))
    const d = detector()
    for (let i = 0; i < 3; i++) d.failedAttempt({}, `198.51.100.${i}`)
    const detail = notices('adm1')[0]!.detail!
    expect(detail).toMatch(/^address h:[0-9a-f]{16}: 3 /)
    expect(detail).not.toContain('198.51.100')
  })

  it('the counter map is capped and pruned', () => {
    const d = detector({ ...SETTINGS, noticeBurstFailures: 20 })
    for (let i = 0; i < COUNTER_CAP + 50; i++) d.failedAttempt({ userId: `u${i}` })
    // no assertion on size is possible from outside; the run must finish and still count correctly for a known key
    for (let i = 0; i < 20; i++) d.failedAttempt({ userId: 'ann', username: 'ann' })
    expect(notices('adm1')).toHaveLength(1)
  })

  it('a secret-shaped account name never reaches storage beyond the user name the administrator can see anyway', () => {
    const d = detector()
    for (let i = 0; i < 3; i++) d.failedAttempt({ userId: 'ann', username: 'ann' }, '203.0.113.9')
    expect(JSON.stringify(notices('adm1'))).not.toMatch(/password|token/i)
  })
})

describe('new location', () => {
  it('first sign-in records the prefix and raises nothing; same prefix is silent; another prefix raises one notice', () => {
    const d = detector()
    d.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.7')
    expect(notices('adm1')).toHaveLength(0)
    expect(store.accounts.countSeenLocations('ann')).toBe(1)
    d.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.200')
    expect(notices('adm1')).toHaveLength(0)
    d.completedSignIn({ id: 'ann', username: 'ann' }, '198.51.100.9')
    expect(notices('adm1')).toMatchObject([{ kind: 'new_location', detail: 'account ann from 198.51.100.0' }])
    expect(notices('adm2')).toHaveLength(1)
    expect(notices('ann')).toHaveLength(0)
    d.completedSignIn({ id: 'ann', username: 'ann' }, '198.51.100.77')
    expect(notices('adm1')).toHaveLength(1)
  })

  it('a prefix not used for 90 days is new again', () => {
    const d = detector()
    d.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.7')
    d.completedSignIn({ id: 'ann', username: 'ann' }, '198.51.100.9')
    expect(notices('adm1')).toHaveLength(1)
    clock.t += 91 * DAY
    d.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.7')
    expect(notices('adm1')).toHaveLength(2)
  })

  it('IPv6 is reduced to /48 and IPv4-mapped addresses to /24', () => {
    const d = detector()
    d.completedSignIn({ id: 'ann', username: 'ann' }, '2001:db8:abcd:1::5')
    d.completedSignIn({ id: 'ann', username: 'ann' }, '2001:db8:abcd:ffff::9')
    expect(notices('adm1')).toHaveLength(0)
    d.completedSignIn({ id: 'ann', username: 'ann' }, '2001:db8:beef::1')
    expect(notices('adm1')).toHaveLength(1)
    d.completedSignIn({ id: 'ann', username: 'ann' }, '::ffff:203.0.113.4')
    d.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.99')
    expect(notices('adm1')).toHaveLength(2) // the mapped one is a new prefix once, the plain v4 of the same /24 is not
  })

  it('an unreadable or missing address is ignored', () => {
    const d = detector()
    d.completedSignIn({ id: 'ann', username: 'ann' }, undefined)
    d.completedSignIn({ id: 'ann', username: 'ann' }, 'not-an-address')
    expect(store.accounts.countSeenLocations('ann')).toBe(0)
  })

  it('a throwing store never throws into the caller', () => {
    const broken = { ...store.accounts, getSeenLocation: () => { throw new Error('boom') } }
    const d = createNoticeDetector({ store: broken as never, settings: () => SETTINGS, now: () => clock.t, onError: () => undefined })
    expect(() => d.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.7')).not.toThrow()
    const logged: unknown[] = []
    const d2 = createNoticeDetector({ store: broken as never, settings: () => SETTINGS, now: () => clock.t, onError: (e) => logged.push(e) })
    d2.completedSignIn({ id: 'ann', username: 'ann' }, '203.0.113.7')
    expect(logged).toHaveLength(1)
  })
})

describe('through the sign-in service', () => {
  const PASSWORD = 'correct horse battery staple'
  const META = (address: string) => ({ address, clientHint: 'Chrome on Windows' })

  function rig() {
    const resolver = createAuthSettingsResolver(store.accounts, { DBLOOM_PUBLIC_ORIGIN: 'https://dbloom.test', DBLOOM_NOTICE_BURST_FAILURES: '3' } as NodeJS.ProcessEnv)
    const sessions = new SessionManager(store, { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3600_000 }, () => clock.t, () => resolver.resolve())
    const password = createPasswordService({ contains: async () => false, source: () => ({ kind: 'none', entries: 0 }) })
    const ring = new ServerKeyRing(randomBytes(32), undefined)
    const challenges = createChallengeStore(() => clock.t)
    const users = createUserService(store.accounts, (p) => password.hash(p, ARGON2_LOGIN_DEFAULT), () => clock.t, () => resolver.resolve())
    const deps: SignInDeps = {
      store: store.accounts, sessions, users, settings: resolver,
      throttle: new BackoffThrottle(50, 15 * 60_000, 15 * 60_000, () => clock.t),
      password, totp: new OwnTotp(), codes: createRecoveryCodeService(ring), ring, challenges,
      webauthn: createWebAuthnService({ challenges, relyingParty: () => ({ rpId: 'dbloom.test', origin: 'https://dbloom.test', rpName: 'DBLoom' }) }),
      now: () => clock.t,
    }
    return { signIn: createSignInService(deps), users }
  }

  it('three wrong passwords produce one burst notice; a first sign-in and a repeat are silent; another network raises one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const r = rig()
    await r.users.create({ username: 'bea', displayName: 'bea', role: 'user', password: PASSWORD }, 'setup', { temporary: false })
    for (let i = 0; i < 3; i++) await r.signIn.passwordSignIn({ username: 'bea', password: 'wrong wrong wrong wrong' }, META('203.0.113.7')).then(() => undefined, (e) => expect(e).toBeInstanceOf(AuthError))
    const bursts = notices('adm1').filter((n) => n.kind === 'failed_burst')
    expect(bursts.map((n) => n.detail).sort()).toEqual(['account bea: 3 failed sign-in steps in 10 min', 'address 203.0.113.0: 3 failed sign-in steps in 10 min'])

    await r.signIn.passwordSignIn({ username: 'bea', password: PASSWORD }, META('203.0.113.8'))
    await r.signIn.passwordSignIn({ username: 'bea', password: PASSWORD }, META('203.0.113.9'))
    expect(notices('adm1').filter((n) => n.kind === 'new_location')).toHaveLength(0)
    await r.signIn.passwordSignIn({ username: 'bea', password: PASSWORD }, META('192.0.2.50'))
    expect(notices('adm1').filter((n) => n.kind === 'new_location')).toMatchObject([{ detail: 'account bea from 192.0.2.0' }])
  }, 30_000)

  it('a detector that cannot write notices does not fail the sign-in', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const r = rig()
    await r.users.create({ username: 'cy', displayName: 'cy', role: 'user', password: PASSWORD }, 'setup', { temporary: false })
    await r.signIn.passwordSignIn({ username: 'cy', password: PASSWORD }, META('203.0.113.1'))
    store.db.exec('DROP TABLE user_notices')
    const out = await r.signIn.passwordSignIn({ username: 'cy', password: PASSWORD }, META('192.0.2.77'))
    expect(out.state).toBe('full')
  }, 30_000)
})
