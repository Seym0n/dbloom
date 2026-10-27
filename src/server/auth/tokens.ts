/** Package A (`tokens.ts`, FR-AUT-002, 015, 016, ST-081, ST-082): setup token, link tokens, hashes and connection ids.
 *
 * Setup token: 160 bit in Crockford base32 (32 characters, groups of four). Invite and recovery tokens: 256 bit
 * base64url (43 characters), URL fragment, stored only as SHA-256. Everything random from `crypto.randomBytes`
 * and every hash equality constant-time (section 5.4).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  CROCKFORD_ALPHABET as CODES_CROCKFORD,
} from './codes'
import { CONNECTION_ID_BYTES, LINK_TOKEN_BYTES, SETUP_TOKEN_BITS, SETUP_TOKEN_CHARS, type ConnectionId, type TokenService } from './types'

const SEGMENT = 4 // display groups of four characters

export class AuthTokens implements TokenService {
  /** 160 bit in Crockford base32; 160 = 32 × 5 bits exactly, groups of four. */
  newSetupToken(): string {
    const chars: string[] = []
    let raw = setupValue()
    for (let i = 0; i < SETUP_TOKEN_CHARS; i += 1) {
      chars.push(CODES_CROCKFORD.charAt(Number(raw & 31n)))
      raw >>= 5n
    }
    return segment(chars.reverse())
  }

  /** Case and group separators are ignored at verification; Crockford substitutions applied. */
  normaliseSetupToken(input: string): string {
    return input
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .replace(/[OIL]/g, (c) => (c === 'O' ? '0' : '1'))
      .replace(/U/g, 'V')
  }

  /** 256-bit base64url token, 43 characters (ST-082). */
  newLinkToken(): string {
    return randomBytes(LINK_TOKEN_BYTES).toString('base64url')
  }

  /** SHA-256 hex of a token, the stored form (section 5.4). */
  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
  }

  /** Constant-time over equal-length hashes; unequal lengths answer false without timing differences. */
  equalHashes(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  }

  /** Tab-scoped connection id, 16 bytes base64url (FR-AUT-018). */
  newConnectionId(): ConnectionId {
    return randomBytes(CONNECTION_ID_BYTES).toString('base64url')
  }
}

function setupValue(): bigint {
  const bytes = randomBytes(SETUP_TOKEN_BITS / 8)
  return BigInt(`0x${bytes.toString('hex')}`) & ((1n << BigInt(SETUP_TOKEN_BITS)) - 1n)
}

function segment(chars: readonly string[]): string {
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += SEGMENT) groups.push(chars.slice(i, i + SEGMENT).join(''))
  return groups.join('-')
}

export const tokens = new AuthTokens()
