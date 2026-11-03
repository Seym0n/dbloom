import { describe, expect, it } from 'vitest'
import { createLogger, levelFromEnv, redactQuery, redactUrl, REDACTED } from '~/server/log'

const capture = (level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
  const lines: string[] = []
  const logger = createLogger({ level: () => level, write: (l) => lines.push(l), now: () => new Date('2026-11-03T00:00:00Z') })
  return { lines, logger }
}
const TOKEN = 'abcDEF0123456789abcDEF0123456789'

describe('logger output', () => {
  it('writes one JSON object per line with time, level, message and fields', () => {
    const { lines, logger } = capture()
    logger.info('hello', { requestId: 'r1', status: 200 })
    expect(JSON.parse(lines[0]!)).toEqual({ t: '2026-11-03T00:00:00.000Z', level: 'info', msg: 'hello', requestId: 'r1', status: 200 })
  })
  it('honours the level', () => {
    const { lines, logger } = capture('warn')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error'])
  })
  it('child adds fields to every line', () => {
    const { lines, logger } = capture()
    logger.child({ requestId: 'abc' }).info('x')
    expect(JSON.parse(lines[0]!).requestId).toBe('abc')
  })
  it('debug in production without allowDebug falls back to info', () => {
    expect(levelFromEnv({ DBLOOM_LOG_LEVEL: 'debug', NODE_ENV: 'production' } as never)).toBe('info')
    expect(levelFromEnv({ DBLOOM_LOG_LEVEL: 'debug', NODE_ENV: 'production', DBLOOM_ALLOW_DEBUG: 'true' } as never)).toBe('debug')
    expect(levelFromEnv({} as never)).toBe('info')
  })
})

describe('redaction', () => {
  it('query values of sensitive keys and token-shaped values are removed, keys stay', () => {
    expect(redactQuery(`?token=abc&page=2&x=${TOKEN}&invite=short`)).toBe(`?token=${REDACTED}&page=2&x=${REDACTED}&invite=${REDACTED}`)
    expect(redactUrl(`/invite?t=${TOKEN}&ok=1#frag`)).toBe(`/invite?t=${REDACTED}&ok=1`)
    expect(redactUrl('/plain/path')).toBe('/plain/path')
  })
  it('secrets in URL, headers, cookies and bodies never reach the output', () => {
    const { lines, logger } = capture()
    const secrets = ['s3cr3t-session-value', 'hunter2-password', TOKEN, 'tok_in_query_1', 'abc.def-bearer']
    logger.info(`GET /setup?token=${secrets[3]}`, {
      url: `/recover?code=${secrets[2]}&x=1`,
      headers: { authorization: `Bearer ${secrets[4]}`, cookie: `__Host-dbloom_session=${secrets[0]}`, host: 'ok.example' },
      body: { password: secrets[1] },
      nested: { 'set-cookie': secrets[0], note: `Authorization: Bearer ${secrets[4]}` },
      error: new Error(`failed for /x?password=${secrets[1]}`),
    })
    const out = lines.join('\n')
    for (const s of secrets) expect(out, s).not.toContain(s)
    expect(out).toContain('ok.example')
    expect(out).toContain(REDACTED)
  })
  it('never throws on cycles', () => {
    const { lines, logger } = capture()
    const a: Record<string, unknown> = {}
    a.self = a
    logger.info('cyc', { a })
    expect(lines).toHaveLength(1)
  })
})
