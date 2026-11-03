import { describe, expect, it } from 'vitest'
import { evaluateGate, originAllowed, serverFunctionName, isCredentialFunction, routeClassOf } from '~/server/net/gate'
import { cfg, req } from './gate-fixtures'

const deny = (r: ReturnType<typeof evaluateGate>) => (r.ok ? null : { status: r.status, body: r.body, reason: r.reason })

describe('gate: Host', () => {
  it('allowed Host passes and returns the client address once', () => {
    const r = evaluateGate(req({ headers: { 'x-forwarded-for': '203.0.113.9' } }), cfg())
    expect(r).toMatchObject({ ok: true, clientAddress: '203.0.113.9', scheme: 'https' })
  })

  it.each(['evil.example', 'db.example.org.evil.example', 'db.example.org:8443', 'a b', 'db.example.org@evil'])(
    'forged Host %j gets 421 with an empty body',
    (host) => {
      const r = evaluateGate(req({ headers: { host } }), cfg())
      expect(deny(r)).toEqual({ status: 421, body: '', reason: 'host' })
    },
  )

  it('missing Host gets 421', () => {
    const r = req()
    r.headers.delete('host')
    expect(deny(evaluateGate(r, cfg()))?.status).toBe(421)
  })

  it('X-Forwarded-Host and Forwarded never rescue a forged Host', () => {
    const r = evaluateGate(
      req({ headers: { host: 'evil.example', 'x-forwarded-host': 'db.example.org', forwarded: 'host=db.example.org' } }),
      cfg(),
    )
    expect(deny(r)?.status).toBe(421)
  })

  it('the refused value is never echoed', () => {
    const r = evaluateGate(req({ headers: { host: 'secret-marker.evil' } }), cfg())
    expect(JSON.stringify(r)).not.toContain('secret-marker')
  })

  it('applies to every route class and method', () => {
    for (const pathname of ['/', '/assets/x.js', '/_serverFn/auth.functions.passwordSignIn', '/api/rows/upload', '/api/startup']) {
      for (const method of ['GET', 'POST', 'HEAD', 'PUT']) {
        expect(deny(evaluateGate(req({ pathname, method, headers: { host: 'evil.example' } }), cfg()))?.status).toBe(421)
      }
    }
  })
})

describe('gate: probe hosts', () => {
  const probe = (over: Parameters<typeof req>[0] = {}) =>
    evaluateGate(req({ pathname: '/api/health', peer: '127.0.0.1', ...over, headers: { host: 'localhost:3000', ...over.headers } }), cfg())

  it('probe host + probe peer + /api/health passes', () => expect(probe().ok).toBe(true))
  it('probe host from a non-probe peer is refused', () => expect(deny(probe({ peer: '203.0.113.5' }))?.status).toBe(421))
  it('probe host on another path is refused', () => expect(deny(probe({ pathname: '/api/startup' }))?.status).toBe(421))
  it('probe host with POST is refused', () => expect(deny(probe({ method: 'POST' }))?.status).toBe(421))
  it('non-probe host is refused on /api/health', () =>
    expect(deny(probe({ headers: { host: 'evil.example' } }))?.status).toBe(421))
})

describe('gate: OPTIONS and CORS', () => {
  it('OPTIONS gets 405 on every class, even for an allowed Host', () => {
    for (const pathname of ['/', '/_serverFn/x.y', '/api/health']) {
      const r = evaluateGate(
        req({ method: 'OPTIONS', pathname, headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }),
        cfg(),
      )
      expect(deny(r)).toEqual({ status: 405, body: '', reason: 'method' })
    }
  })
  it('a forged Host on OPTIONS is still 421 (host first)', () =>
    expect(deny(evaluateGate(req({ method: 'OPTIONS', headers: { host: 'evil.example' } }), cfg()))?.status).toBe(421))
})

describe('gate: effective scheme (FR-SVR-004)', () => {
  const http = { 'x-forwarded-proto': 'http' }
  it('refuses a credential function when the trusted proxy says http', () => {
    const r = evaluateGate(
      req({ method: 'POST', pathname: '/_serverFn/auth.functions.passwordSignIn', headers: { ...http, origin: 'https://db.example.org' } }),
      cfg(),
    )
    expect(deny(r)).toEqual({ status: 403, body: 'insecure_scheme', reason: 'scheme' })
  })
  it.each(['/setup', '/setup/', '/invite', '/recover'])('refuses the page %s', (pathname) =>
    expect(deny(evaluateGate(req({ pathname, headers: http }), cfg()))?.reason).toBe('scheme'))
  it('refuses setup functions by prefix', () =>
    expect(
      deny(evaluateGate(req({ method: 'POST', pathname: '/_serverFn/setup.functions.setupSaveStep', headers: http }), cfg()))?.reason,
    ).toBe('scheme'))
  it('refuses a function whose name cannot be read (fail closed)', () =>
    expect(deny(evaluateGate(req({ method: 'POST', pathname: '/_serverFn/', headers: http }), cfg()))?.reason).toBe('scheme'))
  it('lets non-credential functions and plain pages through', () => {
    const ok = evaluateGate(
      req({ method: 'POST', pathname: '/_serverFn/browse.functions.getTables', headers: { ...http, origin: 'https://db.example.org' } }),
      cfg(),
    )
    expect(ok.ok).toBe(true)
    expect(evaluateGate(req({ pathname: '/', headers: http }), cfg()).ok).toBe(true)
  })
  it('an untrusted peer cannot trigger the mismatch (header ignored)', () => {
    expect(evaluateGate(req({ peer: '203.0.113.5', pathname: '/setup', headers: http }), cfg()).ok).toBe(true)
  })
  it('https from the proxy is fine', () =>
    expect(evaluateGate(req({ pathname: '/setup', headers: { 'x-forwarded-proto': 'https' } }), cfg()).ok).toBe(true))
})

describe('gate: origin check (FR-SVR-006)', () => {
  const post = (headers: Record<string, string>, pathname = '/api/rows/upload') =>
    evaluateGate(req({ method: 'POST', pathname, headers }), cfg())
  it('matching Origin passes', () => expect(post({ origin: 'https://db.example.org' }).ok).toBe(true))
  it('Origin case is normalised', () => expect(post({ origin: 'HTTPS://DB.example.org' }).ok).toBe(true))
  it.each([['https://evil.example'], ['null'], ['http://db.example.org'], ['https://db.example.org:444'], ['']])(
    'Origin %j is refused',
    (origin) => expect(deny(post({ origin }))).toEqual({ status: 403, body: 'forbidden_origin', reason: 'origin' }),
  )
  it('missing Origin without Sec-Fetch-Site is refused', () => expect(post({}).ok).toBe(false))
  it('Sec-Fetch-Site same-origin or none passes without Origin', () => {
    expect(post({ 'sec-fetch-site': 'same-origin' }).ok).toBe(true)
    expect(post({ 'sec-fetch-site': 'none' }).ok).toBe(true)
  })
  it.each(['cross-site', 'same-site'])('Sec-Fetch-Site %s is refused even with a matching Origin', (site) =>
    expect(post({ 'sec-fetch-site': site, origin: 'https://db.example.org' }).ok).toBe(false))
  it('applies to server functions and server routes alike, for every non-GET method', () => {
    for (const pathname of ['/_serverFn/browse.functions.getTables', '/api/rows/upload', '/api/io/upload', '/']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(evaluateGate(req({ method, pathname, headers: { origin: 'https://evil.example' } }), cfg()).ok).toBe(false)
        expect(evaluateGate(req({ method, pathname, headers: { origin: 'https://db.example.org' } }), cfg()).ok).toBe(true)
      }
    }
  })
  it('GET and HEAD are not origin checked', () => {
    expect(evaluateGate(req({ method: 'GET', headers: { origin: 'https://evil.example' } }), cfg()).ok).toBe(true)
    expect(evaluateGate(req({ method: 'HEAD' }), cfg()).ok).toBe(true)
  })
  it('without a configured origin the request scheme and Host decide', () => {
    const c = cfg({ publicOrigin: undefined, allowedHosts: ['localhost:3000'] })
    const r = (origin: string) => originAllowed(req({ method: 'POST', headers: { host: 'localhost:3000', origin } }), c, 'http')
    expect(r('http://localhost:3000')).toBe(true)
    expect(r('http://localhost:3001')).toBe(false)
    expect(r('https://localhost:3000')).toBe(false)
  })
})

describe('gate: helpers', () => {
  it('reads function names from build and dev ids', () => {
    expect(serverFunctionName('/_serverFn/auth.functions.passwordSignIn')).toBe('passwordSignIn')
    expect(serverFunctionName('/_serverFn/auth.functions.passwordSignIn_1')).toBe('passwordSignIn')
    const dev = Buffer.from(JSON.stringify({ file: '/@id/x', export: 'mfaVerify' })).toString('base64url')
    expect(serverFunctionName(`/_serverFn/${dev}`)).toBe('mfaVerify')
    expect(serverFunctionName('/api/x')).toBeUndefined()
  })
  it('credential detection is exact plus the setup prefix', () => {
    expect(isCredentialFunction('passwordSignIn')).toBe(true)
    expect(isCredentialFunction('setupComplete')).toBe(true)
    expect(isCredentialFunction('getTables')).toBe(false)
    expect(isCredentialFunction(undefined)).toBe(false)
  })
  it('classifies routes', () => {
    expect(routeClassOf('/_serverFn/a.b')).toBe('function')
    expect(routeClassOf('/api/health')).toBe('route')
    expect(routeClassOf('/assets/a.js')).toBe('asset')
    expect(routeClassOf('/setup')).toBe('page')
  })
})
