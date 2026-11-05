import { describe, expect, it } from 'vitest'
import { effectiveScheme } from '../src/server/net/origin'

const base = {
  trustedProxies: [],
  trustProxyLegacy: true,
  proxyHops: 0,
  allowedHosts: ['*'],
  originDerived: true,
}

describe('derived origin scheme', () => {
  it('takes the scheme from a trusted proxy', () => {
    const r = effectiveScheme(
      '172.18.0.2',
      new Headers({ 'x-forwarded-proto': 'https' }),
      base,
      'http',
    )
    expect(r).toMatchObject({ scheme: 'https', mismatch: false })
  })
  it('ignores the header from an untrusted peer', () => {
    const r = effectiveScheme(
      '8.8.8.8',
      new Headers({ 'x-forwarded-proto': 'https' }),
      base,
      'http',
    )
    expect(r).toMatchObject({ scheme: 'http', mismatch: false })
  })
  it('falls back to the request scheme without the header', () => {
    expect(effectiveScheme('172.18.0.2', new Headers(), base, 'http').scheme).toBe('http')
  })
  it('treats an IPv4-mapped IPv6 peer like its IPv4 address', () => {
    const r = effectiveScheme(
      '::ffff:172.17.0.1',
      new Headers({ 'x-forwarded-proto': 'https' }),
      base,
      'http',
    )
    expect(r.scheme).toBe('https')
  })
})
