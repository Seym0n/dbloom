/** SPEC/32 task 4: login notice and banner as the server hands them out; the functions that stay open during maintenance. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeSetting } from '../src/server/auth/settings'
import { AUTH_SETTINGS, INFO_BANNER_MAX, LOGIN_NOTICE_MAX } from '../src/server/auth/types'

describe('login notice from the environment (direct mode has no stored settings)', () => {
  it('is empty by default and plain text when set', () => {
    expect(computeSetting('loginNotice', undefined, {}).effective).toBe('')
    expect(computeSetting('loginNotice', undefined, { DBLOOM_LOGIN_NOTICE: 'Planned work' }).effective).toBe('Planned work')
  })
  it('markup stays text: nothing is parsed, stripped or escaped on the server', () => {
    expect(computeSetting('loginNotice', undefined, { DBLOOM_LOGIN_NOTICE: '<b>hi</b> & "bye"' }).effective).toBe('<b>hi</b> & "bye"')
    expect(computeSetting('loginNotice', undefined, { DBLOOM_LOGIN_NOTICE: '123' }).effective).toBe('123')
  })
  it('a stored text overrides the environment default', () => {
    expect(computeSetting('loginNotice', JSON.stringify('stored'), { DBLOOM_LOGIN_NOTICE: 'env' }).effective).toBe('stored')
  })
})

describe('limits', () => {
  it('the notice allows 300 characters, the banner 500', () => {
    expect([LOGIN_NOTICE_MAX, INFO_BANNER_MAX]).toEqual([300, 500])
    expect(AUTH_SETTINGS.loginNotice.schema.safeParse('x'.repeat(300)).success).toBe(true)
    expect(AUTH_SETTINGS.loginNotice.schema.safeParse('x'.repeat(301)).success).toBe(false)
    expect(AUTH_SETTINGS.infoBanner.schema.safeParse('x'.repeat(500)).success).toBe(true)
    expect(AUTH_SETTINGS.infoBanner.schema.safeParse('x'.repeat(501)).success).toBe(false)
  })
})

describe('what stays open during maintenance (the exempt list is the set of public functions)', () => {
  const block = (file: string, name: string) => {
    const src = readFileSync(file, 'utf8')
    const start = src.indexOf(`export const ${name} =`)
    expect(start, `${name} in ${file}`).toBeGreaterThan(-1)
    const next = src.indexOf('\nexport const ', start + 1)
    return src.slice(start, next === -1 ? undefined : next)
  }
  it.each([
    ['src/server/auth.functions.ts', 'signOut'],
    ['src/server/auth.functions.ts', 'getLoginPageInfo'],
    ['src/server/auth.functions.ts', 'passwordSignIn'],
    ['src/server/session.functions.ts', 'getSessionInfo'],
  ])('%s %s uses the public middleware, which has no maintenance check', (file, name) => {
    expect(block(file, name)).toContain('.middleware([publicMiddleware])')
  })

  it('every account and target middleware carries the check, and so do the raw route resolvers', () => {
    expect(readFileSync('src/server/middleware.ts', 'utf8')).toContain('assertNotInMaintenance(getRuntime(), context.user)')
    expect(readFileSync('src/server/session-context.ts', 'utf8')).toContain('assertNotInMaintenance(runtime, resolved.user)')
    expect(readFileSync('src/server/prefs.functions.ts', 'utf8')).toContain('assertNotInMaintenance(getRuntime(), account.user)')
    for (const f of ['src/server/rows/http.ts', 'src/server/io/http.ts']) expect(readFileSync(f, 'utf8')).toContain('error instanceof AuthError')
  })

  it('the health and readiness probes are not behind it', () => {
    for (const f of ['src/server/lifecycle/ready-response.ts', 'src/server/lifecycle/readiness.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/maintenance/i)
    }
  })
})
