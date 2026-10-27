/** Package A (`secret-key.ts`, FR-AUT-023, Q2): loading of DBLOOM_SECRET_KEY(_FILE), HKDF subkeys, seal/open and rotation.
 *
 * Record format `v1.<key id>.<nonce>.<ciphertext>.<tag>`, base64url parts joined with `.` (FR-AUT-023). `open`
 * answers undefined for every failure (tamper, wrong AAD, unknown key id; SEC-SAU-067). The previous key is a
 * rotation aid only (new key, old key as DBLOOM_SECRET_KEY_PREVIOUS, restart, `rotate-secret`), never on the
 * store volume; losing the server key makes TOTP secrets and recovery codes unusable while passwords, passkeys
 * and vaults are unaffected (section 5.4).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  KEY_ID_BYTES,
  SECRET_KEY_BYTES,
  SEALED_VERSION,
  SUBKEY_INFO,
  type LoadSecretKeyResult,
  type SecretKeyRing,
  type SubkeyKind,
} from './types'

const KEY_ID_INFO = 'key-id'
// Nested records of `seal` / `open`: 5 parts, everything base64url.
const RECORD_PARTS = 5
// Obvious non-secrets that the loader must refuse (`placeholder`).
const PLACEHOLDERS = new Set(['', '[secret]', 'change-me', 'changeme', 'CHANGE_ME', 'secret', 'set-a-secret-key'])

export function subkeyOf(key: Buffer, kind: SubkeyKind): Buffer {
  // HKDF-SHA-256, empty salt, typed info string, 32 bytes.
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(SUBKEY_INFO[kind]), 32))
}

export function keyIdOf(key: Buffer): string {
  return createHmac('sha256', key).update(KEY_ID_INFO).digest().subarray(0, KEY_ID_BYTES).toString('base64url')
}

export class ServerKeyRing implements SecretKeyRing {
  readonly currentKeyId: string
  readonly previousKeyId: string | undefined
  private readonly previous: Buffer | undefined

  constructor(
    private readonly key: Buffer,
    previous: Buffer | undefined,
  ) {
    this.previous = previous
    this.currentKeyId = keyIdOf(this.key)
    this.previousKeyId = previous === undefined ? undefined : keyIdOf(previous)
  }

  subkey(kind: SubkeyKind): Buffer {
    return subkeyOf(this.key, kind)
  }

  seal(kind: SubkeyKind, aad: string, plaintext: Buffer): string {
    // Fresh 12-byte nonce on every write (FR-AUT-023).
    const nonce = randomBytes(AEAD_NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', subkeyOf(this.key, kind), nonce, { authTagLength: AEAD_TAG_BYTES })
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag().toString('base64url')
    return [SEALED_VERSION, this.currentKeyId, nonce.toString('base64url'), ciphertext.toString('base64url'), tag].join('.')
  }

  open(kind: SubkeyKind, aad: string, record: string): Buffer | undefined {
    const parts = record.split('.')
    if (parts.length !== RECORD_PARTS) return undefined
    const [version, keyId, nonceText, ciphertextText, tagText] = parts as unknown as [
      string,
      string,
      string,
      string,
      string,
    ]
    if (version !== SEALED_VERSION) return undefined
    const nonce = tryDecode(nonceText)
    const tag = tryDecode(tagText)
    if (nonce === undefined || tag === undefined) return undefined
    if (nonce.length !== AEAD_NONCE_BYTES || tag.length !== AEAD_TAG_BYTES) return undefined
    let key: Buffer
    if (keyId === this.currentKeyId) key = subkeyOf(this.key, kind)
    else if (this.previousKeyId !== undefined && this.previous !== undefined && keyId === this.previousKeyId)
      key = subkeyOf(this.previous, kind)
    else return undefined
    try {
      const ciphertext = tryDecode(ciphertextText)
      if (ciphertext === undefined) return undefined
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AEAD_TAG_BYTES })
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()])
      decipher.destroy?.()
      return plaintext
    } catch {
      return undefined
    }
  }

  /** True when the record was sealed with the previous key and should be re-sealed on its next write. */
  isStale(record: string): boolean {
    const parts = record.split('.')
    if (parts.length !== RECORD_PARTS) return false
    return this.previousKeyId !== undefined && parts[1] === this.previousKeyId
  }
}

const tryDecode = (text: string) => {
  try {
    // Canonical base64url only: appended junk characters ('…x') must not silently decode to the same bytes.
    const bytes = Buffer.from(text, 'base64url')
    return bytes.toString('base64url') === text ? bytes : undefined
  } catch {
    return undefined
  }
}

/** `DBLOOM_SECRET_KEY` accepts hex (64 characters) or base64url; the file form holds the same bytes. */
export function decodeKeyText(text: string): Buffer {
  const value = text.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex')
  return Buffer.from(value, 'base64url')
}

/**
 * Loads the server key from `DBLOOM_SECRET_KEY` or `DBLOOM_SECRET_KEY_FILE` (Docker secret, Q2). `missing` when
 * neither variable is set, `short` below SECRET_KEY_BYTES bytes, `placeholder` for an obvious non-secret, and
 * `unreadable_file` when the file cannot be read. The key ring stays undefined until this returns ok.
 */
export function loadSecretKey(env: NodeJS.ProcessEnv): LoadSecretKeyResult {
  const fromEnv = env.DBLOOM_SECRET_KEY
  const fromFile = env.DBLOOM_SECRET_KEY_FILE
  if (!fromEnv && !fromFile) return { ok: false, reason: 'missing' }
  let key: Buffer
  if (fromEnv) {
    if (PLACEHOLDERS.has(fromEnv.trim())) return { ok: false, reason: 'placeholder' }
    try {
      key = decodeKeyText(fromEnv)
    } catch {
      return { ok: false, reason: 'short' }
    }
  } else {
    try {
      const text = readFileSync(fromFile!, 'utf8')
      if (PLACEHOLDERS.has(text.trim())) return { ok: false, reason: 'placeholder' }
      key = decodeKeyText(text)
    } catch {
      return { ok: false, reason: 'unreadable_file' }
    }
  }
  if (key.length < SECRET_KEY_BYTES) return { ok: false, reason: 'short' }
  return {
    ok: true,
    ring: new ServerKeyRing(key.subarray(0, SECRET_KEY_BYTES), previousKey(env)),
  }
}

function previousKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const text = env.DBLOOM_SECRET_KEY_PREVIOUS
  if (!text) return undefined
  const key = decodeKeyText(text)
  // A broken previous key must not break the start; rotation proceeds without it.
  return key.length >= SECRET_KEY_BYTES ? key.subarray(0, SECRET_KEY_BYTES) : undefined
}
