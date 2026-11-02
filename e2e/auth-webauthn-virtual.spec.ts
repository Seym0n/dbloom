/** Package C: WebAuthn service against a Chromium virtual authenticator (FR-AUT-009, SCN-067; SEC-TGT-011/014).
 *
 * Needs no running DBLoom server and no other package: a fake secure page (`http://localhost`) hosts the browser
 * half (`@simplewebauthn/browser`), the Node half is `createWebAuthnService` itself. Skip with
 * `DBLOOM_SKIP_VIRTUAL_AUTHENTICATOR=1` where Chromium or CDP is unavailable.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type CDPSession, type Page } from '@playwright/test'
import { createChallengeStore } from '../src/server/auth/challenges'
import { AuthError, type PasskeyRecord } from '../src/server/auth/types'
import { createWebAuthnService } from '../src/server/auth/webauthn'

test.skip(process.env.DBLOOM_SKIP_VIRTUAL_AUTHENTICATOR === '1', 'virtual authenticator disabled')

const ORIGIN = 'http://localhost:3999'
const RP = { rpId: 'localhost', origin: ORIGIN, rpName: 'DBLoom' }
const browserBundle = readFileSync(resolve(process.cwd(), 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'), 'utf8')
const user = { id: 'u1', username: 'ana', displayName: 'Ana', webauthnUserId: Buffer.alloc(32, 7).toString('base64url') } as never

async function openPage(page: Page, hasUserVerification: boolean): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' }))
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ content: browserBundle })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification,
      isUserVerified: hasUserVerification,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

const create = (page: Page, options: unknown) =>
  page.evaluate(async (o) => (window as never as { SimpleWebAuthnBrowser: { startRegistration: (a: unknown) => Promise<unknown> } }).SimpleWebAuthnBrowser.startRegistration({ optionsJSON: o }), options)
const get = (page: Page, options: unknown) =>
  page.evaluate(async (o) => (window as never as { SimpleWebAuthnBrowser: { startAuthentication: (a: unknown) => Promise<unknown> } }).SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o }), options)

test('user-verifying authenticator: register, passwordless assertion, counter rule, replay, wrong origin', async ({ page }) => {
  await openPage(page, true)
  const challenges = createChallengeStore()
  const service = createWebAuthnService({ challenges, relyingParty: () => RP })

  const regOptions = await service.registrationOptions(user, [], 'enrol_passkey', 'owner')
  const info = await service.verifyRegistration('owner', 'enrol_passkey', (await create(page, regOptions)) as never, { requireUserVerification: true })
  expect(info.uvInitial).toBe(true)
  let record: PasskeyRecord = { ...info, userId: 'u1', name: 'k', createdAt: 0, lastUsedAt: null }

  // Passwordless: usernameless request, user verification required.
  const options = await service.authenticationOptions('pre', 'signin_passkey')
  const response = (await get(page, options)) as never
  const result = await service.verifyAuthentication('pre', 'signin_passkey', response, record, { requireUserVerification: true })
  expect(result.userVerified).toBe(true)
  record = { ...record, counter: result.newCounter }

  // Replay of the same response: the challenge is gone.
  await expect(service.verifyAuthentication('pre', 'signin_passkey', response, record, { requireUserVerification: true })).rejects.toBeInstanceOf(AuthError)

  // A stored counter ahead of the authenticator (lowered counter) is refused.
  const o2 = await service.authenticationOptions('pre', 'signin_passkey')
  const r2 = (await get(page, o2)) as never
  await expect(
    service.verifyAuthentication('pre', 'signin_passkey', r2, { ...record, counter: record.counter + 100 }, { requireUserVerification: true }),
  ).rejects.toMatchObject({ code: 'mfa_failed' })

  // The same response checked for another origin fails.
  const o3 = await service.authenticationOptions('pre', 'signin_passkey')
  const r3 = (await get(page, o3)) as never
  const other = createWebAuthnService({ challenges, relyingParty: () => ({ ...RP, origin: 'http://localhost:4000' }) })
  await expect(other.verifyAuthentication('pre', 'signin_passkey', r3, record, { requireUserVerification: true })).rejects.toMatchObject({ code: 'mfa_failed' })
})

test('non-verifying authenticator: second factor only (SEC-TGT-014)', async ({ page }) => {
  await openPage(page, false)
  const challenges = createChallengeStore()
  const service = createWebAuthnService({ challenges, relyingParty: () => RP })
  const regOptions = await service.registrationOptions(user, [], 'enrol_passkey', 'owner')
  const response = (await create(page, regOptions)) as never
  // Registration with user verification required is refused; the library check happens in Node.
  const strict = createChallengeStore()
  const strictService = createWebAuthnService({ challenges: strict, relyingParty: () => RP })
  strict.create('owner', 'enrol_passkey', { challenge: regOptions.challenge })
  await expect(strictService.verifyRegistration('owner', 'enrol_passkey', response, { requireUserVerification: true })).rejects.toMatchObject({ code: 'mfa_failed' })
  const info = await service.verifyRegistration('owner', 'enrol_passkey', response, { requireUserVerification: false })
  expect(info.uvInitial).toBe(false)
  const record: PasskeyRecord = { ...info, userId: 'u1', name: 'k', createdAt: 0, lastUsedAt: null }

  // As a second factor (listed credential, user verification optional) it works.
  const mfa = await service.authenticationOptions('s', 'mfa', [record])
  const ok = await service.verifyAuthentication('s', 'mfa', (await get(page, mfa)) as never, record, { requireUserVerification: false })
  expect(ok.userVerified).toBe(false)
  // For step-up (user verification required) it is refused.
  const stepup = await service.authenticationOptions('s', 'stepup', [record])
  const response2 = (await get(page, { ...stepup, userVerification: 'preferred' })) as never
  await expect(service.verifyAuthentication('s', 'stepup', response2, { ...record, counter: ok.newCounter }, { requireUserVerification: true })).rejects.toMatchObject({ code: 'mfa_failed' })
})
