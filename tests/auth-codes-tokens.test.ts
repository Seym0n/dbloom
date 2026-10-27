/** Unit tests of package A `codes.ts` and `tokens.ts` (FR-AUT-010, 002, 015, 016; section 10: formats). */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRecoveryCodeService } from '../src/server/auth/codes'
import { tokens as authTokens } from '../src/server/auth/tokens'
import { loadSecretKey } from '../src/server/auth/secret-key'
import { LINK_TOKEN_CHARS, RECOVERY_CODE_COUNT } from '../src/server/auth/types'

const svc = createRecoveryCodeService(
  (loadSecretKey({ DBLOOM_SECRET_KEY: 'a'.repeat(64) }) as { ok: true; ring: import('../src/server/auth/types').SecretKeyRing }).ring,
)

describe('recovery codes', () => {
  it('generates RECOVERY_CODE_COUNT codes in display format', () => {
    const codes = svc.generate()
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(new Set(codes.map((c) => c.replace(/-/g, ''))).size).toBe(RECOVERY_CODE_COUNT)
  })

  it('only Crockford alphabet characters appear (no I, L, O, U)', () => {
    for (const code of svc.generate()) {
      expect(/[ILOU]/.test(code.replace(/-/g, ''))).toBe(false)
    }
  })

  it('normalise strips separators, uppercases and applies substitutions', () => {
    const [code = ''] = svc.generate()
    expect(svc.normalise(code.replace(/-/g, ' '))).not.toBeUndefined()
  })

  it('normalise is undefined for malformed input', () => {
    expect(svc.normalise('short')).toBeUndefined()
  })

  it('mac is deterministic per user and code and hex', () => {
    const macA = svc.mac('u1', 'AAAAAAAAAAAA')
    expect(macA).toMatch(/^[0-9a-f]{64}$/)
    expect(svc.mac('u1', 'AAAAAAAAAAAA')).toBe(macA)
    expect(svc.mac('u2', 'AAAAAAAAAAAA')).not.toBe(macA)
  })
})

describe('setup token', () => {
  it('is 32 Crockford characters in groups of four', () => {
    const token = authTokens.newSetupToken()
    expect(token).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)
    expect(/[ILOU]/.test(token.replace(/-/g, ''))).toBe(false)
  })

  it('normalise treats case, spaces and dashes as equivalent', () => {
    const token = authTokens.newSetupToken()
    const spaced = token.replace(/-/g, ' ').toLowerCase()
    expect(authTokens.normaliseSetupToken(spaced)).toBe(authTokens.normaliseSetupToken(token.replace(/-/g, ' ')))
  })
})

describe('link tokens', () => {
  it('newLinkToken is base64url of LINK_TOKEN_BYTES', () => {
    const link = authTokens.newLinkToken()
    expect(link).toHaveLength(LINK_TOKEN_CHARS)
    expect(/^[A-Za-z0-9_-]+$/.test(link)).toBe(true)
  })

  it('hashToken is SHA-256 hex of the token', () => {
    const link = 'x'.repeat(LINK_TOKEN_CHARS)
    const expected = createHash('sha256').update(link, 'utf8').digest('hex')
    expect(authTokens.hashToken(link)).toBe(expected)
  })

  it('equalHashes compares equal and unequal hashes without exceptions', () => {
    const a = authTokens.hashToken('token-text')
    expect(authTokens.equalHashes(a, a)).toBe(true)
    expect(authTokens.equalHashes(a, authTokens.hashToken('other'))).toBe(false)
    expect(authTokens.equalHashes(a, 'short')).toBe(false)
  })

  it('newConnectionId is 22 base64url characters', () => {
    expect(authTokens.newConnectionId()).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
})
