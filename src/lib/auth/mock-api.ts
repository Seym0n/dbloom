/**
 * In-memory stand-in for the auth server functions: every screen works without a backend (`VITE_DBLOOM_AUTH_MOCK=true`
 * or `?authMock=<scenario>`). State lives in this tab's session storage, so a reload keeps the sign-in and the wizard.
 *
 * Scenarios (`?authMock=`): `setup` (wizard, token MOCK_SETUP_TOKEN), `login` (account mode, users below), `direct`.
 * Users of `login`, all with password MOCK_PASSWORD: alice (full), bob (TOTP 123456, passkey, recovery code
 * MOCK_RECOVERY_CODE), carol (enrol only), dave (must change password), erin (throttled after two wrong passwords).
 */
import { createMockAuditApi } from './mock-audit'
import { createMockAssistantAdmin } from './mock-assistant-admin'
import { createMockExposureApi } from './mock-exposure'
import { createMockSettings } from './mock-settings'
import type { LoginMode, PrefImportProblem, SessionInfo, SessionState } from '~/server/auth/types'
import { clearMockConnections, createMockConnectionApi, mockOpenConnections } from './mock-connections'
import { MOCK_PREF_DEFAULTS, MOCK_USER_SCOPED, mockValid } from './mock-prefs'
import type {
  AuthApi,
  AuthBoot,
  FactorsInfo,
  GetPrefsResult,
  LoginPageInfo,
  SetupSaveStepInput,
  SignInOutcome,
  SetupStateResponse,
} from './api'

export const MOCK_SETUP_TOKEN = 'MOCK-SETUP-TOKEN'
export const MOCK_PASSWORD = 'correct horse battery'
export const MOCK_TOTP_CODE = '123456'
export const MOCK_RECOVERY_CODE = 'AAAA-BBBB-CCCC'
export const MOCK_INVITE_TOKEN = `inv-${'a'.repeat(39)}`
export const MOCK_RECOVERY_TOKEN = `rec-${'b'.repeat(39)}`
export const MOCK_THROTTLE_SECONDS = 4
export const MOCK_STATE_KEY = 'dbloom.authMock.state'
export const MOCK_SCENARIOS = ['setup', 'login', 'direct'] as const
export type MockScenario = (typeof MOCK_SCENARIOS)[number]

type MockUser = {
  username: string
  displayName: string
  role: 'admin' | 'user'
  password: string
  totp: boolean
  passkeys: number
  recovery: string[]
  mustChange: boolean
  enrolOnly: boolean
  disabled?: boolean
}

type MockState = {
  scenario: MockScenario
  pending: boolean
  mode: LoginMode
  verified: boolean
  draft: { loginMode?: LoginMode; adminUsername?: string; adminName?: string; adminPassword?: string; factor?: 'passkey' | 'totp'; codes?: string[]; totpStarted?: boolean }
  users: MockUser[]
  session: { username: string; state: SessionState; csrf: string; startedAt?: number } | null
  failures: Record<string, number>
  throttleUntil: Record<string, number>
}

const SITE_DEFAULTS = {
  siteName: 'DBLoom',
  mfaScope: 'roles' as const,
  mfaRoles: ['admin' as const],
  mfaGraceMs: 0,
  mfaFactors: ['passkey' as const, 'totp' as const],
  primaryCredentials: ['password' as const, 'passkey' as const],
  passwordMinLength: 12,
  breachedCheck: false,
  tempPasswordMs: 72 * 3_600_000,
  sessionsPerUser: 5,
  sessionsAtLimit: 'evict_oldest' as const,
  inviteLifetimeMs: 72 * 3_600_000,
  recoveryLinkLifetimeMs: 24 * 3_600_000,
  vaultPassphraseMin: 14,
  vaultAutoLockMs: 15 * 60_000,
  personalProfiles: true,
  allowEmptyTargetPassword: false,
  denyRootTarget: false,
  loginAutofocus: false,
}

const user = (username: string, extra: Partial<MockUser> = {}): MockUser => ({
  username,
  displayName: username[0]!.toUpperCase() + username.slice(1),
  role: 'user',
  password: MOCK_PASSWORD,
  totp: false,
  passkeys: 0,
  recovery: [],
  mustChange: false,
  enrolOnly: false,
  ...extra,
})

function freshState(scenario: MockScenario): MockState {
  return {
    scenario,
    pending: scenario === 'setup',
    mode: scenario === 'direct' ? 'direct' : 'account',
    verified: false,
    draft: {},
    users:
      scenario === 'login'
        ? [
            user('alice', { role: 'admin' }),
            user('bob', { totp: true, passkeys: 1, recovery: [MOCK_RECOVERY_CODE] }),
            user('carol', { enrolOnly: true }),
            user('dave', { mustChange: true }),
            user('erin'),
          ]
        : [],
    session: null,
    failures: {},
    throttleUntil: {},
  }
}

const fail = (code: string, extra: Record<string, unknown> = {}): never => {
  throw new Error(JSON.stringify({ code, ...extra }))
}
/** Setup functions answer with bare HTTP statuses; the mock throws the same. */
const setupFail = (status: 401 | 404 | 409): never => {
  throw new Response(null, { status })
}

const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 30))

const CREATION = {
  challenge: 'bW9jay1jaGFsbGVuZ2U',
  rp: { name: 'DBLoom', id: 'localhost' },
  user: { id: 'bW9jaw', name: 'mock', displayName: 'Mock' },
  pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
}
const REQUEST = { challenge: 'bW9jay1jaGFsbGVuZ2U', rpId: 'localhost' }

const totpSecret = () => ({
  uri: 'otpauth://totp/DBLoom:admin?secret=JBSWY3DPEHPK3PXP&issuer=DBLoom',
  secret: 'JBSW Y3DP EHPK 3PXP',
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="#000" d="M0 0h3v3H0zM5 0h3v3H5zM0 5h3v3H0zM4 4h1v1H4zM6 5h2v1H6zM5 7h2v1H5z"/></svg>',
})

function readScenario(): MockScenario {
  if (typeof window === 'undefined') return 'login'
  const fromUrl = new URLSearchParams(window.location.search).get('authMock')
  if ((MOCK_SCENARIOS as readonly string[]).includes(fromUrl ?? '')) return fromUrl as MockScenario
  try {
    const stored = window.sessionStorage.getItem('dbloom.authMock')
    if ((MOCK_SCENARIOS as readonly string[]).includes(stored ?? '')) return stored as MockScenario
  } catch {
    /* no storage: default scenario */
  }
  return import.meta.env.VITE_DBLOOM_AUTH_MOCK_SCENARIO === 'setup' ? 'setup' : 'login'
}

function load(scenario: MockScenario): MockState {
  try {
    const raw = window.sessionStorage.getItem(MOCK_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MockState
      if (parsed.scenario === scenario) return parsed
    }
  } catch {
    /* start fresh */
  }
  return freshState(scenario)
}

export function createMockAuthApi(initial?: MockScenario): AuthApi {
  const scenario = initial ?? readScenario()
  const state: MockState = typeof window === 'undefined' ? freshState(scenario) : load(scenario)
  const save = () => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem('dbloom.authMock', state.scenario)
      window.sessionStorage.setItem(MOCK_STATE_KEY, JSON.stringify(state))
    } catch {
      /* in-memory only */
    }
  }
  save()

  const current = () => {
    const s = state.session
    const u = s && state.users.find((x) => x.username === s.username)
    if (!s || !u) return fail('auth_failed')
    return { s, u: u as MockUser }
  }
  const outcome = (username: string, st: SessionState): SignInOutcome => {
    const csrf = `mock-csrf-${Math.random().toString(36).slice(2, 10)}`
    state.session = { username, state: st, csrf, startedAt: Date.now() }
    resetIdle()
    save()
    return { csrf, state: st }
  }
  const policy = (password: string, username: string) => {
    if (password.length < 12) fail('password_rejected', { reason: 'too_short' })
    if (username && password.toLowerCase().includes(username.toLowerCase())) fail('password_rejected', { reason: 'contains_username' })
    if (password === 'password1234') fail('password_rejected', { reason: 'breached' })
  }
  const stateAfterPassword = (u: MockUser): SessionState =>
    u.mustChange ? 'must_change' : u.totp || u.passkeys > 0 ? 'pending_mfa' : u.enrolOnly ? 'enrol_only' : 'full'
  const setupGuard = () => {
    if (!state.pending) setupFail(404)
    if (!state.verified) setupFail(401)
  }
  const codes = () => Array.from({ length: 10 }, (_, i) => `K${i}7Q-M2XA-9TB${i}`)

  // ---- account extras (account security and preferences): kept beside the main state, per user name
  type Owned = { user: Record<string, unknown>; targets: Record<string, Record<string, unknown>> }
  type Extras = {
    names: Record<string, string[]>
    sessions: Record<string, SessionInfo[]>
    prefs: Record<string, Owned>
    updatedAt: Record<string, number>
    stepUpUntil: number
  }
  const EXTRAS_KEY = 'dbloom.authMock.account'
  const readExtras = (): Extras => {
    try {
      const raw = window.sessionStorage.getItem(EXTRAS_KEY)
      if (raw) return JSON.parse(raw) as Extras
    } catch {
      /* start fresh */
    }
    return { names: {}, sessions: {}, prefs: {}, updatedAt: {}, stepUpUntil: 0 }
  }
  const writeExtras = (extras: Extras) => {
    try {
      window.sessionStorage.setItem(EXTRAS_KEY, JSON.stringify(extras))
    } catch {
      /* in-memory only */
    }
  }
  /** Flags a test sets in this tab's session storage (`dbloom.authMock.flags`): `stateless`, `prefs-fail`, `step-up-off`, `step-up-add`. */
  const flag = (name: string) => {
    try {
      return (window.sessionStorage.getItem('dbloom.authMock.flags') ?? '').split(',').includes(name)
    } catch {
      return false
    }
  }
  /**
   * Idle limit of the mock session, kept in this tab's session storage: set at the first read from
   * `dbloom.authMock.idleMs` (a test's short limit, default 30 minutes) and moved by `listConnections`, the call
   * "Stay signed in" uses. A new sign-in or sign-out starts over.
   */
  const IDLE_KEY = 'dbloom.authMock.idleUntil'
  const idleUntil = (): number => {
    try {
      const raw = window.sessionStorage.getItem(IDLE_KEY)
      if (raw) return Number(raw)
      const until = Date.now() + (Number(window.sessionStorage.getItem('dbloom.authMock.idleMs')) || 30 * 60_000)
      window.sessionStorage.setItem(IDLE_KEY, String(until))
      return until
    } catch {
      return Date.now() + 30 * 60_000
    }
  }
  const resetIdle = (touch = false) => {
    try {
      if (touch) window.sessionStorage.setItem(IDLE_KEY, String(Date.now() + 30 * 60_000))
      else window.sessionStorage.removeItem(IDLE_KEY)
    } catch {
      /* in-memory only */
    }
  }
  const owner = () => {
    if (!state.session) throw new Error('session_ended')
    return state.session.username
  }
  /** Factor changes need a step-up inside the window (FR-AUT-013); sign-in does not count. */
  const needStepUp = () => {
    if (flag('step-up-off') || readExtras().stepUpUntil > Date.now()) return
    fail('stepup_required')
  }
  const passkeyNames = (extras: Extras, u: MockUser) => {
    const names = (extras.names[u.username] ??= [])
    while (names.length < u.passkeys) names.push(`Passkey ${names.length + 1}`)
    names.length = u.passkeys
    return names
  }
  const sessionsOf = (extras: Extras, username: string): SessionInfo[] =>
    (extras.sessions[username] ??= [
      { ref: 'mock-session-current', clientHint: 'Chrome on Windows', address: '203.0.113.7', createdAt: Date.now() - 3_600_000, lastSeenAt: Date.now(), current: true },
      { ref: 'mock-session-phone', clientHint: 'Safari on iOS', address: '198.51.100.24', createdAt: Date.now() - 26 * 3_600_000, lastSeenAt: Date.now() - 2 * 3_600_000, current: false },
    ])
  const ownedPrefs = (extras: Extras, username: string): Owned => (extras.prefs[username] ??= { user: {}, targets: {} })
  const prefValues = (extras: Extras, username: string, targetKey?: string) => {
    const owned = ownedPrefs(extras, username)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(MOCK_PREF_DEFAULTS)) if (MOCK_USER_SCOPED.has(k) || targetKey !== undefined) out[k] = v
    Object.assign(out, owned.user)
    if (targetKey !== undefined) Object.assign(out, owned.targets[targetKey] ?? {})
    return out
  }

  const DISMISSED_KEY = 'dbloom.authMock.dismissed'
  const readDismissed = (): string[] => {
    try {
      return JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]
    } catch {
      return []
    }
  }
  const writeDismissed = (ids: string[]) => {
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(ids))
    } catch {
      /* in-memory only */
    }
  }

  const settingsMock = createMockSettings({ flag, wait, needStepUp, who: () => current().u.displayName || current().u.username, sessionStart: () => state.session?.startedAt ?? 0 })
  const loginInfo = (): LoginPageInfo => {
    const site = settingsMock.site()
    return { mode: state.mode, siteName: 'DBLoom', passwordEnabled: true, passkeyEnabled: true, autofocus: false, notice: site.notice, maintenance: site.maintenance }
  }

  const connectionApi = createMockConnectionApi({ fail, wait, flag, needStepUp, policy, state, makeUser: user, save })

  const api: AuthApi = {
    // ---- setup
    setupGetState: async (): Promise<SetupStateResponse> => {
      if (!state.pending) return setupFail(404)
      if (!state.verified) return wait({ pending: true })
      return wait({
        pending: true,
        draft: {
          step: 1,
          ...(state.draft.loginMode ? { loginMode: state.draft.loginMode } : {}),
          adminNetworkAcknowledged: false,
        },
        env: {
          storeMode: 'stateful',
          publicOrigin: 'https://dbloom.example.org',
          publicOriginMatchesBrowser: false,
          secretKeyPresent: true,
          adminNetworks: ['10.0.0.0/8'],
          browserAddress: '203.0.113.7',
          browserInAdminNetworks: false,
          importDir: '/data/import',
          uploadDir: null,
          tls: 'verify',
        },
        defaults: SITE_DEFAULTS,
      })
    },
    setupVerifyToken: async (token) => {
      if (!state.pending) return setupFail(404)
      const ok = token.replace(/\s|-/g, '').toUpperCase() === MOCK_SETUP_TOKEN.replace(/-/g, '')
      state.verified = ok
      save()
      return wait(ok ? { ok: true as const, csrf: 'mock-setup-csrf' } : { ok: false as const })
    },
    setupSaveStep: async (input: SetupSaveStepInput) => {
      setupGuard()
      if (input.step === 2) {
        state.draft.loginMode = input.loginMode
      } else if (input.step === 4) {
        policy(input.password, input.username)
        state.draft.adminUsername = input.username
        state.draft.adminName = input.displayName
        state.draft.adminPassword = input.password
      }
      save()
      return wait({
        step: input.step,
        ...(state.draft.loginMode ? { loginMode: state.draft.loginMode } : {}),
        ...(state.draft.adminUsername
          ? { admin: { username: state.draft.adminUsername, displayName: state.draft.adminName ?? '', passwordSet: true, ...(state.draft.factor ? { factor: state.draft.factor } : {}), codesSaved: false } }
          : {}),
        adminNetworkAcknowledged: false,
      })
    },
    setupPasskeyOptions: async () => {
      setupGuard()
      return wait(CREATION)
    },
    setupPasskeyVerify: async () => {
      setupGuard()
      state.draft.factor = 'passkey'
      const issued = state.draft.codes === undefined
      if (issued) state.draft.codes = codes()
      save()
      return wait({ ok: true as const, ...(issued ? { recoveryCodes: state.draft.codes } : {}) })
    },
    setupTotpStart: async () => {
      setupGuard()
      state.draft.totpStarted = true
      save()
      return wait(totpSecret())
    },
    setupTotpVerify: async (code) => {
      setupGuard()
      if (code.replace(/\s/g, '') !== MOCK_TOTP_CODE) return setupFail(409)
      state.draft.factor = 'totp'
      state.draft.codes = codes()
      save()
      return wait({ recoveryCodes: state.draft.codes })
    },
    setupComplete: async () => {
      setupGuard()
      state.pending = false
      state.mode = state.draft.loginMode ?? 'account'
      state.verified = false
      if (state.mode === 'account' && state.draft.adminUsername) {
        state.users.push(
          user(state.draft.adminUsername, {
            role: 'admin',
            password: state.draft.adminPassword ?? MOCK_PASSWORD,
            displayName: state.draft.adminName ?? '',
            totp: state.draft.factor === 'totp',
            passkeys: state.draft.factor === 'passkey' ? 1 : 0,
            recovery: state.draft.codes ?? [],
          }),
        )
      }
      save()
      return wait({ ok: true as const })
    },

    // ---- sign-in
    getAuthBoot: async (): Promise<AuthBoot> => {
      if (state.pending) return { kind: 'setup_pending' }
      if (state.mode === 'direct') return { kind: 'direct', session: null }
      const s = state.session
      return {
        kind: 'account',
        info: loginInfo(),
        session: s
          ? {
              mode: 'account',
              csrf: s.csrf,
              state: s.state,
              user: (() => {
                const u = state.users.find((x) => x.username === s.username)!
                return { id: `mock-${u.username}`, username: u.username, displayName: u.displayName, role: u.role, securityVersion: 0 }
              })(),
              connections: mockOpenConnections(),
              idleExpiresAt: idleUntil(),
              absoluteExpiresAt: Date.now() + 12 * 3_600_000,
              stepUpUntil: null,
              maintenance: settingsMock.site().maintenance,
              ...(s.state === 'full' ? { targetTls: flag('target-tls-off') ? ('off' as const) : ('verify' as const) } : {}),
              ...(s.state === 'full' && settingsMock.site().banner ? { banner: settingsMock.site().banner } : {}),
            }
          : null,
      }
    },
    getLoginPageInfo: async () => wait(loginInfo()),
    passwordSignIn: async ({ username, password }) => {
      const key = username.toLowerCase()
      const until = state.throttleUntil[key] ?? 0
      if (until > Date.now()) return fail('auth_throttled', { retryAfterSeconds: Math.ceil((until - Date.now()) / 1000) })
      const u = state.users.find((x) => x.username.toLowerCase() === key)
      if (!u || u.password !== password) {
        state.failures[key] = (state.failures[key] ?? 0) + 1
        if (state.failures[key]! >= 2 && key === 'erin') {
          state.throttleUntil[key] = Date.now() + MOCK_THROTTLE_SECONDS * 1000
          state.failures[key] = 0
          save()
          return fail('auth_throttled', { retryAfterSeconds: MOCK_THROTTLE_SECONDS })
        }
        save()
        return fail('auth_failed')
      }
      state.failures[key] = 0
      // Maintenance mode (ST-218): refused after the password proved the user; administrators pass.
      if (settingsMock.site().maintenance.active && u.role !== 'admin') return fail('maintenance')
      return wait(outcome(u.username, stateAfterPassword(u)))
    },
    mfaOptions: async (method) => {
      current()
      return wait(method === 'passkey' ? REQUEST : { method })
    },
    mfaVerify: async (input) => {
      const { s, u } = current()
      if (s.state !== 'pending_mfa') return fail('mfa_failed')
      const ok =
        input.method === 'totp'
          ? input.code.replace(/\s/g, '') === MOCK_TOTP_CODE
          : input.method === 'recovery'
            ? u.recovery.includes(input.code.replace(/[\s-]/g, '').toUpperCase().replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'))
            : true
      if (!ok) return fail('mfa_failed')
      if (input.method === 'recovery') {
        u.recovery = u.recovery.filter((c) => c !== input.code.replace(/[\s-]/g, '').toUpperCase().replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'))
      }
      return wait(outcome(u.username, 'full'))
    },
    passkeyBegin: async () => wait({ options: REQUEST }),
    passkeyFinish: async () => {
      const u = state.users.find((x) => x.passkeys > 0)
      if (!u) return fail('mfa_failed')
      return wait(outcome(u.username, 'full'))
    },
    signOut: async () => {
      state.session = null
      resetIdle()
      clearMockConnections()
      save()
      return wait({ ok: true as const })
    },
    stepUpOptions: async (method) => wait(method === 'passkey' ? REQUEST : { method }),
    stepUpVerify: async (input) => {
      const { u } = current()
      const ok = input.method === 'totp' ? input.code.replace(/\s/g, '') === MOCK_TOTP_CODE : input.method === 'password' ? input.password === u.password : true
      if (!ok) return fail(input.method === 'password' ? 'auth_failed' : 'mfa_failed')
      const extras = readExtras()
      extras.stepUpUntil = Date.now() + 5 * 60_000
      writeExtras(extras)
      return wait({ stepUpUntil: extras.stepUpUntil })
    },

    // ---- account security
    changePassword: async ({ currentPassword, newPassword }) => {
      const { s, u } = current()
      if (u.password !== currentPassword) return fail('auth_failed')
      policy(newPassword, u.username)
      if (newPassword === currentPassword) fail('password_rejected', { reason: 'reused' })
      u.password = newPassword
      u.mustChange = false
      const next = u.totp || u.passkeys > 0 ? 'full' : u.enrolOnly ? 'enrol_only' : 'full'
      const result = outcome(s.username, next)
      return wait(result)
    },
    listFactors: async (): Promise<FactorsInfo> => {
      const { u } = current()
      const names = passkeyNames(readExtras(), u)
      return wait({
        passkeys: Array.from({ length: u.passkeys }, (_, i) => ({ id: `mock-pk-${i}`, name: names[i] ?? `Passkey ${i + 1}`, backedUp: true, uvInitial: true, createdAt: Date.now() - (i + 1) * 86_400_000, lastUsedAt: i === 0 ? Date.now() - 3_600_000 : null })),
        totp: u.totp,
        recoveryCodes: u.recovery.length,
      })
    },
    passkeyRegisterOptions: async () => wait(CREATION),
    passkeyRegisterVerify: async () => {
      const { s, u } = current()
      if (flag('step-up-add')) needStepUp()
      u.passkeys += 1
      const firstFactor = u.recovery.length === 0
      if (firstFactor) u.recovery = codes()
      if (s.state === 'enrol_only') s.state = 'full'
      save()
      return wait(firstFactor ? { recoveryCodes: u.recovery } : {})
    },
    passkeyRename: async (id, name) => {
      const { u } = current()
      const extras = readExtras()
      const names = passkeyNames(extras, u)
      const i = Number(id.replace('mock-pk-', ''))
      if (!Number.isInteger(i) || i < 0 || i >= names.length) return fail('auth_failed')
      names[i] = name
      writeExtras(extras)
      return wait({ ok: true as const })
    },
    passkeyRemove: async (id) => {
      const { u } = current()
      needStepUp()
      // A required second factor cannot be removed last (FR-AUT-012).
      if (u.role === 'admin' && u.passkeys + (u.totp ? 1 : 0) <= 1) return fail('enrol_required')
      const extras = readExtras()
      const names = passkeyNames(extras, u)
      const i = Number(id.replace('mock-pk-', ''))
      if (Number.isInteger(i) && i >= 0 && i < names.length) names.splice(i, 1)
      u.passkeys = Math.max(0, u.passkeys - 1)
      writeExtras(extras)
      save()
      return wait({ ok: true as const })
    },
    totpStart: async () => {
      if (current().u.totp) needStepUp()
      return wait(totpSecret())
    },
    totpConfirm: async (code) => {
      const { s, u } = current()
      if (code.replace(/\s/g, '') !== MOCK_TOTP_CODE) return fail('mfa_failed')
      u.totp = true
      const firstFactor = u.recovery.length === 0
      if (firstFactor) u.recovery = codes()
      if (s.state === 'enrol_only') s.state = 'full'
      save()
      return wait(firstFactor ? { recoveryCodes: u.recovery } : {})
    },
    totpRemove: async () => {
      const { u } = current()
      needStepUp()
      if (u.role === 'admin' && u.passkeys + (u.totp ? 1 : 0) <= 1) return fail('enrol_required')
      u.totp = false
      save()
      return wait({ ok: true as const })
    },
    recoveryCodesRegenerate: async () => {
      const { u } = current()
      needStepUp()
      u.recovery = codes()
      save()
      return wait({ recoveryCodes: u.recovery })
    },
    disableMfa: async () => {
      const { u } = current()
      needStepUp()
      if (u.role === 'admin') return fail('enrol_required')
      u.totp = false
      u.passkeys = 0
      u.recovery = []
      save()
      return wait({ ok: true as const })
    },
    listSessions: async () => wait(sessionsOf(readExtras(), owner())),
    revokeSession: async (ref) => {
      const extras = readExtras()
      const list = sessionsOf(extras, owner())
      const target = list.find((x) => x.ref === ref)
      if (!target || target.current) return fail('auth_failed')
      extras.sessions[owner()] = list.filter((x) => x.ref !== ref)
      writeExtras(extras)
      return wait({ ok: true as const })
    },
    listNotices: async () => {
      const u = current().u
      const now = Date.now()
      const dismissed = readDismissed()
      const mine = [
        { id: 'mock-notice-1', userId: `mock-${u.username}`, kind: 'password_changed' as const, createdAt: now - 2 * 86_400_000 },
        { id: 'mock-notice-2', userId: `mock-${u.username}`, kind: 'session_evicted' as const, createdAt: now - 3_600_000 },
        ...(u.role === 'admin'
          ? [
              { id: 'mock-notice-burst', userId: `mock-${u.username}`, kind: 'failed_burst' as const, createdAt: now - 1_800_000, detail: 'account bob: 10 failed sign-in steps in 10 min' },
              { id: 'mock-notice-location', userId: `mock-${u.username}`, kind: 'new_location' as const, createdAt: now - 7_200_000, detail: 'account bob from 198.51.100.0' },
            ]
          : []),
      ]
      return wait(mine.map((n) => ({ ...n, readAt: dismissed.includes(n.id) ? now : null })))
    },
    dismissNotice: async (id) => {
      current()
      const dismissed = readDismissed()
      if (!dismissed.includes(id)) writeDismissed([...dismissed, id])
      return wait({ ok: true as const })
    },

    // ---- users, invites and recovery links, connections, vault and profiles: mock-connections.ts
    ...connectionApi,
    ...createMockAuditApi({ flag, wait, needStepUp, username: owner }),
    ...createMockExposureApi({ flag, wait, who: () => current().u.displayName || current().u.username }),
    ...settingsMock.api,
    ...createMockAssistantAdmin({ flag, wait, needStepUp, who: () => current().u.displayName || current().u.username }),
    listConnections: async () => {
      resetIdle(true)
      return connectionApi.listConnections()
    },

    invitePasskeyOptions: async ({ token }) => {
      if (token !== MOCK_INVITE_TOKEN) return fail('invite_invalid')
      return wait(CREATION)
    },
    redeemInvite: async ({ token, username, displayName, credential }) => {
      if (token !== MOCK_INVITE_TOKEN) return fail('invite_invalid')
      if (credential.kind === 'password') policy(credential.password, username)
      if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return fail('invite_invalid')
      state.users.push(
        user(username, {
          displayName: displayName || username,
          ...(credential.kind === 'passkey' ? { passkeys: 1 } : { password: credential.password }),
        }),
      )
      save()
      return wait({ userId: `mock-${username}` })
    },
    recoveryPasskeyOptions: async (token) => {
      if (token !== MOCK_RECOVERY_TOKEN) return fail('recovery_invalid')
      return wait(CREATION)
    },
    redeemRecovery: async ({ token, credential }) => {
      if (token !== MOCK_RECOVERY_TOKEN) return fail('recovery_invalid')
      if (credential.kind === 'password') policy(credential.password, 'alice')
      return wait({ userId: 'mock-alice' })
    },

    // ---- preferences
    getPrefs: async (targetKey): Promise<GetPrefsResult> => {
      const extras = readExtras()
      const who = owner()
      return wait({ values: prefValues(extras, who, targetKey), updatedAt: extras.updatedAt[who] ?? null, stateless: flag('stateless') })
    },
    setPref: async (key, value, targetKey) => {
      const who = owner()
      if (flag('prefs-fail')) throw new Error('save-failed: Preferences could not be saved')
      if (!(key in MOCK_PREF_DEFAULTS) || !mockValid(key, value)) throw new Error('invalid-value: Invalid value')
      const extras = readExtras()
      const owned = ownedPrefs(extras, who)
      if (MOCK_USER_SCOPED.has(key)) owned.user[key] = value
      else if (targetKey === undefined) throw new Error('target-required: This preference belongs to one target')
      else (owned.targets[targetKey] ??= {})[key] = value
      extras.updatedAt[who] = Date.now()
      writeExtras(extras)
      return wait({ ok: true as const, updatedAt: extras.updatedAt[who]! })
    },
    exportPrefs: async () => {
      const extras = readExtras()
      const owned = ownedPrefs(extras, owner())
      return wait({
        fileName: 'dbloom-preferences.json',
        json: JSON.stringify({ dbloomPreferences: 1, exportedAt: new Date().toISOString(), user: owned.user, targets: owned.targets }, null, 2),
      })
    },
    importPrefs: async ({ json, mode = 'merge', validOnly = false }) => {
      const who = owner()
      const bad = (reason: string): { written: number; skipped: number; problems: PrefImportProblem[] } => ({ written: 0, skipped: 0, problems: [{ key: '', reason }] })
      if (json.length > 256 * 1024) return wait(bad('file_too_large'))
      let file: { dbloomPreferences?: unknown; user?: Record<string, unknown>; targets?: Record<string, Record<string, unknown>> }
      try {
        file = JSON.parse(json)
      } catch {
        return wait(bad('invalid_file'))
      }
      if (file.dbloomPreferences !== 1 || typeof file.user !== 'object' || file.user === null || typeof file.targets !== 'object' || file.targets === null) return wait(bad('invalid_file'))
      const problems: PrefImportProblem[] = []
      const good: { key: string; target?: string; value: unknown }[] = []
      const consider = (key: string, value: unknown, target?: string) => {
        const problem = (reason: string) => problems.push(target === undefined ? { key, reason } : { key, target, reason })
        if (!(key in MOCK_PREF_DEFAULTS)) return problem('unknown_key')
        if (MOCK_USER_SCOPED.has(key) !== (target === undefined)) return problem('wrong_section')
        if (!mockValid(key, value)) return problem('invalid_value')
        good.push({ key, value, ...(target === undefined ? {} : { target }) })
      }
      for (const [k, v] of Object.entries(file.user)) consider(k, v)
      for (const [target, values] of Object.entries(file.targets)) for (const [k, v] of Object.entries(values)) consider(k, v, target)
      const total = good.length + problems.length
      if (problems.length > 0 && !validOnly) return wait({ written: 0, skipped: total, problems })
      const extras = readExtras()
      const owned = ownedPrefs(extras, who)
      if (mode === 'replace') {
        owned.user = {}
        owned.targets = {}
      }
      for (const g of good) {
        if (g.target === undefined) owned.user[g.key] = g.value
        else (owned.targets[g.target] ??= {})[g.key] = g.value
      }
      extras.updatedAt[who] = Date.now()
      writeExtras(extras)
      return wait({ written: good.length, skipped: total - good.length, problems })
    },
    resetPrefs: async () => {
      const extras = readExtras()
      extras.prefs[owner()] = { user: {}, targets: {} }
      delete extras.updatedAt[owner()]
      writeExtras(extras)
      return wait({ ok: true as const })
    },
  }
  return api
}
