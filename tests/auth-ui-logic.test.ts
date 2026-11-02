import { describe, expect, it } from 'vitest'
import { authErrorKey, parseAuthError } from '../src/lib/auth/errors'
import { parseFragmentToken } from '../src/lib/auth/fragment'
import { scorePassword } from '../src/lib/auth/password-strength'
import { secondsLeft } from '../src/lib/auth/countdown'
import { validateSite } from '../src/lib/auth/setup-site'
import { adminComplete, applicableSteps, daysToMs, hoursToMs, msToDays, msToHours, nextStep, previousStep, stepNumber } from '../src/lib/auth/setup-steps'
import { createMockAuthApi, MOCK_PASSWORD, MOCK_RECOVERY_CODE, MOCK_SETUP_TOKEN, MOCK_TOTP_CODE } from '../src/lib/auth/mock-api'
import { t, tDynamic } from '../src/i18n'
import { AUTH_ERROR_CODES, PASSWORD_REJECT_REASONS, TARGET_POLICY_REASONS } from '../src/server/auth/types'
import authSetup from '../src/i18n/auth-setup.json'
import authSignin from '../src/i18n/auth-signin.json'

describe('error transport', () => {
  it('reads a JSON body', () => {
    const body = JSON.stringify({ code: 'auth_throttled', retryAfterSeconds: 12 })
    expect(parseAuthError(new Error(body))).toEqual({ code: 'auth_throttled', retryAfterSeconds: 12 })
    expect(parseAuthError(new Error(JSON.stringify({ code: 'password_rejected', reason: 'breached' })))).toEqual({ code: 'password_rejected', reason: 'breached' })
    expect(parseAuthError(new Error(JSON.stringify({ code: 'profile_test_failed', targetMessage: 'x' })))).toEqual({ code: 'profile_test_failed', targetMessage: 'x' })
  })

  it('falls back to the plain code and to auth_throttled:<seconds>', () => {
    expect(parseAuthError(new Error('auth_failed'))).toEqual({ code: 'auth_failed' })
    expect(parseAuthError(new Error('auth_throttled:30'))).toEqual({ code: 'auth_throttled', retryAfterSeconds: 30 })
    expect(parseAuthError(new Error('mfa_expired'))).toEqual({ code: 'mfa_expired' })
  })

  it('maps setup responses and the ended session', () => {
    expect(parseAuthError(new Response(null, { status: 404 })).code).toBe('gone')
    expect(parseAuthError(new Response(null, { status: 401 })).code).toBe('setup_session')
    expect(parseAuthError(new Response('x', { status: 409 })).code).toBe('setup_step')
    expect(parseAuthError(new Error('session_ended')).code).toBe('session_ended')
  })

  it('never throws and drops unknown codes, reasons and bad numbers', () => {
    expect(parseAuthError(undefined).code).toBe('unknown')
    expect(parseAuthError(new Error('{not json')).code).toBe('unknown')
    expect(parseAuthError(new Error(JSON.stringify({ code: 'made_up' }))).code).toBe('unknown')
    expect(parseAuthError(new Error(JSON.stringify({ code: 'password_rejected', reason: 'zzz' })))).toEqual({ code: 'password_rejected' })
    expect(parseAuthError(new Error(JSON.stringify({ code: 'auth_throttled', retryAfterSeconds: -4 })))).toEqual({ code: 'auth_throttled' })
  })

  it('every code, reason and transport class has a message', () => {
    for (const code of AUTH_ERROR_CODES) expect(authSignin[`auth.error.${code}` as keyof typeof authSignin], code).toBeTruthy()
    for (const r of PASSWORD_REJECT_REASONS) expect(authSignin[`auth.error.password_rejected.${r}` as keyof typeof authSignin], r).toBeTruthy()
    for (const r of TARGET_POLICY_REASONS) expect(authSignin[`auth.error.target_policy.${r}` as keyof typeof authSignin], r).toBeTruthy()
    for (const c of ['session_ended', 'gone', 'setup_session', 'setup_step', 'totp_invalid', 'unknown']) expect(authSignin[`auth.error.${c}` as keyof typeof authSignin], c).toBeTruthy()
    expect(authErrorKey({ code: 'password_rejected', reason: 'reused' })).toBe('auth.error.password_rejected.reused')
    expect(authErrorKey({ code: 'auth_failed' })).toBe('auth.error.auth_failed')
  })

  it('the failed sign-in text is one fixed sentence', () => {
    expect(t('auth.error.auth_failed')).toBe('Sign-in failed. Check the user name and password.')
    expect(tDynamic('auth.error.nothing', 'auth.error.unknown')).toBe(t('auth.error.unknown'))
  })
})

describe('namespace catalogues', () => {
  it('do not overlap', () => {
    const a = Object.keys(authSetup)
    const b = new Set(Object.keys(authSignin))
    expect(a.filter((k) => b.has(k))).toEqual([])
  })
})

describe('fragment token', () => {
  const token = 'A'.repeat(43)
  it('accepts a bare or named token', () => {
    expect(parseFragmentToken(`#${token}`)).toBe(token)
    expect(parseFragmentToken(`#token=${token}`)).toBe(token)
  })
  it('refuses anything else', () => {
    expect(parseFragmentToken('')).toBeUndefined()
    expect(parseFragmentToken('#short')).toBeUndefined()
    expect(parseFragmentToken(`#${token}x`)).toBeUndefined()
    expect(parseFragmentToken(`#${'!'.repeat(43)}`)).toBeUndefined()
  })
})

describe('password strength', () => {
  it('too short is level 0 whatever the content', () => {
    expect(scorePassword('Xk9$mQ2', { minLength: 12 })).toMatchObject({ score: 0, level: 'tooShort', tooShort: true })
    expect(scorePassword('', { minLength: 12 }).tooShort).toBe(true)
  })
  it('rises with length and variety', () => {
    const weak = scorePassword('aaaaaaaaaaaa', { minLength: 12 })
    const fair = scorePassword('correcthorse', { minLength: 12 })
    const strong = scorePassword('correct horse battery staple 42!', { minLength: 12 })
    expect(weak.score).toBeLessThan(strong.score)
    expect(fair.score).toBeLessThanOrEqual(strong.score)
    expect(strong.score).toBe(4)
  })
  it('flags and lowers a password containing the user name', () => {
    const plain = scorePassword('horse battery staple', { minLength: 12 })
    const named = scorePassword('horse battery staple', { minLength: 12, username: 'Battery' })
    expect(named.containsUsername).toBe(true)
    expect(named.score).toBeLessThanOrEqual(plain.score)
  })
  it('counts characters, not UTF-16 units', () => {
    expect(scorePassword('😀😀😀😀😀😀😀😀😀😀😀😀', { minLength: 12 }).tooShort).toBe(false)
  })
  it('penalises runs and common words', () => {
    expect(scorePassword('abcdefghijkl', { minLength: 12 }).score).toBeLessThan(scorePassword('qzvhwtmbxkpa', { minLength: 12 }).score)
    expect(scorePassword('password12345', { minLength: 12 }).score).toBeLessThan(3)
  })
})

describe('setup steps', () => {
  it('direct mode skips the administrator step', () => {
    expect(applicableSteps('account')).toEqual(['welcome', 'mode', 'site', 'admin', 'done'])
    expect(applicableSteps('direct')).toEqual(['welcome', 'mode', 'site', 'done'])
  })
  it('moves forward and back inside the list', () => {
    expect(nextStep('site', 'account')).toBe('admin')
    expect(nextStep('site', 'direct')).toBe('done')
    expect(nextStep('done', 'account')).toBe('done')
    expect(previousStep('done', 'direct')).toBe('site')
    expect(previousStep('welcome', 'account')).toBe('welcome')
    expect(stepNumber('admin')).toBe(4)
  })
  it('the administrator step finishes only with a password, a factor and saved codes', () => {
    expect(adminComplete({ passwordSet: true, hasFactor: false, codesPending: false, codesSaved: false })).toBe(false)
    expect(adminComplete({ passwordSet: true, hasFactor: true, codesPending: true, codesSaved: false })).toBe(false)
    expect(adminComplete({ passwordSet: true, hasFactor: true, codesPending: true, codesSaved: true })).toBe(true)
    expect(adminComplete({ passwordSet: true, hasFactor: true, codesPending: false, codesSaved: false })).toBe(true)
    expect(adminComplete({ passwordSet: false, hasFactor: true, codesPending: false, codesSaved: false })).toBe(false)
  })
  it('converts units both ways', () => {
    expect(hoursToMs(msToHours(72 * 3_600_000))).toBe(72 * 3_600_000)
    expect(daysToMs(msToDays(3 * 86_400_000))).toBe(3 * 86_400_000)
    expect(msToHours(5_400_000)).toBe(1.5)
  })
})

describe('site values', () => {
  const ok = {
    siteName: 'DBLoom',
    mfaScope: 'roles' as const,
    mfaRoles: ['admin' as const],
    mfaGraceMs: 0,
    mfaFactors: ['totp' as const],
    primaryCredentials: ['password' as const],
    passwordMinLength: 12,
    breachedCheck: false,
    tempPasswordMs: 3_600_000,
    sessionsPerUser: 5,
    sessionsAtLimit: 'evict_oldest' as const,
    inviteLifetimeMs: 3_600_000,
    recoveryLinkLifetimeMs: 3_600_000,
    vaultPassphraseMin: 14,
    vaultAutoLockMs: 60_000,
    personalProfiles: true,
    allowEmptyTargetPassword: false,
    denyRootTarget: false,
    loginAutofocus: false,
  }
  it('accepts the defaults', () => expect(validateSite(ok, 'account')).toEqual({}))
  it('flags empty names, empty lists and out-of-range numbers', () => {
    expect(validateSite({ ...ok, siteName: '  ' }, 'account').siteName).toBe('required')
    expect(validateSite({ ...ok, mfaFactors: [] }, 'account').mfaFactors).toBe('pick')
    expect(validateSite({ ...ok, mfaScope: 'roles', mfaRoles: [] }, 'account').mfaRoles).toBe('pick')
    expect(validateSite({ ...ok, passwordMinLength: 9 }, 'account').passwordMinLength).toBe('range')
    expect(validateSite({ ...ok, sessionsPerUser: Number.NaN }, 'account').sessionsPerUser).toBe('range')
  })
  it('direct mode checks only the site name', () => {
    expect(validateSite({ ...ok, mfaFactors: [], passwordMinLength: 1 }, 'direct')).toEqual({})
  })
})

describe('countdown', () => {
  it('rounds up and stops at zero', () => {
    expect(secondsLeft(null, 5)).toBe(0)
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(14_000, 10_000)).toBe(4)
    expect(secondsLeft(9_000, 10_000)).toBe(0)
  })
})

describe('mock layer', () => {
  it('walks the setup, refuses a wrong token and a missing session', async () => {
    const api = createMockAuthApi('setup')
    await expect(api.setupSaveStep({ step: 2, loginMode: 'account' })).rejects.toBeInstanceOf(Response)
    expect(await api.setupVerifyToken('nope')).toEqual({ ok: false })
    expect((await api.setupVerifyToken(MOCK_SETUP_TOKEN)).ok).toBe(true)
    const state = await api.setupGetState()
    expect('env' in state).toBe(true)
    await expect(api.setupTotpVerify('000000')).rejects.toBeInstanceOf(Response)
    expect((await api.setupTotpVerify(MOCK_TOTP_CODE)).recoveryCodes).toHaveLength(10)
  })

  it('answers every sign-in state and one failure for unknown and wrong', async () => {
    const api = createMockAuthApi('login')
    const failed = async (u: string, p: string) => parseAuthError(await api.passwordSignIn({ username: u, password: p }).catch((e) => e)).code
    expect(await failed('alice', 'wrong')).toBe('auth_failed')
    expect(await failed('nobody', MOCK_PASSWORD)).toBe('auth_failed')
    expect((await api.passwordSignIn({ username: 'alice', password: MOCK_PASSWORD })).state).toBe('full')
    expect((await api.passwordSignIn({ username: 'bob', password: MOCK_PASSWORD })).state).toBe('pending_mfa')
    expect((await api.passwordSignIn({ username: 'carol', password: MOCK_PASSWORD })).state).toBe('enrol_only')
    expect((await api.passwordSignIn({ username: 'dave', password: MOCK_PASSWORD })).state).toBe('must_change')
  })

  it('a recovery code works once', async () => {
    const api = createMockAuthApi('login')
    await api.passwordSignIn({ username: 'bob', password: MOCK_PASSWORD })
    expect((await api.mfaVerify({ method: 'recovery', code: MOCK_RECOVERY_CODE.toLowerCase() })).state).toBe('full')
    await api.signOut()
    await api.passwordSignIn({ username: 'bob', password: MOCK_PASSWORD })
    await expect(api.mfaVerify({ method: 'recovery', code: MOCK_RECOVERY_CODE })).rejects.toThrow('mfa_failed')
  })

  it('throttles with a wait time', async () => {
    const api = createMockAuthApi('login')
    await api.passwordSignIn({ username: 'erin', password: 'a' }).catch(() => undefined)
    await api.passwordSignIn({ username: 'erin', password: 'b' }).catch(() => undefined)
    const error = parseAuthError(await api.passwordSignIn({ username: 'erin', password: MOCK_PASSWORD }).catch((e) => e))
    expect(error.code).toBe('auth_throttled')
    expect(error.retryAfterSeconds).toBeGreaterThan(0)
  })
})
