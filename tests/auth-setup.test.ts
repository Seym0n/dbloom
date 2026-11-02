/** Package C task 5: setup service, start gate (FR-AUT-001 to 003; DEP-TGT-100, 123; ST-031, 050, 051). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecoveryCodeService } from '~/server/auth/codes'
import { createPasswordService } from '~/server/auth/password'
import { loadSecretKey } from '~/server/auth/secret-key'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { SetupError, addressInNetworks, createSetupService, type SetupApi } from '~/server/auth/setup'
import { StartRefusal, evaluateStart } from '~/server/auth/start-gate'
import { createThrottle } from '~/server/auth/throttle'
import { tokens } from '~/server/auth/tokens'
import { hotp, totp } from '~/server/auth/totp'
import { AAD, AuthError, SETUP_TOKEN_FILE, type BreachedList, type SetupSiteValues, type WebAuthnService } from '~/server/auth/types'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'

const KEY = 'ab'.repeat(32)
const GOOD_ENV = { DBLOOM_SECRET_KEY: KEY, DBLOOM_PUBLIC_ORIGIN: 'http://localhost:3000' }
const PASSWORD = 'tangerine-orbit-quartz-77'
const ADMIN_IN = { username: 'admin', displayName: 'Admin', password: PASSWORD }

let dir: string
let store: SqliteStore
let clock: number
let lines: string[]
let breachedAnswer: boolean | 'unavailable'
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-setup-'))
  store = openSqliteStore(join(dir, 'dbloom.db'))
  clock = 1_800_000_000_000
  lines = []
  breachedAnswer = false
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const breached: BreachedList = { contains: async () => breachedAnswer, source: () => ({ kind: 'none', entries: 0 }) }
const fakeWebauthn: WebAuthnService = {
  registrationOptions: async () => ({ challenge: 'c', rp: { name: 'x' }, user: { id: 'u', name: 'n', displayName: 'd' }, pubKeyCredParams: [] }),
  verifyRegistration: async () => ({ id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], backedUp: false, uvInitial: true }),
  authenticationOptions: async () => ({ challenge: 'c' }) as never,
  verifyAuthentication: async () => ({ newCounter: 1, userVerified: true, backedUp: false }),
}

function make(env: NodeJS.ProcessEnv = {}, extra: { webauthn?: boolean } = { webauthn: true }): SetupApi {
  const merged = { ...GOOD_ENV, ...env }
  const key = loadSecretKey(merged)
  const ring = key.ok ? key.ring : undefined
  return createSetupService({
    accounts: store.accounts,
    dataDir: dir,
    env: merged,
    stateless: false,
    resolver: createAuthSettingsResolver(store.accounts, merged),
    tokens,
    passwords: createPasswordService(breached),
    totp,
    recoveryCodes: ring ? createRecoveryCodeService(ring) : undefined,
    ring,
    webauthn: extra.webauthn ? () => fakeWebauthn : undefined,
    throttle: createThrottle([5, 15 * 60_000, 15 * 60_000, () => clock]),
    now: () => clock,
    log: (l) => lines.push(l),
  })
}
const tokenOnDisk = () => readFileSync(join(dir, SETUP_TOKEN_FILE), 'utf8').split('\n')[0]!

async function walkToAdmin(setup: SetupApi, cookie: string, siteOverride: Partial<SetupSiteValues> = {}) {
  await setup.saveStep(cookie, { step: 2, loginMode: 'account' })
  const defaults = setup.state(cookie)!.defaults
  await setup.saveStep(cookie, { step: 3, site: { ...defaults, ...siteOverride } })
  return setup.saveStep(cookie, { step: 4, ...ADMIN_IN })
}
const currentCode = (secretB32: string) => {
  // Decode the base32 secret the wizard showed, as the authenticator app would.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of secretB32) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return hotp(Buffer.from(out), Math.floor(clock / 1000 / 30))
}

describe('token (FR-AUT-002)', () => {
  it('generates a 160-bit token, prints it, writes a 0600 file, expires after 60 minutes', () => {
    const setup = make()
    setup.prepareToken(clock)
    const token = tokenOnDisk()
    expect(token).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
    expect(lines.join('\n')).toContain(token)
    if (process.platform !== 'win32') expect(statSync(join(dir, SETUP_TOKEN_FILE)).mode & 0o777).toBe(0o600)
    expect(setup.tokenExpiresAt()).toBe(clock + 60 * 60_000)
    clock += 60 * 60_000 + 1
    expect(() => setup.verifyToken(token, '1.2.3.4')).toThrow(SetupError)
  })

  it('accepts the token case-insensitively without dashes; consumed by completion only', () => {
    const setup = make()
    setup.prepareToken(clock)
    const t = tokenOnDisk()
    expect(setup.verifyToken(t.replace(/-/g, '').toLowerCase(), '1.2.3.4').cookie).toBeTruthy()
  })

  it('takes DBLOOM_SETUP_TOKEN exactly (case sensitive) and refuses a short one', () => {
    const env = 'Abcdefghijklmnopqrstuv_-1'
    const setup = make({ DBLOOM_SETUP_TOKEN: env })
    setup.prepareToken(clock)
    expect(lines.join('\n')).not.toContain(env)
    expect(() => setup.verifyToken(env.toLowerCase(), '1.2.3.4')).toThrow(SetupError)
    expect(setup.verifyToken(env, '1.2.3.4').csrf).toBeTruthy()
    expect(() => make({ DBLOOM_SETUP_TOKEN: 'short' }).prepareToken(clock)).toThrow(StartRefusal)
  })

  it('throttles wrong tokens per address: fixed failure, then backoff with retry-after', () => {
    const setup = make()
    setup.prepareToken(clock)
    for (let i = 0; i < 5; i += 1) expect(() => setup.verifyToken('WRONG', '9.9.9.9')).toThrow(SetupError)
    let err: unknown
    try {
      setup.verifyToken(tokenOnDisk(), '9.9.9.9')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).code).toBe('auth_throttled')
    expect((err as AuthError).detail.retryAfterSeconds).toBeGreaterThan(0)
    // Another address is unaffected; after the delay the right token works.
    expect(setup.verifyToken(tokenOnDisk(), '8.8.8.8').cookie).toBeTruthy()
    clock += 5_000
    expect(setup.verifyToken(tokenOnDisk(), '9.9.9.9').cookie).toBeTruthy()
  })

  it('DBLOOM_SETUP_NETWORKS narrows reachability with 404 semantics', () => {
    const setup = make({ DBLOOM_SETUP_NETWORKS: '10.0.0.0/8, ::1/128' })
    setup.prepareToken(clock)
    const t = tokenOnDisk()
    expect(() => setup.verifyToken(t, '203.0.113.9')).toThrow(expect.objectContaining({ code: 'gone' }))
    expect(setup.verifyToken(t, '10.1.2.3').cookie).toBeTruthy()
    expect(setup.reachable('::1')).toBe(true)
    expect(addressInNetworks('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(addressInNetworks('nonsense', ['10.0.0.0/8'])).toBe(false)
  })
})

describe('wizard (FR-AUT-003)', () => {
  it('keeps everything in memory until step 5; steps cannot be skipped', async () => {
    const setup = make()
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await expect(setup.saveStep(cookie, { step: 4, ...ADMIN_IN })).rejects.toMatchObject({ code: 'step' })
    const draft = await walkToAdmin(setup, cookie)
    expect(draft.step).toBe(4)
    expect(draft.admin).toMatchObject({ username: 'admin', passwordSet: true })
    expect(JSON.stringify(draft)).not.toContain(PASSWORD)
    expect(store.accounts.getSite()).toEqual({})
    expect(store.accounts.listUsers()).toEqual([])
    expect(store.accounts.getSettings()).toEqual([])
  })

  it('refuses a breached password and fails closed when the list is unavailable', async () => {
    const setup = make()
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await setup.saveStep(cookie, { step: 2, loginMode: 'account' })
    await setup.saveStep(cookie, { step: 3, site: { ...setup.state(cookie)!.defaults, breachedCheck: true } })
    breachedAnswer = true
    await expect(setup.saveStep(cookie, { step: 4, ...ADMIN_IN })).rejects.toMatchObject({ code: 'password_rejected', detail: { reason: 'breached' } })
    breachedAnswer = 'unavailable'
    await expect(setup.saveStep(cookie, { step: 4, ...ADMIN_IN })).rejects.toMatchObject({ detail: { reason: 'breached' } })
    breachedAnswer = false
    await expect(setup.saveStep(cookie, { step: 4, ...ADMIN_IN, password: 'short' })).rejects.toMatchObject({ detail: { reason: 'too_short' } })
  })

  it('completes with TOTP: user, password, sealed secret, codes, site and settings in one transaction', async () => {
    const setup = make()
    setup.prepareToken(clock)
    const { cookie, csrf } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    expect(setup.csrfOk(cookie, csrf)).toBe(true)
    expect(setup.csrfOk(cookie, 'nope')).toBe(false)
    expect(setup.csrfOk(cookie, undefined)).toBe(false)
    await walkToAdmin(setup, cookie, { siteName: 'Acme DB', sessionsPerUser: 3 })
    const started = setup.totpStart(cookie)
    expect(started.uri.startsWith('otpauth://totp/')).toBe(true)
    expect(started.qrSvg).toContain('<svg')
    expect(() => setup.totpVerify(cookie, '000000')).toThrow(expect.objectContaining({ code: 'totp_invalid' }))
    const { recoveryCodes } = setup.totpVerify(cookie, currentCode(started.secret))
    expect(recoveryCodes).toHaveLength(10)
    expect(setup.state(cookie)!.draft.step).toBe(5)
    expect(() => setup.complete(cookie, { acknowledgeAdminNetwork: false })).toThrow(expect.objectContaining({ code: 'step' })) // codes not saved
    expect(store.accounts.getSite()).toEqual({})
    setup.complete(cookie, { codesSaved: true, acknowledgeAdminNetwork: false })

    const user = store.accounts.getUserByKey('admin')!
    expect(user).toMatchObject({ role: 'admin', status: 'active', createdBy: 'setup' })
    expect(await createPasswordService(breached).verify(store.accounts.getPassword(user.id)!.phc, PASSWORD)).toBe(true)
    const rec = store.accounts.getTotp(user.id)!
    expect(rec.sealed).not.toContain(started.secret)
    const ring = loadSecretKey({ DBLOOM_SECRET_KEY: KEY })
    expect(ring.ok && ring.ring.open('totp', AAD.totp(user.id), rec.sealed)).toBeTruthy()
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(10)
    expect(store.accounts.getSite()).toMatchObject({ loginMode: 'account', siteName: 'Acme DB' })
    expect(store.accounts.getSite().setupCompletedAt).toBe(clock)
    expect(createAuthSettingsResolver(store.accounts, GOOD_ENV).resolve().sessionsPerUser).toBe(3)

    // Consumed: file gone, message printed, 404 everywhere, also after a restart.
    expect(existsSync(join(dir, SETUP_TOKEN_FILE))).toBe(false)
    expect(lines).toContain('setup token consumed')
    expect(() => setup.complete(cookie, { codesSaved: true, acknowledgeAdminNetwork: false })).toThrow(expect.objectContaining({ code: 'gone' }))
    expect(setup.state(cookie)).toBeUndefined()
    const restarted = make()
    restarted.prepareToken(clock)
    expect(existsSync(join(dir, SETUP_TOKEN_FILE))).toBe(false)
    expect(restarted.isComplete()).toBe(true)
    expect(() => restarted.verifyToken('ANY', '127.0.0.1')).toThrow(expect.objectContaining({ code: 'gone' }))
    expect(restarted.startupState()).toEqual({ kind: 'ready', mode: 'account' })
  })

  it('completes with a passkey (user verification required) and no codes', async () => {
    const spy = vi.spyOn(fakeWebauthn, 'verifyRegistration')
    const setup = make()
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await walkToAdmin(setup, cookie)
    await setup.passkeyOptions(cookie)
    await setup.passkeyVerify(cookie, {} as never, 'Laptop')
    expect(spy).toHaveBeenCalledWith(expect.any(String), 'setup_passkey', expect.anything(), { requireUserVerification: true })
    setup.complete(cookie, { acknowledgeAdminNetwork: false })
    const user = store.accounts.getUserByKey('admin')!
    expect(store.accounts.listPasskeys(user.id)).toMatchObject([{ id: 'cred-1', name: 'Laptop', uvInitial: true }])
    expect(store.accounts.countRecoveryCodes(user.id)).toBe(0)
  })

  it('needs a factor, and passkeys answer unavailable without a WebAuthn service', async () => {
    const setup = make({}, { webauthn: false })
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await walkToAdmin(setup, cookie)
    await expect(setup.passkeyOptions(cookie)).rejects.toMatchObject({ code: 'passkey_unavailable' })
    expect(() => setup.complete(cookie, { acknowledgeAdminNetwork: false })).toThrow(expect.objectContaining({ code: 'step' }))
  })

  it('asks for acknowledgement when the browser is outside the administration networks (Q6)', async () => {
    const setup = make()
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '203.0.113.5')
    await walkToAdmin(setup, cookie)
    const s = setup.totpStart(cookie)
    setup.totpVerify(cookie, currentCode(s.secret))
    expect(setup.state(cookie)!.env).toMatchObject({ browserInAdminNetworks: false, browserAddress: '203.0.113.5', secretKeyPresent: true })
    expect(() => setup.complete(cookie, { codesSaved: true, acknowledgeAdminNetwork: false })).toThrow(expect.objectContaining({ code: 'admin_network' }))
    setup.complete(cookie, { codesSaved: true, acknowledgeAdminNetwork: true })
    expect(store.accounts.getSite().setupCompletedAt).toBeDefined()
  })

  it('account mode without the server key cannot complete', async () => {
    const setup = make({ DBLOOM_SECRET_KEY: '' })
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await walkToAdmin(setup, cookie)
    expect(() => setup.totpStart(cookie)).toThrow(expect.objectContaining({ code: 'env' }))
  })

  it('direct mode chosen in the wizard needs targets or the free-form acknowledgement to complete (SEC-TGT-018)', async () => {
    const setup = make()
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await setup.saveStep(cookie, { step: 2, loginMode: 'direct' })
    await setup.saveStep(cookie, { step: 3, site: setup.state(cookie)!.defaults })
    expect(() => setup.complete(cookie, { acknowledgeAdminNetwork: false })).toThrow(expect.objectContaining({ code: 'env' }))
    expect(store.accounts.getSite().setupCompletedAt).toBeUndefined()
  })

  it('direct mode skips step 4 and writes no user', async () => {
    const setup = make({ DBLOOM_DIRECT_FREE_FORM_ACK: 'true' })
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await setup.saveStep(cookie, { step: 2, loginMode: 'direct' })
    const draft = await setup.saveStep(cookie, { step: 3, site: setup.state(cookie)!.defaults })
    expect(draft.step).toBe(5)
    setup.complete(cookie, { acknowledgeAdminNetwork: false })
    expect(store.accounts.getSite()).toMatchObject({ loginMode: 'direct' })
    expect(store.accounts.listUsers()).toEqual([])
    expect(setup.startupState()).toEqual({ kind: 'ready', mode: 'direct' })
  })

  it('a race between two completions has one winner', async () => {
    const a = make()
    a.prepareToken(clock)
    const { cookie } = a.verifyToken(tokenOnDisk(), '127.0.0.1')
    await a.saveStep(cookie, { step: 2, loginMode: 'direct' })
    await a.saveStep(cookie, { step: 3, site: a.state(cookie)!.defaults })
    // A second instance (second process) already completed the store.
    store.accounts.setSite({ loginMode: 'direct', setupCompletedAt: clock, siteName: 'x' })
    expect(() => a.complete(cookie, { acknowledgeAdminNetwork: false })).toThrow(expect.objectContaining({ code: 'gone' }))
  })

  it('autoSetupDirect completes without a wizard and removes any token file', () => {
    const setup = make({ DBLOOM_AUTO_SETUP: 'direct' })
    setup.autoSetupDirect(clock)
    expect(store.accounts.getSite()).toMatchObject({ loginMode: 'direct', setupCompletedAt: clock })
    expect(existsSync(join(dir, SETUP_TOKEN_FILE))).toBe(false)
    setup.prepareToken(clock)
    expect(existsSync(join(dir, SETUP_TOKEN_FILE))).toBe(false)
  })

  it('never prints the password, TOTP secret or recovery codes to stdout or the audit log', async () => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
    const setup = make()
    setup.prepareToken(clock)
    const { cookie } = setup.verifyToken(tokenOnDisk(), '127.0.0.1')
    await walkToAdmin(setup, cookie)
    const s = setup.totpStart(cookie)
    const { recoveryCodes } = setup.totpVerify(cookie, currentCode(s.secret))
    setup.complete(cookie, { codesSaved: true, acknowledgeAdminNetwork: true })
    const all = out.join('\n') + lines.join('\n')
    for (const secret of [PASSWORD, s.secret, ...recoveryCodes]) expect(all).not.toContain(secret)
    expect(out.some((l) => l.includes('"audit":"setup.complete"'))).toBe(true)
  })
})

describe('start gate (FR-AUT-001)', () => {
  const site = { loginMode: 'account', setupCompletedAt: 1, siteName: 'x' } as const
  const ev = (env: NodeJS.ProcessEnv, stateless = false, s: Parameters<typeof evaluateStart>[0]['site'] = {}) => evaluateStart({ env, stateless, site: s })

  it('stateless is direct and never needs setup', () => {
    expect(ev({}, true).state).toEqual({ kind: 'stateless' })
    expect(() => ev({ DBLOOM_LOGIN_MODE: 'account' }, true)).toThrow(StartRefusal)
  })
  it('a fresh stateful store is setup_pending, preselecting from .env', () => {
    expect(ev({}).state).toEqual({ kind: 'setup_pending', storeMode: 'stateful' })
    expect(ev({ DBLOOM_LOGIN_MODE: 'direct' }).state).toEqual({ kind: 'setup_pending', storeMode: 'stateful', preselectedMode: 'direct' })
  })
  it('DBLOOM_AUTO_SETUP=direct completes direct only', () => {
    expect(ev({ DBLOOM_AUTO_SETUP: 'direct' })).toEqual({ state: { kind: 'ready', mode: 'direct' }, autoSetup: true })
    expect(ev({ DBLOOM_AUTO_SETUP: 'direct', DBLOOM_LOGIN_MODE: 'direct' }).autoSetup).toBe(true)
    expect(() => ev({ DBLOOM_AUTO_SETUP: 'direct', DBLOOM_LOGIN_MODE: 'account' })).toThrow(StartRefusal)
    expect(() => ev({ DBLOOM_AUTO_SETUP: 'account' })).toThrow(StartRefusal)
  })
  it('refuses a mode mismatch naming both modes', () => {
    expect(() => ev({ DBLOOM_LOGIN_MODE: 'direct', ...GOOD_ENV }, false, site)).toThrow(/direct.*account/)
    expect(() => ev({ DBLOOM_LOGIN_MODE: 'sideways' })).toThrow(StartRefusal)
  })
  it('account mode needs an https or loopback origin and the server key', () => {
    expect(ev(GOOD_ENV, false, site).state).toEqual({ kind: 'ready', mode: 'account' })
    expect(() => ev({ DBLOOM_SECRET_KEY: KEY }, false, site)).toThrow(/PUBLIC_ORIGIN/)
    expect(() => ev({ DBLOOM_SECRET_KEY: KEY, DBLOOM_PUBLIC_ORIGIN: 'http://db.example.com' }, false, site)).toThrow(/PUBLIC_ORIGIN/)
    expect(ev({ DBLOOM_SECRET_KEY: KEY, DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com' }, false, site).state.kind).toBe('ready')
    expect(() => ev({ DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com' }, false, site)).toThrow(/server key/)
  })
  it('direct mode ignores account prerequisites', () => {
    expect(ev({}, false, { ...site, loginMode: 'direct' }).state).toEqual({ kind: 'ready', mode: 'direct' })
  })
})
