import { describe, expect, it } from 'vitest'
import { applySecurityHeaders, hstsValue, type HeaderConfig } from '~/server/http/headers'

const https: HeaderConfig = {
  publicOrigin: 'https://db.example.org',
  hsts: { enabled: true, maxAgeSeconds: 31_536_000, includeSubDomains: false },
}
const http: HeaderConfig = { publicOrigin: 'http://localhost:3000', hsts: https.hsts }

describe('central response headers', () => {
  it('sets the fixed headers and HSTS on an https origin', () => {
    const h = new Headers({ 'content-type': 'text/html' })
    applySecurityHeaders(h, '/', https)
    expect(Object.fromEntries(h)).toMatchObject({
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'cache-control': 'no-store',
    })
  })

  it('includeSubDomains by config, never preload', () => {
    const v = hstsValue({ ...https, hsts: { enabled: true, maxAgeSeconds: 600, includeSubDomains: true } })
    expect(v).toBe('max-age=600; includeSubDomains')
    expect(v).not.toContain('preload')
  })

  it('no HSTS on an http origin, with no origin, or when off', () => {
    for (const c of [http, { hsts: https.hsts }, { ...https, hsts: { ...https.hsts, enabled: false } }]) {
      const h = new Headers({ 'strict-transport-security': 'max-age=1' })
      applySecurityHeaders(h, '/', c)
      expect(h.has('strict-transport-security')).toBe(false)
    }
  })

  it('removes Access-Control-* headers of any case', () => {
    const h = new Headers({ 'Access-Control-Allow-Origin': '*', 'access-control-allow-credentials': 'true' })
    applySecurityHeaders(h, '/api/x', https)
    expect([...h.keys()].some((k) => k.startsWith('access-control-'))).toBe(false)
  })

  it('keeps a Cache-Control set by a handler; hashed assets stay cacheable', () => {
    const own = new Headers({ 'cache-control': 'no-store, private' })
    applySecurityHeaders(own, '/_serverFn/x.y', https)
    expect(own.get('cache-control')).toBe('no-store, private')
    const asset = new Headers({ 'cache-control': 'public, max-age=31536000, immutable' })
    applySecurityHeaders(asset, '/assets/app-1.js', https)
    expect(asset.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const bare = new Headers()
    applySecurityHeaders(bare, '/assets/app-1.js', https)
    expect(bare.has('cache-control')).toBe(false)
  })

  it('overwrites a handler value for the fixed headers', () => {
    const h = new Headers({ 'x-content-type-options': 'sniff', 'referrer-policy': 'origin' })
    applySecurityHeaders(h, '/', https)
    expect(h.get('x-content-type-options')).toBe('nosniff')
    expect(h.get('referrer-policy')).toBe('no-referrer')
  })
})
