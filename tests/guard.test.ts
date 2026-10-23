import { afterEach, describe, expect, test, vi } from 'vitest'
import { assertWritable, WriteGuardError } from '~/server/guard/write-guard'
import { createTokenIssuer, hashStatements } from '~/server/guard/confirm-token'
import { runWithTimeout } from '~/server/guard/statement-timeout'
import { auditStructure } from '~/server/audit'
import { loadConfig } from '~/server/config'
import type { Statement, TokenClaims } from '~/server/structure/types'

const stmt = (sql: string): Statement => ({ sql, kind: 'dropTable', class: 'hard', effect: '' })

describe('assertWritable', () => {
  test('allows when neither flag is set', () => {
    expect(() => assertWritable({ forcedReadOnly: false, sessionReadOnly: false })).not.toThrow()
  })
  test.each([
    [true, false],
    [false, true],
    [true, true],
  ])('refuses forced=%s session=%s with neutral text', (forcedReadOnly, sessionReadOnly) => {
    try {
      assertWritable({ forcedReadOnly, sessionReadOnly })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(WriteGuardError)
      expect((e as WriteGuardError).code).toBe('read-only')
      expect((e as Error).message).toBe('This connection is read-only.')
    }
  })
})

describe('hashStatements', () => {
  test('is stable and not fooled by concatenation', () => {
    expect(hashStatements([stmt('a'), stmt('bc')])).toBe(hashStatements([stmt('a'), stmt('bc')]))
    expect(hashStatements([stmt('a'), stmt('bc')])).not.toBe(
      hashStatements([stmt('ab'), stmt('c')]),
    )
    expect(hashStatements([stmt('ab')])).not.toBe(hashStatements([stmt('a'), stmt('b')]))
    expect(hashStatements([])).not.toBe(hashStatements([stmt('')]))
    expect(hashStatements([stmt('x')])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('confirmation token', () => {
  const now = 1_000_000
  const claims: TokenClaims = {
    sessionId: 's1',
    target: 'h:3306',
    planId: 'plan-1',
    statementsHash: 'abc',
    expiresAt: now + 60_000,
  }
  const expected: Omit<TokenClaims, 'expiresAt'> = { ...claims }
  delete (expected as Partial<TokenClaims>).expiresAt
  const code = (fn: () => void) => {
    try {
      fn()
    } catch (e) {
      return (e as WriteGuardError).code
    }
    return 'none'
  }

  test('valid token verifies once, then is used', () => {
    const t = createTokenIssuer()
    const tok = t.issue(claims)
    expect(code(() => t.verifyAndConsume(tok, expected, now))).toBe('none')
    expect(code(() => t.verifyAndConsume(tok, expected, now))).toBe('token-used')
  })

  test('missing and malformed', () => {
    const t = createTokenIssuer()
    expect(code(() => t.verifyAndConsume(undefined, expected, now))).toBe('token-missing')
    expect(code(() => t.verifyAndConsume('', expected, now))).toBe('token-missing')
    for (const bad of ['x', 'a.b', 'a.b.c', '.', '!!!.???', 'e30.e30']) {
      expect(code(() => t.verifyAndConsume(bad, expected, now))).toBe('token-invalid')
    }
  })

  test('tampering with payload or signature fails', () => {
    const t = createTokenIssuer()
    const [p, s] = t.issue(claims).split('.') as [string, string]
    const flip = (x: string) => (x[0] === 'A' ? 'B' : 'A') + x.slice(1)
    expect(code(() => t.verifyAndConsume(`${flip(p)}.${s}`, expected, now))).toBe('token-invalid')
    expect(code(() => t.verifyAndConsume(`${p}.${flip(s)}`, expected, now))).toBe('token-invalid')
    expect(code(() => t.verifyAndConsume(`${p}.`, expected, now))).toBe('token-invalid')
  })

  test('token from another issuer (other key) fails', () => {
    const tok = createTokenIssuer().issue(claims)
    expect(code(() => createTokenIssuer().verifyAndConsume(tok, expected, now))).toBe(
      'token-invalid',
    )
  })

  test('same secret verifies across issuers', () => {
    const secret = Buffer.alloc(32, 7)
    const tok = createTokenIssuer(secret).issue(claims)
    expect(code(() => createTokenIssuer(secret).verifyAndConsume(tok, expected, now))).toBe('none')
  })

  test('expiry uses the injected clock', () => {
    const t = createTokenIssuer()
    const tok = t.issue(claims)
    expect(code(() => t.verifyAndConsume(tok, expected, claims.expiresAt))).toBe('token-expired')
    expect(code(() => t.verifyAndConsume(tok, expected, claims.expiresAt + 1))).toBe(
      'token-expired',
    )
    expect(code(() => t.verifyAndConsume(tok, expected, claims.expiresAt - 1))).toBe('none')
  })

  test.each([
    ['session', { sessionId: 's2' }],
    ['target', { target: 'other:3306' }],
    ['plan', { planId: 'plan-2' }],
    ['statements hash', { statementsHash: 'abd' }],
  ])('token for another %s fails and is not consumed', (_n, over) => {
    const t = createTokenIssuer()
    const tok = t.issue(claims)
    expect(code(() => t.verifyAndConsume(tok, { ...expected, ...over }, now))).toBe('token-invalid')
    expect(t.consumedCount()).toBe(0)
    expect(code(() => t.verifyAndConsume(tok, expected, now))).toBe('none')
  })

  test('consumed memory is bounded and expired ids are dropped', () => {
    const t = createTokenIssuer()
    for (let i = 0; i < 10_050; i++) {
      const c = { ...claims, planId: `p${i}`, expiresAt: now + 10_000_000 }
      t.verifyAndConsume(t.issue(c), { ...expected, planId: `p${i}` }, now)
    }
    expect(t.consumedCount()).toBeLessThanOrEqual(10_000)

    const t2 = createTokenIssuer()
    t2.verifyAndConsume(t2.issue(claims), expected, now)
    expect(t2.consumedCount()).toBe(1)
    const other = { ...claims, planId: 'q', expiresAt: claims.expiresAt + 100_000 }
    t2.verifyAndConsume(t2.issue(other), { ...expected, planId: 'q' }, claims.expiresAt + 1)
    expect(t2.consumedCount()).toBe(1)
  })
})

describe('auditStructure', () => {
  afterEach(() => vi.restoreAllMocks())

  test('logs one JSON line with the hash and no literal', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const sql = "ALTER TABLE `d`.`t` ADD COLUMN `c` VARCHAR(10) DEFAULT 'S3CRET-LITERAL'"
    auditStructure({
      user: 'root',
      target: 'h:3306',
      kind: 'alterTable',
      class: 'soft',
      statementHash: hashStatements([stmt(sql)]),
      outcome: 'executed',
      durationMs: 12,
    })
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0]![0])
    expect(line).not.toContain('S3CRET-LITERAL')
    expect(line).not.toContain('ALTER')
    const o = JSON.parse(line)
    expect(o.audit).toBe('structure.statement')
    expect(Object.keys(o).sort()).toEqual(
      [
        'audit',
        'class',
        'durationMs',
        'kind',
        'outcome',
        'statementHash',
        't',
        'target',
        'user',
      ].sort(),
    )
    expect(o.statementHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('includes errno on failure', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    auditStructure({
      user: 'u',
      target: 't',
      kind: 'dropTable',
      class: 'hard',
      statementHash: 'h',
      outcome: 'failed',
      errno: 1051,
    })
    expect(JSON.parse(String(log.mock.calls[0]![0])).errno).toBe(1051)
  })
})

describe('config', () => {
  const env = { DBLOOM_DIRECT_FREE_FORM_ACK: 'true' }
  test('defaults', () => {
    const c = loadConfig(env)
    expect(c.readOnly).toBe(false)
    expect(c.statementTimeoutMs).toBe(30_000)
  })
  test('read-only and timeout from env', () => {
    const c = loadConfig({ ...env, DBLOOM_READ_ONLY: '1', DBLOOM_STATEMENT_TIMEOUT_SECONDS: '5' })
    expect(c.readOnly).toBe(true)
    expect(c.statementTimeoutMs).toBe(5000)
  })
  test.each(['0', '-3', 'abc'])('rejects timeout %s', (v) => {
    expect(() => loadConfig({ ...env, DBLOOM_STATEMENT_TIMEOUT_SECONDS: v })).toThrow(
      /DBLOOM_STATEMENT_TIMEOUT_SECONDS/,
    )
  })
})

describe('runWithTimeout argument checks', () => {
  test.each([0, -1, Number.NaN])('rejects timeout %s', async (ms) => {
    await expect(runWithTimeout({} as never, {} as never, ms, 'SELECT 1')).rejects.toMatchObject({
      code: 'invalid-timeout',
    })
  })
})
