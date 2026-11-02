/** Package C: WebAuthn service (FR-AUT-009, SEC-TGT-011/014, ST-060 to 062) against recorded fixtures and a software authenticator.
 *
 * `tests/fixtures/auth/webauthn.json` holds registration and assertion responses recorded from the software
 * authenticator of `auth-authenticator.ts` (ES256, `none` attestation); `RECORD_WEBAUTHN_FIXTURES=1 npx vitest run
 * tests/auth-webauthn.test.ts` rewrites it. The browser-driven check (virtual authenticator) is in `e2e/auth-signin.spec.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChallengeStore } from '~/server/auth/challenges'
import { createWebAuthnService } from '~/server/auth/webauthn'
import { AuthError, type AuthenticationResponseJSON, type PasskeyRecord, type RegistrationResponseJSON } from '~/server/auth/types'
import { SoftAuthenticator } from './auth-authenticator'

const FIXTURE = join(__dirname, 'fixtures', 'auth', 'webauthn.json')
const RP = { rpId: 'dbloom.test', origin: 'https://dbloom.test' }

type Recorded = {
  rp: typeof RP
  verifying: {
    registration: { challenge: string; response: RegistrationResponseJSON }
    assertions: Record<'counter0' | 'counter5' | 'counter3' | 'counter5again' | 'wrongOrigin', { challenge: string; response: AuthenticationResponseJSON }>
  }
  nonVerifying: { registration: { challenge: string; response: RegistrationResponseJSON }; assertion: { challenge: string; response: AuthenticationResponseJSON } }
}

const challenge = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

if (process.env.RECORD_WEBAUTHN_FIXTURES === '1') {
  ;(() => {
    const a = new SoftAuthenticator({ ...RP })
    const b = new SoftAuthenticator({ ...RP, userVerified: false })
    const rec = (c = challenge()) => c
    const reg = rec()
    const out: Recorded = {
      rp: RP,
      verifying: {
        registration: { challenge: reg, response: a.register(reg) },
        assertions: {} as Recorded['verifying']['assertions'],
      },
      nonVerifying: undefined as never,
    }
    const add = (name: keyof Recorded['verifying']['assertions'], opts: Parameters<SoftAuthenticator['assert']>[1]) => {
      const c = rec()
      out.verifying.assertions[name] = { challenge: c, response: a.assert(c, opts) }
    }
    add('counter0', { counter: 0 })
    add('counter5', { counter: 5 })
    add('counter3', { counter: 3 })
    add('counter5again', { counter: 5 })
    add('wrongOrigin', { counter: 9, origin: 'https://evil.test' })
    const rb = rec()
    const ab = rec()
    out.nonVerifying = { registration: { challenge: rb, response: b.register(rb) }, assertion: { challenge: ab, response: b.assert(ab, { counter: 1 }) } }
    writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + '\n')
  })()
}

const fixture: Recorded = JSON.parse(readFileSync(FIXTURE, 'utf8'))

function setup() {
  const audit = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const challenges = createChallengeStore()
  const service = createWebAuthnService({ challenges, relyingParty: () => ({ ...RP, rpName: 'DBLoom' }) })
  return { challenges, service, audit }
}

const auditLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]))
const expectFailed = async (p: Promise<unknown>) => {
  const error = await p.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(AuthError)
  expect((error as AuthError).code).toBe('mfa_failed')
  // No library text crosses the boundary (SEC-TGT-153).
  expect((error as AuthError).message).toBe('mfa_failed')
}

describe('recorded WebAuthn fixtures', () => {
  beforeEach(() => vi.restoreAllMocks())

  async function registered(s = setup()) {
    const { challenges, service } = s
    challenges.create('o1', 'enrol_passkey', { challenge: fixture.verifying.registration.challenge })
    const info = await service.verifyRegistration('o1', 'enrol_passkey', fixture.verifying.registration.response, { requireUserVerification: true })
    const record: PasskeyRecord = { ...info, userId: 'u1', name: 'k', createdAt: 0, lastUsedAt: null }
    return { ...s, record }
  }

  it('verifies the recorded registration and reports user verification', async () => {
    const { record } = await registered()
    expect(record.counter).toBe(0)
    expect(record.uvInitial).toBe(true)
    expect(record.id).toBe(fixture.verifying.registration.response.id)
  })

  it('accepts counter 0 on 0, then an increase, and refuses a lowered or repeated counter (ST-062)', async () => {
    const { challenges, service, record, audit } = await registered()
    const run = (name: keyof Recorded['verifying']['assertions'], rec: PasskeyRecord) => {
      const a = fixture.verifying.assertions[name]
      challenges.create('s1', 'mfa', { challenge: a.challenge })
      return service.verifyAuthentication('s1', 'mfa', a.response, rec, { requireUserVerification: true })
    }
    expect((await run('counter0', record)).newCounter).toBe(0)
    const afterFive = { ...record, counter: (await run('counter5', record)).newCounter }
    expect(afterFive.counter).toBe(5)
    await expectFailed(run('counter3', afterFive))
    await expectFailed(run('counter5again', afterFive))
    expect(auditLines(audit).filter((l) => l.includes('webauthn.counter'))).toHaveLength(2)
  })

  it('refuses a response from another origin', async () => {
    const { challenges, service, record } = await registered()
    const a = fixture.verifying.assertions.wrongOrigin
    challenges.create('s1', 'mfa', { challenge: a.challenge })
    await expectFailed(service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true }))
  })

  it('refuses a replay: the challenge is single use, also after success', async () => {
    const { challenges, service, record } = await registered()
    const a = fixture.verifying.assertions.counter5
    challenges.create('s1', 'mfa', { challenge: a.challenge })
    await service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true })
    await expectFailed(service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true }))
  })

  it('refuses a response without a held challenge, for another purpose or another owner', async () => {
    const { challenges, service, record } = await registered()
    const a = fixture.verifying.assertions.counter5
    await expectFailed(service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true }))
    challenges.create('s1', 'stepup', { challenge: a.challenge })
    await expectFailed(service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true }))
    challenges.create('s1', 'mfa', { challenge: a.challenge })
    await expectFailed(service.verifyAuthentication('s2', 'mfa', a.response, record, { requireUserVerification: true }))
  })

  it('refuses a challenge of another user and a wrong challenge', async () => {
    const { challenges, service, record } = await registered()
    const a = fixture.verifying.assertions.counter5
    challenges.create('s1', 'mfa', { challenge: a.challenge, userId: 'someone-else' })
    await expectFailed(service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true }))
    challenges.create('s1', 'mfa', { challenge: challenge() })
    await expectFailed(service.verifyAuthentication('s1', 'mfa', a.response, record, { requireUserVerification: true }))
  })

  it('refuses a tampered signature (verified false or throw, never a pass)', async () => {
    const { challenges, service, record } = await registered()
    const a = fixture.verifying.assertions.counter5
    const sig = Buffer.from(a.response.response.signature, 'base64url')
    sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0xff
    challenges.create('s1', 'mfa', { challenge: a.challenge })
    const bad = { ...a.response, response: { ...a.response.response, signature: sig.toString('base64url') } }
    await expectFailed(service.verifyAuthentication('s1', 'mfa', bad, record, { requireUserVerification: true }))
  })

  it('user verification: required for passwordless and step-up, optional as a second factor (SEC-TGT-014)', async () => {
    const s = setup()
    const nv = fixture.nonVerifying
    s.challenges.create('o', 'enrol_passkey', { challenge: nv.registration.challenge })
    // Registration with UV required refuses a non-verifying authenticator.
    await expectFailed(s.service.verifyRegistration('o', 'enrol_passkey', nv.registration.response, { requireUserVerification: true }))
    s.challenges.create('o', 'enrol_passkey', { challenge: nv.registration.challenge })
    const info = await s.service.verifyRegistration('o', 'enrol_passkey', nv.registration.response, { requireUserVerification: false })
    expect(info.uvInitial).toBe(false)
    const rec: PasskeyRecord = { ...info, userId: 'u2', name: 'n', createdAt: 0, lastUsedAt: null }
    s.challenges.create('s', 'signin_passkey', { challenge: nv.assertion.challenge })
    await expectFailed(s.service.verifyAuthentication('s', 'signin_passkey', nv.assertion.response, rec, { requireUserVerification: true }))
    s.challenges.create('s', 'mfa', { challenge: nv.assertion.challenge })
    const ok = await s.service.verifyAuthentication('s', 'mfa', nv.assertion.response, rec, { requireUserVerification: false })
    expect(ok.userVerified).toBe(false)
  })
})

describe('WebAuthn options', () => {
  it('registration: none attestation, explicit algorithms, excludes existing credentials, user handle is not the name', async () => {
    const { service, challenges } = setup()
    const webauthnUserId = Buffer.from('a'.repeat(32)).toString('base64url')
    const user = { id: 'u1', username: 'ana', displayName: 'Ana', webauthnUserId } as never
    const options = await service.registrationOptions(user, [{ id: 'abc', transports: ['internal'] } as never], 'enrol_passkey', 'o1')
    expect(options.attestation).toBe('none')
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257])
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual(['abc'])
    expect(options.user.id).toBe(webauthnUserId)
    expect(options.user.id).not.toContain('ana')
    expect(options.rp.id).toBe('dbloom.test')
    expect(challenges.take('o1', 'enrol_passkey')?.challenge).toBe(options.challenge)
  })

  it('authentication: usernameless has no list; UV required for sign-in and step-up only', async () => {
    const { service } = setup()
    const passwordless = await service.authenticationOptions('p', 'signin_passkey')
    expect(passwordless.allowCredentials ?? []).toHaveLength(0)
    expect(passwordless.userVerification).toBe('required')
    const mfa = await service.authenticationOptions('s', 'mfa', [{ id: 'abc', userId: 'u', transports: [] } as never])
    expect(mfa.allowCredentials).toHaveLength(1)
    expect(mfa.userVerification).toBe('preferred')
    expect((await service.authenticationOptions('s', 'stepup', [{ id: 'abc', userId: 'u', transports: [] } as never])).userVerification).toBe('required')
  })

  it('registers and authenticates end to end with the software authenticator', async () => {
    const { service, challenges } = setup()
    const soft = new SoftAuthenticator({ ...RP })
    const user = { id: 'u1', username: 'ana', displayName: 'Ana', webauthnUserId: 'x'.repeat(43) } as never
    const opts = await service.registrationOptions(user, [], 'enrol_passkey', 'o')
    const info = await service.verifyRegistration('o', 'enrol_passkey', soft.register(opts.challenge), { requireUserVerification: true })
    const record: PasskeyRecord = { ...info, userId: 'u1', name: 'n', createdAt: 0, lastUsedAt: null }
    const aopts = await service.authenticationOptions('o', 'stepup', [record])
    const result = await service.verifyAuthentication('o', 'stepup', soft.assert(aopts.challenge, { counter: 1 }), record, { requireUserVerification: true })
    expect(result).toMatchObject({ newCounter: 1, userVerified: true })
    expect(challenges.take('o', 'stepup')).toBeUndefined()
  })
})
