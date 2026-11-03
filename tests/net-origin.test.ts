import { describe, expect, it } from 'vitest'
import { effectiveScheme, isHostAllowed, isLoopbackHost, parsePublicOrigin, type OriginConfig } from '~/server/net/origin'
import { loadConfig } from '~/server/config'

const cfg = (over: Partial<OriginConfig> = {}): OriginConfig => ({
  trustedProxies: ['10.0.0.0/8'],
  trustProxyLegacy: false,
  proxyHops: 0,
  publicOrigin: 'https://db.example.org',
  allowedHosts: ['db.example.org'],
  ...over,
})
const proto = (v?: string) => new Headers(v ? { 'x-forwarded-proto': v } : {})

describe('parsePublicOrigin', () => {
  it.each([
    ['https://db.example.org', true],
    ['https://db.example.org:8443/', true],
    ['  https://db.example.org  ', true],
    ['http://localhost:3000', true],
    ['http://127.0.0.1:3000', true],
    ['http://[::1]:3000', true],
  ])('%s ok', (t, ok) => expect(parsePublicOrigin(t).ok).toBe(ok))

  it('http on a public host is insecure; garbage is invalid', () => {
    expect(parsePublicOrigin('http://db.example.org')).toEqual({ ok: false, reason: 'insecure' })
    for (const t of ['', undefined, 'db.example.org', 'ftp://x', 'https://x/path', 'https://x?q=1', 'https://x#f', 'https://u:p@x']) {
      expect(parsePublicOrigin(t)).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('normalises origin and host', () => {
    const r = parsePublicOrigin('HTTPS://DB.Example.org:443')
    expect(r.ok && r.value.origin).toBe('https://db.example.org')
    expect(r.ok && r.value.host).toBe('db.example.org')
  })

  it('config uses the same parser and messages', () => {
    expect(() => loadConfig({ DBLOOM_PUBLIC_ORIGIN: 'http://db.example.org' })).toThrow(/must use https/)
    expect(() => loadConfig({ DBLOOM_PUBLIC_ORIGIN: 'https://x/p' })).toThrow(/without path/)
    expect(loadConfig({ DBLOOM_PUBLIC_ORIGIN: 'https://DB.example.org' }).publicOrigin).toBe('https://db.example.org')
  })
})

describe('isLoopbackHost', () => {
  it.each([['localhost', true], ['127.0.0.5', true], ['::1', true], ['[::1]', true], ['0.0.0.0', false], ['::', false], ['10.0.0.1', false]])(
    '%s',
    (h, r) => expect(isLoopbackHost(h)).toBe(r),
  )
})

describe('effectiveScheme', () => {
  it('is the origin scheme, confirmed by a trusted proxy', () => {
    expect(effectiveScheme('10.0.0.1', proto('https'), cfg())).toEqual({ scheme: 'https', forwarded: 'https', mismatch: false })
  })
  it('a trusted proxy saying http while the origin is https is a mismatch, scheme stays https', () => {
    expect(effectiveScheme('10.0.0.1', proto('http'), cfg())).toEqual({ scheme: 'https', forwarded: 'http', mismatch: true })
  })
  it('untrusted peer: header ignored', () => {
    expect(effectiveScheme('203.0.113.9', proto('http'), cfg())).toEqual({ scheme: 'https', mismatch: false })
  })
  it('never upgrades an http origin', () => {
    const c = cfg({ publicOrigin: 'http://localhost:3000' })
    expect(effectiveScheme('10.0.0.1', proto('https'), c).scheme).toBe('http')
  })
  it('rightmost value counts; garbage ignored', () => {
    expect(effectiveScheme('10.0.0.1', proto('http, https'), cfg()).mismatch).toBe(false)
    expect(effectiveScheme('10.0.0.1', proto('https, http'), cfg()).mismatch).toBe(true)
    expect(effectiveScheme('10.0.0.1', proto('gopher'), cfg())).toEqual({ scheme: 'https', mismatch: false })
  })
  it('without an origin: fallback, no mismatch', () => {
    const c = cfg({ publicOrigin: undefined })
    expect(effectiveScheme('10.0.0.1', proto('https'), c, 'http')).toEqual({ scheme: 'http', forwarded: 'https', mismatch: false })
  })
})

describe('isHostAllowed', () => {
  it('exact, case and trailing dot', () => {
    expect(isHostAllowed('db.example.org', cfg())).toBe(true)
    expect(isHostAllowed('DB.Example.org', cfg())).toBe(true)
    expect(isHostAllowed('db.example.org.', cfg())).toBe(true)
  })
  it('refuses others, ports not listed and malformed values', () => {
    for (const h of ['evil.org', 'db.example.org:8443', 'db.example.org.evil.org', 'x@db.example.org', '', undefined, null, 'db.example.org/x']) {
      expect(isHostAllowed(h, cfg())).toBe(false)
    }
  })
  it('port entries', () => {
    expect(isHostAllowed('localhost:3000', { allowedHosts: ['localhost:3000'] })).toBe(true)
    expect(isHostAllowed('localhost', { allowedHosts: ['localhost:3000'] })).toBe(false)
  })
  it('wildcards: subdomains only, apex excluded', () => {
    const c = { allowedHosts: ['*.example.org'] }
    expect(isHostAllowed('a.example.org', c)).toBe(true)
    expect(isHostAllowed('a.b.example.org', c)).toBe(true)
    expect(isHostAllowed('example.org', c)).toBe(false)
    expect(isHostAllowed('evilexample.org', c)).toBe(false)
    expect(isHostAllowed('anything', { allowedHosts: ['*'] })).toBe(true)
  })
})
