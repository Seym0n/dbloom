/** Unit tests of package A `vault-crypto.ts` (FR-AUT-021, 022; section 10: wrap/unwrap, tamper, rewrap). */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ARGON2_VAULT_MIN, type VaultRecord } from '../src/server/auth/types'
import { vaultCrypto, parseVaultRecoveryKey } from '../src/server/auth/vault-crypto'

const svc = vaultCrypto()
const userId = '11111111-1111-4111-8111-111111111111'
const MIN = ARGON2_VAULT_MIN

const created = await svc.create(userId, 'vB7!quid-2041', MIN)

const asRecord = (record: Omit<VaultRecord, 'createdAt' | 'updatedAt'>): VaultRecord => ({ ...record, createdAt: 0, updatedAt: 0 })

describe('create', () => {
  it('returns record, vaultKey and the display recoveryKey', async () => {
    const { record, vaultKey, recoveryKey } = created
    expect(record.kdfParams).toEqual(MIN)
    expect(Buffer.from(record.kdfSalt, 'base64url')).toHaveLength(16)
    expect(vaultKey).toHaveLength(32)
    expect(record.wrapPassphrase.startsWith('v1.')).toBe(true)
    expect(record.wrapRecovery.startsWith('v1.')).toBe(true)
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
    expect(/[ILOU]/.test(recoveryKey.replace(/-/g, ''))).toBe(false)
  })

  it('wraps twice: passphrase and recovery wrap differ', async () => {
    expect(created.record.wrapPassphrase).not.toBe(created.record.wrapRecovery)
  })

  it('distinct creates give distinct salts and keys', async () => {
    const second = await svc.create(userId, 'vB7!quid-2041', MIN)
    expect(second.record.kdfSalt).not.toBe(created.record.kdfSalt)
    expect(second.record.wrapPassphrase).not.toBe(created.record.wrapPassphrase)
  })
})

describe('unwrapWithPassphrase', () => {
  it('answers the vault key for the right passphrase only', async () => {
    const key = await svc.unwrapWithPassphrase(asRecord(created.record), 'vB7!quid-2041')
    expect(key?.equals(created.vaultKey)).toBe(true)
    expect(await svc.unwrapWithPassphrase(asRecord(created.record), 'wrong')).toBeUndefined()
    expect(await svc.unwrapWithPassphrase(asRecord(created.record), '')).toBeUndefined()
  })

  it('refuses a tampered wrap (AAD covers the user id)', async () => {
    const record = asRecord(created.record)
    const tampered: VaultRecord = { ...record, wrapPassphrase: record.wrapPassphrase.replace(/.$/, 'x') }
    expect(tampered.wrapPassphrase).not.toBe(record.wrapPassphrase)
    expect(await svc.unwrapWithPassphrase(tampered, 'vB7!quid-2041')).toBeUndefined()
  })
})

describe('unwrapWithRecoveryKey', () => {
  it('recovers the vault key synchronously when the display key parses', () => {
    const key = svc.unwrapWithRecoveryKey(asRecord(created.record), created.recoveryKey)
    expect(key?.equals(created.vaultKey)).toBe(true)
  })

  it('refuses a malformed and a tampered key', () => {
    expect(svc.unwrapWithRecoveryKey(asRecord(created.record), 'nonono-o')).toBeUndefined()
    expect(
      svc.unwrapWithRecoveryKey(asRecord(created.record), created.recoveryKey.replace(/.$/, created.recoveryKey.startsWith('0') ? '1' : '0')),
    ).toBeUndefined()
  })

  it('round-trips through the parser', () => {
    const raw = randomBytes(20)
    // Same segments as the module's encoder: it lives for the recovery format test only.
    const parsed = parseVaultRecoveryKey(segmentChars(BigInt(`0x${raw.toString('hex')}`)))
    expect(parsed?.equals(raw)).toBe(true)
    expect(parseVaultRecoveryKey('sorry')).toBeUndefined()
    expect(parseVaultRecoveryKey('')).toBeUndefined()
  })
})

describe('rewrap', () => {
  it('rewrapPassphrase re-wraps under new parameters and passphrase', async () => {
    const fields = await svc.rewrapPassphrase(userId, created.vaultKey, 'new-pass', ARGON2_VAULT_MIN)
    const whole = { ...created.record, ...fields, userId, createdAt: 0, updatedAt: 0 }
    const key = await svc.unwrapWithPassphrase(whole, 'new-pass')
    expect(key?.equals(created.vaultKey)).toBe(true)
    expect(await svc.unwrapWithPassphrase(whole, 'vB7!quid-2041')).toBeUndefined()
  })

  it('rewrapRecovery gives a fresh display key and a working wrap', () => {
    const { fields, recoveryKey } = svc.rewrapRecovery(userId, created.vaultKey)
    const whole: VaultRecord = { ...created.record, ...fields, userId, createdAt: 0, updatedAt: 0 }
    expect(recoveryKey).not.toBe(created.recoveryKey)
    expect(svc.unwrapWithRecoveryKey(whole, recoveryKey)?.equals(created.vaultKey)).toBe(true)
    expect(svc.unwrapWithRecoveryKey(whole, created.recoveryKey)).toBeUndefined()
  })
})

describe('profiles', () => {
  const profileId = '22222222-2222-4222-8222-222222222222'
  const secret = { user: 'root', password: 't9!Zas3', clientKey: '-----BEGIN-----\nabc\n-----END-----' }

  it('seals and opens a profile only under the matching vault key and AAD', () => {
    const sealed = svc.sealProfile(created.vaultKey, userId, profileId, secret)
    expect(sealed.startsWith('v1.')).toBe(true)
    expect(sealed.includes('root')).toBe(false) // the plaintext never appears in the record
    const opened = svc.openProfile(created.vaultKey, userId, profileId, sealed)
    expect(opened).toEqual(secret)
    expect(svc.openProfile(created.vaultKey, userId, 'other-profile', sealed)).toBeUndefined()
  })

  it('refuses a tampered record and JSON that is not a ProfileSecret', () => {
    const sealed = svc.sealProfile(created.vaultKey, userId, profileId, secret)
    expect(svc.openProfile(created.vaultKey, userId, profileId, `${sealed}9`)).toBeUndefined()
    expect(svc.openProfile(Buffer.alloc(32), userId, profileId, sealed)).toBeUndefined()
  })

  it('a wrong vault key answers undefined, never a wrong object', () => {
    const sealed = svc.sealProfile(created.vaultKey, userId, profileId, secret)
    expect(svc.openProfile(randomBytes(32), userId, profileId, sealed)).toBeUndefined()
  })
})

function segmentChars(value: bigint): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const chars: string[] = []
  for (let i = 0; i < 32; i += 1) {
    const char = alphabet.at(Number(value & 31n)) ?? '0'
    chars.push(char)
    value >>= 5n
  }
  return chars.reverse().reduce<string[]>((groups, c, index) => {
    const at = Math.floor(index / 4)
    groups[at] = `${groups[at] ?? ''}${c}`
    return groups
  }, []).join('-')
}

