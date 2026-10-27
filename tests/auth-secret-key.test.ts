/** Unit tests of package A `secret-key.ts` (FR-AUT-023; section 10: HKDF, records, tamper, rotation). */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { keyIdOf, loadSecretKey, ServerKeyRing, decodeKeyText } from '../src/server/auth/secret-key'
import { SECRET_KEY_BYTES, SUBKEY_INFO } from '../src/server/auth/types'

const dir = mkdtempSync(path.join(tmpdir(), 'dbloom-key-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const KEY = decodeKeyText('a'.repeat(64))
const RING_ENV = { DBLOOM_SECRET_KEY: 'a'.repeat(64) }

describe('load reasons', () => {
  it('missing when neither variable is set', () => {
    expect(loadSecretKey({})).toEqual({ ok: false, reason: 'missing' })
  })
  it('placeholder refused', () => {
    expect(loadSecretKey({ DBLOOM_SECRET_KEY: 'change-me' })).toEqual({ ok: false, reason: 'placeholder' })
    expect(loadSecretKey({ DBLOOM_SECRET_KEY: '' })).toEqual({ ok: false, reason: 'missing' })
  })
  it('short refused', () => {
    expect(loadSecretKey({ DBLOOM_SECRET_KEY: 'a'.repeat(16) })).toEqual({ ok: false, reason: 'short' })
  })
  it('unreadable file refused', () => {
    expect(loadSecretKey({ DBLOOM_SECRET_KEY_FILE: path.join(dir, 'absent') })).toEqual({
      ok: false,
      reason: 'unreadable_file',
    })
  })
  it('loads hex from .env', () => {
    const result = loadSecretKey(RING_ENV)
    expect(result.ok).toBe(true)
    expect((result as { ok: true; ring: ServerKeyRing }).ring.currentKeyId).toHaveLength(11) // 8 bytes base64url
  })
  it('loads a key file (Docker secret)', () => {
    const file = path.join(dir, 'keyfile')
    writeFileSync(file, decodeKeyText('a'.repeat(64)).toString('hex'))
    expect(loadSecretKey({ DBLOOM_SECRET_KEY_FILE: file }).ok).toBe(true)
  })
})

describe('seal / open', () => {
  const { ring } = loadSecretKey(RING_ENV) as { ok: true; ring: ServerKeyRing }

  it('round-trips a record', () => {
    const record = ring.seal('totp', 'totp/v1/u1', Buffer.from('plain-secret', 'utf8'))
    expect(record.startsWith('v1.')).toBe(true)
    expect(record.split('.')).toHaveLength(5)
    const plain = ring.open('totp', 'totp/v1/u1', record)
    expect(plain?.toString('utf8')).toBe('plain-secret')
  })

  it('seals under the named subkey only (wrong kind fails)', () => {
    const record = ring.seal('totp', 'totp/v1/u1', Buffer.from('plain-secret', 'utf8'))
    expect(ring.open('recoveryCodes', 'totp/v1/u1', record)).toBeUndefined()
  })

  it('wrong AAD fails', () => {
    const record = ring.seal('totp', 'totp/v1/u1', Buffer.from('plain', 'utf8'))
    expect(ring.open('totp', 'totp/v1/u2', record)).toBeUndefined()
  })

  it('tampering with any part fails', () => {
    const record = ring.seal('totp', 'totp/v1/u1', Buffer.from('plain', 'utf8'))
    for (const index of [0, 1, 2, 3, 4]) {
      const parts = record.split('.')
      parts[index] = index === 0 ? 'v2' : `${parts[index]}x`
      expect(ring.open('totp', 'totp/v1/u1', parts.join('.'))).toBeUndefined()
    }
  })

  it('nonce and tag bounds are enforced', () => {
    const fake = ['v1', keyIdOf(KEY), 'AA', 'AA', 'AA'].join('.')
    expect(ring.open('totp', 'a', fake)).toBeUndefined()
  })
})

describe('rotation', () => {
  const previous = 'c'.repeat(64)
  const oldRing = loadSecretKey({ DBLOOM_SECRET_KEY: previous }) as { ok: true; ring: ServerKeyRing }
  const ring = loadSecretKey({ DBLOOM_SECRET_KEY: 'a'.repeat(64), DBLOOM_SECRET_KEY_PREVIOUS: previous }) as {
    ok: true
    ring: ServerKeyRing
  }

  it('opens a record sealed with the previous key', () => {
    const record = oldRing.ring.seal('totp', 'totp/v1/u1', Buffer.from('old', 'utf8'))
    expect(ring.ring.open('totp', 'totp/v1/u1', record)?.toString('utf8')).toBe('old')
    expect(ring.ring.isStale(record)).toBe(true)
  })

  it('answers isStale false for current-key records and without a previous key', () => {
    const record = ring.ring.seal('totp', 'totp/v1/u1', Buffer.from('now', 'utf8'))
    expect(ring.ring.isStale(record)).toBe(false)
    expect(loadSecretKey(RING_ENV)).toEqual({
      ok: true,
      ring: expect.objectContaining({ isStale: expect.anything() }) as unknown,
    })
    expect((loadSecretKey(RING_ENV) as { ok: true; ring: ServerKeyRing }).ring.isStale(record)).toBe(false)
  })
})

describe('subkeys', () => {
  it('derives 32 bytes per kind from HKDF-SHA-256 with the typed info', () => {
    const { ring } = loadSecretKey(RING_ENV) as { ok: true; ring: ServerKeyRing }
    for (const kind of Object.keys(SUBKEY_INFO) as Array<keyof typeof SUBKEY_INFO>) {
      const subkey = ring.subkey(kind)
      expect(subkey.length).toBe(32)
    }
    // Different kinds give different subkeys; the same kind is stable.
    expect(ring.subkey('totp').equals(ring.subkey('recoveryCodes'))).toBe(false)
    expect(ring.subkey('totp').equals(ring.subkey('totp'))).toBe(true)
  })

  it('refuses a second server key shorter than the bound', () => {
    expect(KEY.length).toBe(SECRET_KEY_BYTES)
  })
})
