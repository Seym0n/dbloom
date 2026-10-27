/** Unit tests of package A `password.ts` (FR-AUT-005; section 10). */
import { describe, expect, it } from 'vitest'
import { ARGON2_LOGIN_DEFAULT, ARGON2_LOGIN_MIN, ARGON2_TAG_BYTES, PASSWORD_MAX_CHARS } from '../src/server/auth/types'
import { createPasswordService, encodePhc, parsePhc } from '../src/server/auth/password'
import { breachedListService } from '../src/server/auth/breached'
import { SECRET_PLACEHOLDER } from '../src/server/auth/types'

const svc = createPasswordService(await breachedListService(null))
const ctx = { username: 'walther', minLength: 12, breachedCheck: true, failClosed: false }

describe('normalisation (PASSWORD_NORMALISATION)', () => {
  it('applies NFC (decided 2026-10-27)', () => {
    // U+FB01 ligature: NFKC would give 'fi', NFC keeps it.
    expect(svc.normalise('\uFB01')).toBe('\uFB01')
    // Composed and decomposed '\u00E9' hash to the same secret.
    expect(svc.normalise('e\u0301')).toBe('\u00E9')
  })
})

describe('policy check', () => {
  it('accepts a strong password and reports the missing list', async () => {
    // The bundled list is not shipped yet, so an unavailable list is reported even on accept.
    expect(await svc.check('r9!QkeL2sXvN', ctx)).toEqual({ reason: null, breachedListUnavailable: true })
  })
  it('rejects too short', async () => {
    expect((await svc.check('abc', ctx)).reason).toBe('too_short')
  })
  it('honours the caller minLength', async () => {
    expect((await svc.check('r9!QkeL2sXvN', { ...ctx, minLength: 16 })).reason).toBe('too_short')
  })
  it('rejects username containment', async () => {
    expect((await svc.check('r9!QwaltherkeL2', ctx)).reason).toBe('contains_username')
  })
  it('skips the breached check when breachedCheck is off', async () => {
    expect(await svc.check('r9!QkeL2sXvN', { ...ctx, breachedCheck: false })).toEqual({
      reason: null,
      breachedListUnavailable: false,
    })
  })
  it('fails closed on an unavailable list when asked', async () => {
    expect(await svc.check('r9!QkeL2sXvN', { ...ctx, failClosed: true })).toEqual({
      reason: 'breached',
      breachedListUnavailable: true,
    })
  })
  it('rejects above the length bound', async () => {
    expect((await svc.check('x'.repeat(PASSWORD_MAX_CHARS + 1), ctx)).reason).toBe('too_long')
  })
  it('rejects a long multi-byte password above the byte bound', async () => {
    // 400 code points, 1200 bytes when each is 3 bytes.
    const pw = '\u4e00'.repeat(400)
    expect((await svc.check(pw, ctx)).reason).toBe('too_long')
  })
})

describe('Argon2id PHC', () => {
  it('hashes and verifies a password', async () => {
    const phc = await svc.hash('r9!QkeL2sXvN', ARGON2_LOGIN_MIN)
    expect(phc.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true)
    expect(await svc.verify(phc, 'r9!QkeL2sXvN')).toBe(true)
    expect(await svc.verify(phc, 'r9!QkeL2sXvO')).toBe(false)
    expect(await svc.verify(phc, '')).toBe(false)
  })

  it('encodes and parses a PHC string (salt 16 B, tag 32 B)', () => {
    const salt = Buffer.alloc(16, 7)
    const tag = Buffer.alloc(ARGON2_TAG_BYTES, 9)
    const parsed = parsePhc(encodePhc(tag, salt, ARGON2_LOGIN_DEFAULT))
    expect(parsed?.params).toEqual(ARGON2_LOGIN_DEFAULT)
    expect(parsed?.salt.equals(salt)).toBe(true)
    expect(parsed?.tag.equals(tag)).toBe(true)
  })

  it('refuses a malformed PHC', () => {
    expect(parsePhc('not-a-phc')).toBeUndefined()
    expect(parsePhc('$argon2i$v=19$m=1,t=1,p=1$dGVzdA==$dGVzdA==$x')).toBeUndefined()
  })

  it('refuses a PHC with unbounded or unsafe Argon2 parameters', async () => {
    const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64').replace(/=+$/, '')
    const make = (params: string) => `$argon2id$v=19$${params}$${b64(16)}$${b64(32)}`
    for (const params of [
      `m=${'9'.repeat(400)},t=3,p=1`, // Number() gives Infinity
      'm=4194304,t=3,p=1',
      'm=65536,t=100000,p=1',
      'm=65536,t=3,p=1000',
      'm=65536,t=0,p=1',
      'm=4,t=3,p=1',
    ]) {
      expect(parsePhc(make(params)), params).toBeUndefined()
    }
    expect(parsePhc(make('m=65536,t=3,p=1'))).toBeDefined()
    // verify() treats it as an invalid record: false, no internal error.
    expect(await svc.verify(make(`m=${'9'.repeat(400)},t=3,p=1`), 'whatever-password')).toBe(false)
  })

  it('needs a rehash when stored parameters are weaker', async () => {
    const weak = await svc.hash('r9!QkeL2sXvN', ARGON2_LOGIN_MIN)
    expect(svc.needsRehash(weak, ARGON2_LOGIN_DEFAULT)).toBe(true)
    const current = await svc.hash('r9!QkeL2sXvN', ARGON2_LOGIN_DEFAULT)
    expect(svc.needsRehash(current, ARGON2_LOGIN_DEFAULT)).toBe(false)
    expect(svc.needsRehash('broken', ARGON2_LOGIN_DEFAULT)).toBe(true)
  })
})

describe('dummy verify', () => {
  it('answers false every time', async () => {
    expect(await svc.dummyVerify('r9!QkeL2sXvN')).toBe(false)
    expect(await svc.dummyVerify('wrong')).toBe(false)
  })
})

describe('secret wrapper', () => {
  it('stringifies and JSONifies as [secret]; reveal gets the value back', async () => {
    const { secret, reveal } = await import('../src/server/auth/secret')
    const value = secret('top-secret')
    expect(`${value}`).toBe(SECRET_PLACEHOLDER)
    expect(JSON.stringify({ value })).toBe('{"value":"[secret]"}')
    expect(reveal(value)).toBe('top-secret')
  })

  it('refuses reveal of a foreign object', async () => {
    const { reveal } = await import('../src/server/auth/secret')
    expect(() => reveal({} as never)).toThrow()
  })
})
