/** Package C (`webauthn.ts`, FR-AUT-009, SEC-TGT-011/014, ST-060 to 062): `@simplewebauthn/server` behind one service.
 *
 * Every ceremony needs a held challenge of the right purpose (taken first, so it is single use whatever happens).
 * Every library error, a `verified: false` result and a counter that does not increase (unless both are 0) end as
 * `AuthError('mfa_failed')`; the detail goes to the audit line only (SEC-TGT-153).
 */
import type { AuthenticatorTransport } from '@simplewebauthn/server'
import { audit } from '../audit'
import {
  AuthError,
  WEBAUTHN_ALGORITHM_IDS,
  type AuthenticationResponseJSON,
  type ChallengePurpose,
  type ChallengeStore,
  type PasskeyRecord,
  type RegistrationResponseJSON,
  type User,
  type WebAuthnService,
} from './types'

/**
 * The library loads on first use, after `reflect-metadata`: its ASN.1/X.509 packages use tsyringe, which throws at import
 * time without that polyfill, and a static import order is not kept by the server bundle.
 */
let library: Promise<typeof import('@simplewebauthn/server')> | undefined
const lib = () => (library ??= import('reflect-metadata').then(() => import('@simplewebauthn/server')))

export type WebAuthnConfig = {
  /** RP ID (host of the public origin) and the exact expected origin (ST-060); read per call so a settings change applies. */
  relyingParty: () => { rpId: string; origin: string; rpName: string }
  challenges: ChallengeStore
}

/** Purposes whose assertion must carry user verification in the options sent to the browser (SEC-TGT-014). */
const UV_REQUIRED_PURPOSES: readonly ChallengePurpose[] = ['signin_passkey', 'stepup']

const REGISTRATION_PURPOSES: readonly ChallengePurpose[] = ['enrol_passkey', 'setup_passkey', 'invite_passkey', 'recovery_passkey']
const AUTHENTICATION_PURPOSES: readonly ChallengePurpose[] = ['signin_passkey', 'mfa', 'stepup']

/** Library text goes to the audit line only; bounded, single line. */
const detailOf = (error: unknown) => (error instanceof Error ? error.message : 'unknown').replace(/\s+/g, ' ').slice(0, 200)

function fail(reason: string, extra: { event?: 'auth.mfa' | 'webauthn.counter'; subject?: string } = {}): never {
  audit(extra.event ?? 'auth.mfa', { outcome: 'failed', method: 'passkey', reason, subject: extra.subject })
  throw new AuthError('mfa_failed')
}

export function createWebAuthnService(config: WebAuthnConfig): WebAuthnService {
  const { challenges } = config
  return {
    async registrationOptions(user: User, existing: PasskeyRecord[], purpose: ChallengePurpose, owner: string) {
      if (!REGISTRATION_PURPOSES.includes(purpose)) throw new AuthError('mfa_failed')
      const rp = config.relyingParty()
      const options = await (await lib()).generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpId,
        // The user name is shown by the authenticator; the user handle is the random id, never the name (FR-AUT-004).
        userName: user.username,
        userDisplayName: user.displayName || user.username,
        userID: Buffer.from(user.webauthnUserId, 'base64url'),
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHM_IDS],
      })
      challenges.create(owner, purpose, { userId: user.id, challenge: options.challenge })
      return options
    },

    async verifyRegistration(owner: string, purpose: ChallengePurpose, response: RegistrationResponseJSON, opts: { requireUserVerification: boolean }) {
      const held = challenges.take(owner, purpose)
      if (!held?.challenge || !REGISTRATION_PURPOSES.includes(purpose)) return fail('no_challenge')
      const rp = config.relyingParty()
      try {
        const result = await (await lib()).verifyRegistrationResponse({
          response,
          expectedChallenge: held.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          requireUserPresence: true,
          requireUserVerification: opts.requireUserVerification,
          supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHM_IDS],
        })
        if (!result.verified || !result.registrationInfo) return fail('not_verified')
        const { credential, userVerified, credentialBackedUp } = result.registrationInfo
        return {
          id: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: (credential.transports ?? response.response.transports ?? []) as AuthenticatorTransport[],
          backedUp: credentialBackedUp,
          uvInitial: userVerified,
        }
      } catch (error) {
        if (error instanceof AuthError) throw error
        return fail(detailOf(error))
      }
    },

    async authenticationOptions(owner: string, purpose: ChallengePurpose, allow?: PasskeyRecord[]) {
      if (!AUTHENTICATION_PURPOSES.includes(purpose)) throw new AuthError('mfa_failed')
      const rp = config.relyingParty()
      const options = await (await lib()).generateAuthenticationOptions({
        rpID: rp.rpId,
        // Usernameless sign-in sends no list (discoverable credentials); every other step lists the user's own
        // credentials (a non-verifying authenticator cannot answer an empty list, spike 0).
        ...(allow ? { allowCredentials: allow.map((c) => ({ id: c.id, transports: c.transports })) } : {}),
        userVerification: UV_REQUIRED_PURPOSES.includes(purpose) ? 'required' : 'preferred',
      })
      const userId = allow?.[0]?.userId
      challenges.create(owner, purpose, { challenge: options.challenge, ...(userId ? { userId } : {}) })
      return options
    },

    async verifyAuthentication(
      owner: string,
      purpose: ChallengePurpose,
      response: AuthenticationResponseJSON,
      credential: PasskeyRecord,
      opts: { requireUserVerification: boolean },
    ) {
      const held = challenges.take(owner, purpose)
      if (!held?.challenge || !AUTHENTICATION_PURPOSES.includes(purpose)) return fail('no_challenge', { subject: credential.userId })
      // A challenge issued for one user's credentials never verifies another user's credential.
      if (held.userId && held.userId !== credential.userId) return fail('user_mismatch', { subject: credential.userId })
      const rp = config.relyingParty()
      try {
        const result = await (await lib()).verifyAuthenticationResponse({
          response,
          expectedChallenge: held.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: credential.transports },
          requireUserVerification: opts.requireUserVerification,
        })
        // A bad signature does not throw: `verified` is false (spike 0).
        if (!result.verified) return fail('not_verified', { subject: credential.userId })
        const { newCounter, userVerified, credentialBackedUp } = result.authenticationInfo
        // ST-062 again after the library (defence in depth): both 0 is accepted, any other non-increase is not.
        if ((newCounter > 0 || credential.counter > 0) && newCounter <= credential.counter) {
          return fail('counter', { event: 'webauthn.counter', subject: credential.userId })
        }
        return { newCounter, userVerified, backedUp: credentialBackedUp }
      } catch (error) {
        if (error instanceof AuthError) throw error
        const detail = detailOf(error)
        return fail(detail, { event: /counter/i.test(detail) ? 'webauthn.counter' : 'auth.mfa', subject: credential.userId })
      }
    },
  }
}
