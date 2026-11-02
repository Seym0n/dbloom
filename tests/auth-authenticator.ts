/** Test helper: a software WebAuthn authenticator (ES256, `none` attestation) producing the JSON the browser would send.
 *
 * Used by the WebAuthn and sign-in tests, and to record `tests/fixtures/auth/webauthn.json`
 * (`npx tsx tests/auth-authenticator.ts` is not needed: the fixture test regenerates nothing, it only replays).
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest()

// Minimal CBOR (definite lengths, small items) for the attestation object and the COSE key.
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  throw new Error('unsupported cbor value')
}

export type SoftOptions = { rpId: string; origin: string; userVerified?: boolean; backedUp?: boolean }

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32)
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  counter = 0
  /** Last assertion sent, for replay tests. */
  constructor(readonly opts: SoftOptions) {}

  private authData(flags: number, counter: number, attested: boolean): Buffer {
    const header = Buffer.alloc(37)
    sha256(this.opts.rpId).copy(header, 0)
    header[32] = flags
    header.writeUInt32BE(counter, 33)
    if (!attested) return header
    const jwk = (this.keys.publicKey as KeyObject).export({ format: 'jwk' })
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    )
    const idLen = Buffer.alloc(2)
    idLen.writeUInt16BE(this.credentialId.length)
    return Buffer.concat([header, Buffer.alloc(16), idLen, this.credentialId, cose])
  }

  private flags(attested: boolean) {
    return 0x01 | (this.opts.userVerified === false ? 0 : 0x04) | (this.opts.backedUp ? 0x08 | 0x10 : 0) | (attested ? 0x40 : 0)
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.opts.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  /** Registration response for options' `challenge`. */
  register(challenge: string, opts: { origin?: string } = {}): RegistrationResponseJSON {
    const authData = this.authData(this.flags(true), this.counter, true)
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', challenge, opts.origin)), attestationObject: b64u(attestationObject), transports: ['internal' as const] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    } as RegistrationResponseJSON
  }

  /** Assertion response; `counter` overrides the running counter (default: increment). */
  assert(challenge: string, opts: { counter?: number; origin?: string; userHandle?: string } = {}): AuthenticationResponseJSON {
    this.counter = opts.counter ?? this.counter + 1
    const authData = this.authData(this.flags(false), this.counter, false)
    const clientDataJSON = this.clientData('webauthn.get', challenge, opts.origin)
    const sign = createSign('sha256')
    sign.update(Buffer.concat([authData, sha256(clientDataJSON)]))
    const signature = sign.sign(this.keys.privateKey)
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(opts.userHandle === undefined ? {} : { userHandle: opts.userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    } as AuthenticationResponseJSON
  }
}
