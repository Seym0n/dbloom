/** Browser side of WebAuthn: one place that calls the ceremony, maps its failures and fakes it for the mock layer. */
import { useSyncExternalStore } from 'react'
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { isAuthMock, type AuthenticationResponse, type CreationOptions, type RegistrationResponse, type RequestOptions } from './api'

export type PasskeyFailure = 'cancelled' | 'unsupported' | 'failed'

export class PasskeyError extends Error {
  constructor(public readonly kind: PasskeyFailure) {
    super(kind)
    this.name = 'PasskeyError'
  }
}

export const passkeysSupported = () => isAuthMock() || (typeof window !== 'undefined' && browserSupportsWebAuthn())

const noSubscribe = () => () => undefined

/** Render-safe support check: the server render assumes support, the browser corrects it after hydration. */
export const usePasskeysSupported = () => useSyncExternalStore(noSubscribe, passkeysSupported, () => true)

/** Maps a thrown ceremony error: the user dismissing the prompt is not a failure of the account. */
export function classifyPasskeyError(error: unknown): PasskeyFailure {
  const name = error instanceof Error ? error.name : ''
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.name : ''
  if (name === 'NotAllowedError' || cause === 'NotAllowedError' || name === 'AbortError' || cause === 'AbortError') return 'cancelled'
  if (name === 'NotSupportedError' || cause === 'NotSupportedError') return 'unsupported'
  return 'failed'
}

const fakeId = 'bW9jay1jcmVkZW50aWFs'

export async function createPasskey(options: CreationOptions): Promise<RegistrationResponse> {
  if (isAuthMock()) {
    return {
      id: fakeId,
      rawId: fakeId,
      type: 'public-key',
      response: { clientDataJSON: 'e30', attestationObject: 'e30' },
      clientExtensionResults: {},
    } as RegistrationResponse
  }
  if (!browserSupportsWebAuthn()) throw new PasskeyError('unsupported')
  try {
    return await startRegistration({ optionsJSON: options })
  } catch (error) {
    throw new PasskeyError(classifyPasskeyError(error))
  }
}

export async function authenticateWithPasskey(options: RequestOptions): Promise<AuthenticationResponse> {
  if (isAuthMock()) {
    return {
      id: fakeId,
      rawId: fakeId,
      type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'e30', signature: 'e30' },
      clientExtensionResults: {},
    } as AuthenticationResponse
  }
  if (!browserSupportsWebAuthn()) throw new PasskeyError('unsupported')
  try {
    return await startAuthentication({ optionsJSON: options })
  } catch (error) {
    throw new PasskeyError(classifyPasskeyError(error))
  }
}
