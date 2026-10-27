/** Package A (`codes.ts`, FR-AUT-010, ST-060): recovery codes, 60-bit Crockford base32, displayed `XXXX-XXXX-XXXX`.
 *
 * Stored only as the HMAC-SHA-256 MAC of the `recovery-codes` subkey over `user id ‖ code` (section 5.4); the
 * plaintext code exists only inside the caller's return, and nothing of it reaches a log or an audit field.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { RECOVERY_CODE_COUNT, type RecoveryCodeService, type SecretKeyRing, type UserId } from './types'

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 12 // 12 × 5 bits = 60 bits
const GROUP_SIZE = 4 // display groups

const plainAlphabet = /^[0-9A-Z]+$/ // after the substitutions, which is CROCKFORD_ALPHABET's size

export function createRecoveryCodeService(ring: SecretKeyRing): RecoveryCodeService {
  return {
    generate() {
      const codes: string[] = []
      for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
        let value = randomBytes(8).readBigUInt64BE() & ((1n << 60n) - 1n)
        const chars: string[] = []
        for (let j = 0; j < CODE_CHARS; j += 1) {
          chars.push(CROCKFORD_ALPHABET.charAt(Number(value & 31n)))
          value >>= 5n
        }
        codes.push(group(chars.reverse()))
      }
      return codes
    },

    normalise(input: string) {
      // Case-insensitive, spaces and dashes ignored (FR-AUT-010); Crockford substitutions make the display form
      // (`O`→0, `I`/`L`→1, `U`→V) comparable to the stored MAC.
      const cleaned = input
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[OIL]/g, (c) => (c === 'O' ? '0' : '1'))
        .replace(/U/g, 'V')
      if (cleaned.length !== CODE_CHARS || !plainAlphabet.test(cleaned)) return undefined
      if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(cleaned)) return undefined
      return cleaned
    },

    mac(userId: UserId, normalisedCode: string) {
      const subkey = ring.subkey('recoveryCodes')
      try {
        return createHmac('sha256', subkey).update(`${userId}${normalisedCode}`, 'utf8').digest('hex')
      } finally {
        subkey.fill(0) // subkey dropped right after use (section 5.4, best effort)
      }
    },
  }
}

function group(chars: readonly string[]): string {
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += GROUP_SIZE) groups.push(chars.slice(i, i + GROUP_SIZE).join(''))
  return groups.join('-')
}
