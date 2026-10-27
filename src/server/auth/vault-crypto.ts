/** Package A (`vault-crypto.ts`, FR-AUT-021, 022, Q10): vault key wrap/unwrap and profile seal/open.
 *
 * Vault key: 256-bit random, wrapped under the Argon2id key of the passphrase (AAD `vault/v1/passphrase/<id>`)
 * and under the HKDF key of the recovery key (20 bytes, display 32 Crockford characters in groups of four, AAD
 * `vault/v1/recovery/<id>`). Profiles: AES-256-GCM under the vault key, fresh 12-byte nonce per write, AAD
 * `profile/v1/<id>/<profile>`, sealed JSON `{user, password, clientKey?}`. Every Argon2 job runs through the
 * shared `runArgon2` slot of password.ts; key buffers zero with `fill(0)` when dropped (best effort, section
 * 5.4). The vault never feeds the audit log (section 5.6).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { argon2Tag } from './password'
import {
  AAD,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  ARGON2_SALT_BYTES,
  VAULT_HKDF_SALT_BYTES,
  VAULT_KEY_BYTES,
  VAULT_RECOVERY_INFO,
  VAULT_RECOVERY_KEY_BYTES,
  VAULT_RECOVERY_KEY_CHARS,
  type Argon2Params,
  type ProfileSecret,
  type UserId,
  type VaultRecord,
  type VaultCrypto,
} from './types'

const SEALED_VERSION_TEXT = 'v1'
// Profile records carry no key id: `v1.<nonce>.<ciphertext>.<tag>`, 4 parts.
const PROFILE_RECORD_PARTS = 4
// 160 raw bits = 160 display bits of Crockford base32.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// ---- GCM helper (one fresh nonce per write) ------------------------------------------------------------------

const sealFor = (key: Buffer, aad: string, plaintext: Buffer): string => {
  const nonce = randomBytes(AEAD_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AEAD_TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return [
      SEALED_VERSION_TEXT,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.')
  } finally {
    cipher.destroy?.()
  }
}

const openFor = (key: Buffer, aad: string, record: string, expectedParts: number): Buffer | undefined => {
  const parts = record.split('.')
  if (parts.length !== expectedParts) return undefined
  const [version, nonceText, ciphertextText, tagText] = parts as unknown as [string, string, string, string]
  if (version !== SEALED_VERSION_TEXT) return undefined
  try {
    const nonce = canonicalDecode(nonceText)
    const tag = canonicalDecode(tagText)
    const ciphertext = canonicalDecode(ciphertextText)
    if (nonce === undefined || tag === undefined || ciphertext === undefined) return undefined
    if (nonce.length !== AEAD_NONCE_BYTES || tag.length !== AEAD_TAG_BYTES) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AEAD_TAG_BYTES })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    decipher.destroy?.()
    return plaintext
  } catch {
    return undefined
  }
}

/** Canonical base64url only: appended junk ('…x') must not silently decode to the same bytes (SEC-SAU-067). */
const canonicalDecode = (text: string): Buffer | undefined => {
  try {
    const bytes = Buffer.from(text, 'base64url')
    return bytes.toString('base64url') === text ? bytes : undefined
  } catch {
    return undefined
  }
}

// ---- Key derivation ------------------------------------------------------------------------------------------

const derive = (passphrase: string, params: Argon2Params, salt: Buffer): Promise<Buffer> =>
  argon2Tag({ message: Buffer.from(passphrase, 'utf8'), nonce: salt, ...params })

const hkdfKey = (raw: Buffer, salt: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', raw, salt, Buffer.from(VAULT_RECOVERY_INFO), 32))

const unwrapWrap = (key: Buffer, aad: string, wrap: string) => {
  // Passphrase and recovery wraps are `v1.<nonce>.<ciphertext>.<tag>` too.
  return openFor(key, aad, wrap, PROFILE_RECORD_PARTS)
}

// ---- Recovery key formats ------------------------------------------------------------------------------------

export function encodeVaultRecoveryKey(raw: Buffer): string {
  if (raw.length !== VAULT_RECOVERY_KEY_BYTES) throw new Error('vault_recovery_key_length')
  let value = BigInt(`0x${raw.toString('hex')}`)
  const chars: string[] = []
  for (let i = 0; i < VAULT_RECOVERY_KEY_CHARS; i += 1) {
    chars.push(RECOVERY_ALPHABET.charAt(Number(value & 31n)))
    value >>= 5n
  }
  return segment(chars.reverse())
}

export function parseVaultRecoveryKey(display: string): Buffer | undefined {
  // Case-insensitive, spaces and dashes ignored; Crockford substitutions (`O`→0, `I`/`L`→1, `U`→V).
  const cleaned = display
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[O]/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (cleaned.length !== VAULT_RECOVERY_KEY_CHARS || !/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(cleaned)) {
    return undefined
  }
  let value = 0n
  for (const char of cleaned) value = (value << 5n) | BigInt(RECOVERY_ALPHABET.indexOf(char))
  return Buffer.from(value.toString(16).padStart(VAULT_RECOVERY_KEY_BYTES * 2, '0'), 'hex')
}

function segment(chars: readonly string[]): string {
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4).join(''))
  return groups.join('-')
}

// ---- Helpers ---------------------------------------------------------------------------------------------------

const zeroBuffer = (...buffers: Array<Buffer | undefined>): void => {
  for (const buffer of buffers) buffer?.fill(0)
}

/** Re-wrap of the same vault key: fresh salt under the given parameters (passphrase change, section 5.4). */
const passphraseWrap = async (
  userId: UserId,
  vaultKey: Buffer,
  passphrase: string,
  params: Argon2Params,
): Promise<Pick<VaultRecord, 'kdfParams' | 'kdfSalt' | 'wrapPassphrase'>> => {
  const salt = randomBytes(ARGON2_SALT_BYTES)
  const kdf = await derive(passphrase, params, salt)
  const wrap = sealFor(kdf, AAD.vaultPassphrase(userId), vaultKey)
  zeroBuffer(kdf)
  return { kdfParams: { ...params }, kdfSalt: salt.toString('base64url'), wrapPassphrase: wrap }
}

function recoveryWrapText(
  userId: UserId,
  vaultKey: Buffer,
): { fields: Pick<VaultRecord, 'recoverySalt' | 'wrapRecovery'>; recoveryKey: string } {
  const raw = randomBytes(VAULT_RECOVERY_KEY_BYTES)
  const salt = randomBytes(VAULT_HKDF_SALT_BYTES)
  const kdf = hkdfKey(raw, salt)
  const wrap = sealFor(kdf, AAD.vaultRecovery(userId), vaultKey)
  zeroBuffer(kdf)
  return { fields: { recoverySalt: salt.toString('base64url'), wrapRecovery: wrap }, recoveryKey: encodeVaultRecoveryKey(raw) }
}

// ---- Service -------------------------------------------------------------------------------------------------

export function vaultCrypto(): VaultCrypto {
  return {
    async create(userId, passphrase, params) {
      const vaultKey = randomBytes(VAULT_KEY_BYTES)
      const wrap = await passphraseWrap(userId, vaultKey, passphrase, params)
      const recovery = recoveryWrapText(userId, vaultKey)
      return {
        record: {
          userId,
          kdfParams: wrap.kdfParams,
          kdfSalt: wrap.kdfSalt,
          wrapPassphrase: wrap.wrapPassphrase,
          recoverySalt: recovery.fields.recoverySalt,
          wrapRecovery: recovery.fields.wrapRecovery,
        },
        vaultKey,
        recoveryKey: recovery.recoveryKey,
      }
    },

    async unwrapWithPassphrase(record, passphrase) {
      const salt = Buffer.from(record.kdfSalt, 'base64url')
      const kdf = await derive(passphrase, record.kdfParams, salt)
      const key = unwrapWrap(kdf, AAD.vaultPassphrase(record.userId), record.wrapPassphrase)
      zeroBuffer(kdf)
      return key ?? undefined
    },

    unwrapWithRecoveryKey(record, recoveryKey) {
      const raw = parseVaultRecoveryKey(recoveryKey)
      if (raw === undefined) return undefined
      const salt = Buffer.from(record.recoverySalt, 'base64url')
      const kdf = hkdfKey(raw, salt)
      raw.fill(0)
      const key = unwrapWrap(kdf, AAD.vaultRecovery(record.userId), record.wrapRecovery)
      zeroBuffer(kdf)
      return key ?? undefined
    },

    rewrapPassphrase: passphraseWrap,

    rewrapRecovery(userId, vaultKey) {
      return recoveryWrapText(userId, vaultKey)
    },

    sealProfile(vaultKey, userId, profileId, secret) {
      return sealFor(vaultKey, AAD.profile(userId, profileId), Buffer.from(JSON.stringify(secret), 'utf8'))
    },

    openProfile(vaultKey, userId, profileId, sealed) {
      const plaintext = openFor(vaultKey, AAD.profile(userId, profileId), sealed, PROFILE_RECORD_PARTS)
      if (plaintext === undefined) return undefined
      try {
        const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
        if (!isProfileSecret(parsed)) return undefined
        return parsed
      } catch {
        return undefined
      } finally {
        plaintext.fill(0)
      }
    },
  }
}

function isProfileSecret(value: unknown): value is ProfileSecret {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.user === 'string' &&
    typeof candidate.password === 'string' &&
    (candidate.clientKey === undefined || typeof candidate.clientKey === 'string')
  )
}

export const vaultCryptoService = vaultCrypto()
