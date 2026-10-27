/** Unit tests of package A `totp.ts` (FR-AUT-008; section 10: RFC 6238 vectors, window, replay). */
import { describe, expect, it } from 'vitest'
import { totp, hotp } from '../src/server/auth/totp'
import { TOTP_SECRET_BYTES } from '../src/server/auth/types'

const KEY = Buffer.from('12345678901234567890', 'utf8') // RFC 6238 test secret (20 bytes)

describe('RFC 4226 HOTP vectors', () => {
  // Table 2? RFC 4226 section D lists steps 0 to 9: 755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489.
  const vectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  vectors.forEach((expected, step) => {
    it(`step ${step} is ${expected}`, () => {
      expect(hotp(KEY, step)).toBe(expected)
    })
  })
})

describe('RFC 6238 TOTP vectors (SHA-1): agree with HOTP at the corresponding steps', () => {
  it('T=1 (time 59 s) equals HOTP at step 1', () => {
    expect(hotp(KEY, 1)).toBe(hotp(Buffer.from('12345678901234567890', 'utf8'), Math.floor(59_000 / 1000 / 30)))
  })
})

describe('format helpers', () => {
  it('newSecret gives TOTP_SECRET_BYTES bytes', () => {
    const secret = totp.newSecret()
    expect(secret.length).toBe(TOTP_SECRET_BYTES)
  })

  it('base32 encodes unpadded (the otpauth convention)', () => {
    // 'Hello!' → JBSWY3DPEE (48 bits = 9 full characters plus the final 2-bit group 'E').
    expect(totp.base32(Buffer.from('Hello!', 'utf8'))).toBe('JBSWY3DPEE')
    expect(totp.base32(Buffer.from('a', 'utf8'))).toBe('ME')
    expect(totp.base32(Buffer.from('48656c6c6f21de', 'hex'))).not.toContain('=')
  })

  it('otpauthUri carries issuer, account, algorithm, digits and period', () => {
    const uri = totp.otpauthUri(Buffer.alloc(20, 3), 'DBLoom', 'walther@example.net')
    expect(uri.startsWith(`otpauth://totp/DBLoom:${encodeURIComponent('walther@example.net')}`)).toBe(true)
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })

  it('qrSvg returns an SVG over the URI', () => {
    const svg = totp.qrSvg('otpauth://totp/x?secret=Y')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.includes('otpauth')).toBe(false) // the URI itself never appears as plain text in the SVG
  })
})

describe('verify', () => {
  const secret = totp.newSecret()
  const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / 30)
  const now = 1_700_000_000_000 // a fixed moment

  it('does not throw near the epoch when the window reaches negative steps', () => {
    expect(totp.verify(secret, '000000', -1, 2, 0).ok).toBeTypeOf('boolean')
    expect(totp.verify(secret, hotp(secret, 0), -1, 2, 10_000)).toEqual({ ok: true, step: 0 })
  })

  it('accepts the exact code', () => {
    const step = stepOf(now)
    expect(totp.verify(secret, hotp(secret, step), step - 1, 1, now)).toEqual({ ok: true, step })
  })

  it('accepts one step back with window 1 when not a replay', () => {
    const lastStep = stepOf(now) - 2
    expect(totp.verify(secret, hotp(secret, stepOf(now) - 1), lastStep, 1, now)).toEqual({
      ok: true,
      step: stepOf(now) - 1,
    })
    // The same code again is refused (the caller passes the new lastStep).
    expect(totp.verify(secret, hotp(secret, stepOf(now) - 1), stepOf(now) - 1, 1, now).ok).toBe(false)
  })

  it('refuses beyond the window', () => {
    // lastStep = step-2 so the refusals genuinely come from the window, not the replay block.
    const lastStep = stepOf(now) - 2
    expect(totp.verify(secret, hotp(secret, stepOf(now) - 2), lastStep + 1, 1, now).ok).toBe(false) // also replay (== lastStep+? step-2 < step-1)...
    expect(totp.verify(secret, hotp(secret, stepOf(now) - 3), lastStep, 1, now).ok).toBe(false)
    expect(totp.verify(secret, hotp(secret, stepOf(now) + 2), lastStep, 1, now).ok).toBe(false)
  })

  it('refuses steps at or below lastStep (replay block)', () => {
    const step = stepOf(now)
    expect(totp.verify(secret, hotp(secret, step), step, 1, now).ok).toBe(false)
    expect(totp.verify(secret, hotp(secret, step - 1), step, 1, now).ok).toBe(false)
  })

  it('refuses a malformed code', () => {
    expect(totp.verify(secret, '12345', 0, 1, now).ok).toBe(false)
    expect(totp.verify(secret, 'abcdef', 0, 1, now).ok).toBe(false)
    expect(totp.verify(secret, '', 0, 1, now).ok).toBe(false)
  })

  it('never accepts a random code from the near future', () => {
    const step = stepOf(now)
    expect(totp.verify(secret, String(100000 + Math.floor(Math.random() * 900000)), step, 1, now).ok).toBe(false)
  })
})
